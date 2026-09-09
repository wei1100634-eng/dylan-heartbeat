const fs = require("fs");
const path = require("path");
const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");
const { formatDateTimeInTimeZone, getDatePartsInTimeZone, resolveTimeZone } = require("../time_utils");
const { getScheduleState } = require("./shane_work");
const { loadDailyLife, isDailyLifeEventVisible } = require("./daily_life");
const { loadLeaves, isOnApprovedLeave } = require("./leaves");
const { loadKnowledge } = require("./knowledge");

const TIME_ZONE = resolveTimeZone();
const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const STATE_PATH = path.join(WORK_DIR, "state.json");
const SYNC_CURSOR_PATH = path.join(WORK_DIR, "work_sync_cursor.json");

function buildContext({ state = null, knowledge = null, dailyLife = null, events = [], tasks = [] } = {}) {
  const lines = ["当前状态："];
  if (state) {
    lines.push(`时间：${state.current_time || "未知"}`);
    lines.push(`工作阶段：${state.onboarding_phase || "未知"}`);
    lines.push(`工作：${state.work_state || "未知"} / ${state.activity || "未知"}`);
  }
  const knownKeys = new Set((knowledge?.facts || []).map(fact => fact.fact_key));
  const today = state?.current_date || state?.current_time?.slice(0, 10) || null;
  const contextNow = state?.current_time ? new Date(state.current_time) : null;
  const todayEvents = buildTodayContext({ dailyLife, date: today, now: contextNow });
  if (todayEvents) lines.push(todayEvents);
  const knownDaily = (dailyLife?.events || []).filter(event => knownKeys.has(`LIFE:${event.event_id}`));
  if (knownDaily.length) {
    lines.push("生活：");
    for (const event of knownDaily.slice(-3)) lines.push(`- ${event.summary}`);
  }
  const knownWork = (knowledge?.facts || []).filter(fact => ["EVENT", "TASK"].includes(fact.subject_type)).slice(-3);
  if (knownWork.length) {
    lines.push("已知工作事实：");
    for (const fact of knownWork) {
      const snapshot = fact.known_snapshot || {};
      lines.push(`- ${fact.fact_key}：${snapshot.status || snapshot.category || "已知"}`);
    }
  }
  return lines.join("\n");
}

function buildTodayContext({ dailyLife = null, date = null, now = null } = {}) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const events = (dailyLife?.events || []).filter(event => event.date === date && event.summary && (!now || isDailyLifeEventVisible(event, now)));
  if (!events.length) return "";
  return ["## 今日经历", ...events.slice(-3).map(event => `- ${event.summary}`)].join("\n");
}

function localInfo(now = new Date()) {
  const parts = getDatePartsInTimeZone(now, TIME_ZONE);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return { parts, minutes, date: `${parts.year}-${parts.month}-${parts.day}` };
}

function getEffectiveCurrentState({ state = null, now = new Date(), isOnLeave = false } = {}) {
  if (!state) return null;
  const session = state.work_session;
  if (session && ["OVERTIME", "CALL_OUT"].includes(session.type)) {
    return { ...state, work_state: session.type === "OVERTIME" ? "OVERTIME" : "CALLED_OUT" };
  }
  const schedule = getScheduleState(now, isOnLeave);
  if (schedule.workState === state.work_state) return { ...state, is_workday: schedule.isWorkday, is_on_leave: Boolean(schedule.isOnLeave) };
  const safeDisplay = schedule.workState === "OFF_DUTY"
    ? { activity: "off_duty", location: "OFF_SITE", with: [], current_equipment_id: null }
    : schedule.workState === "LUNCH"
      ? { activity: "lunch_break", location: null, with: [], current_equipment_id: null }
      : { activity: null, location: null, with: [], current_equipment_id: null };
  return { ...state, ...safeDisplay, is_workday: schedule.isWorkday, is_on_leave: Boolean(schedule.isOnLeave), work_state: schedule.workState };
}

function workStateLabel(state, now = new Date()) {
  if (!state) return "未知";
  if (state.work_state === "LEAVE") return "请假";
  if (state.work_state === "OVERTIME") return "加班中";
  if (state.work_state === "CALLED_OUT") return "被召回工作中";
  if (state.work_state === "LUNCH") return "午休";
  if (state.work_state === "ON_DUTY") return "工作中";
  const { minutes } = localInfo(now);
  if (!state.is_workday) return "今日非工作日";
  return minutes < 510 ? "尚未上班" : "已下班";
}

const TASK_LABELS = {
  PLANNED_INSPECTION: "例行检查",
  PREVENTIVE_MAINTENANCE: "预防性维护",
  RECHECK: "复查",
  HANDOFF_TASK: "交接事项",
  TOOLS_AND_PARTS: "工具与备件整理",
  EQUIPMENT_LEARNING: "设备熟悉",
  ASSIST_COWORKER: "协助同事"
};

const EVENT_LABELS = {
  SENSOR_CHECK: "传感器检查",
  CONVEYOR_ALIGNMENT: "输送带调整",
  LIGHT_JAM: "轻微卡料处理",
  PUMP_OR_PNEUMATIC_CHECK: "泵或气动检查",
  OPERATOR_REPORT: "设备异常确认",
  OFF_HOURS_CRITICAL: "关键温控辅助系统处理"
};

function factTime(fact) {
  return String(fact?.last_known_at || fact?.learned_at || "");
}

function completedFactTime(fact) {
  const snapshot = fact?.known_snapshot || {};
  return String(snapshot.completed_at || snapshot.resolved_at || factTime(fact));
}

function knownWorkFacts(knowledge) {
  return (knowledge?.facts || [])
    .filter(fact => ["TASK", "EVENT"].includes(fact.subject_type) && fact.known_snapshot)
    .sort((left, right) => factTime(right).localeCompare(factTime(left)));
}

function describeKnownFact(fact, kind) {
  const snapshot = fact.known_snapshot || {};
  const equipment = snapshot.equipment_id ? `${snapshot.equipment_id} ` : "";
  const label = fact.subject_type === "TASK"
    ? (TASK_LABELS[snapshot.category] || snapshot.category || "工作事项")
    : (EVENT_LABELS[snapshot.category] || snapshot.category || "设备事项");
  if (kind === "completed") return fact.subject_type === "TASK" ? `${equipment}${label}已完成` : `${equipment}${label}已处理完成`;
  if (snapshot.status === "DEFERRED") return `${equipment}${label}待继续`;
  if (snapshot.status === "WAITING_PARTS") return `${equipment}${label}等待零件`;
  if (snapshot.status === "TEMP_FIXED") return `${equipment}${label}已临时处理，待复查`;
  if (snapshot.status === "RECHECK") return `${equipment}${label}待复查`;
  return `${equipment}${label}已安排`;
}

function buildKnownWorkProgressContext(knowledge = null) {
  const facts = knownWorkFacts(knowledge);
  const completed = facts
    .filter(fact => ["DONE", "RESOLVED"].includes(fact.known_snapshot.status))
    .sort((left, right) => completedFactTime(right).localeCompare(completedFactTime(left)))[0];
  const upcoming = facts.find(fact => (
    (fact.subject_type === "TASK" && ["PLANNED", "DEFERRED"].includes(fact.known_snapshot.status)) ||
    (fact.subject_type === "EVENT" && ["WAITING_PARTS", "TEMP_FIXED", "RECHECK"].includes(fact.known_snapshot.status))
  ));
  return {
    recent: completed ? describeKnownFact(completed, "completed") : "暂无",
    upcoming: upcoming ? describeKnownFact(upcoming, "upcoming") : "暂无"
  };
}

function buildCurrentSelfStateContext({ state = null, knowledge = null, currentTime = "未知", now = new Date() } = {}) {
  const lines = ["## 当前状态", `- 工作状态：${workStateLabel(state, now)}`];
  if (state?.activity) lines.push(`- 当前活动：${state.activity}`);
  if (state?.location) lines.push(`- 位置：${state.location}`);
  if (Array.isArray(state?.with) && state.with.length) lines.push(`- 同行：${state.with.join("、")}`);
  lines.push(`- 当前阶段：${state?.onboarding_phase || "未知"}`);
  lines.push(`- 当前时间：${currentTime}`);
  const progress = buildKnownWorkProgressContext(knowledge);
  lines.push(`- 最近完成：${progress.recent}`);
  lines.push(`- 已确定后续：${progress.upcoming}`);
  if (state?.on_call && state.work_state !== "CALLED_OUT") lines.push("- 值班轮值：是（当前未被召回）");
  return lines.join("\n");
}

function buildShiftBoundaryContext({ state = null, now = new Date() } = {}) {
  if (!state) return "";
  const { minutes } = localInfo(now);
  const lines = ["## 当前时间边界"];
  if (state.work_state === "LEAVE") return `${lines[0]}\n- 今日请假，不进入正常班次。`;
  if (state.work_state === "OVERTIME" || state.work_state === "CALLED_OUT") {
    lines.push(state.work_state === "OVERTIME" ? "- 当前处于加班工作。" : "- 当前处于召回工作。没有进入普通下班状态。");
    if (state.work_session?.deadline_at) lines.push(`- 安全截止：${state.work_session.deadline_at}`);
    return lines.join("\n");
  }
  if (!state.is_workday) return `${lines[0]}\n- 今日非工作日。`;
  if (minutes < 510) {
    lines.push("- 下一班次开始：08:30", `- 距离上班：${510 - minutes}分钟`, "- 可以准备，但不得描述为已经开始正式工作。");
  } else if (minutes < 720) {
    lines.push("- 当前班次结束：12:00", `- 距离午休：${720 - minutes}分钟`, "- 班次结束前不得描述为已经下班或已经离厂。");
  } else if (minutes < 870) {
    lines.push("- 下午班开始：14:30", `- 距离下午上班：${870 - minutes}分钟`);
  } else if (minutes < 1050) {
    lines.push("- 当前班次结束：17:30", `- 距离正常下班：${1050 - minutes}分钟`, "- 班次结束前不得描述为已经下班或已经离厂。");
  } else {
    lines.push("- 正常班次已结束。");
  }
  return lines.join("\n");
}

function compactShiftBoundary({ state = null, now = new Date() } = {}) {
  const section = buildShiftBoundaryContext({ state, now });
  if (!section) return "";
  return section.replace(/^## 当前时间边界\n?/, "").trim();
}

function loadWorkSyncCursor() {
  if (!fs.existsSync(SYNC_CURSOR_PATH)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(SYNC_CURSOR_PATH, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch (error) {
    console.error("读取 Shane Work 同步游标失败:", error.message);
    return null;
  }
}

function stateSyncSignature(state, now) {
  const { minutes, date } = localInfo(now);
  const boundary = !state?.is_workday ? "NON_WORKDAY"
    : state?.work_state === "LEAVE" ? "LEAVE"
      : state?.work_state === "OVERTIME" ? "OVERTIME"
        : state?.work_state === "CALLED_OUT" ? "CALLED_OUT"
          : minutes < 510 ? "BEFORE_SHIFT"
            : minutes < 720 ? "MORNING"
              : minutes < 870 ? "LUNCH"
                : minutes < 1050 ? "AFTERNOON"
                  : "OFF_DUTY";
  return JSON.stringify({
    date,
    boundary,
    work_state: state?.work_state || null,
    activity: state?.activity || null,
    location: state?.location || null,
    with: state?.with || [],
    equipment: state?.current_equipment_id || null,
    onboarding_phase: state?.onboarding_phase || null,
    on_call: Boolean(state?.on_call),
    session: state?.work_session?.session_id || null
  });
}

function timestampAfter(value, cursorTime) {
  if (!value) return false;
  if (!cursorTime) return true;
  const left = Date.parse(value);
  const right = Date.parse(cursorTime);
  return Number.isFinite(left) && Number.isFinite(right) ? left > right : String(value) > String(cursorTime);
}

function describeRecentKnownFact(fact) {
  const snapshot = fact.known_snapshot || {};
  const equipment = snapshot.equipment_id ? `${snapshot.equipment_id} ` : "";
  const label = fact.subject_type === "TASK"
    ? (TASK_LABELS[snapshot.category] || snapshot.category || "工作事项")
    : (EVENT_LABELS[snapshot.category] || snapshot.category || "设备事项");
  if (fact.subject_type === "TASK") {
    if (snapshot.status === "DONE") return `${equipment}${label}完成`;
    if (snapshot.status === "DEFERRED") return `${equipment}${label}暂缓，待继续`;
    return `开始${equipment}${label}`;
  }
  if (snapshot.status === "RESOLVED") return `${equipment}${label}处理完成`;
  if (snapshot.status === "WAITING_PARTS") return `${equipment}${label}等待零件`;
  if (snapshot.status === "TEMP_FIXED") return `${equipment}${label}已临时处理`;
  if (snapshot.status === "RECHECK") return `${equipment}${label}进入复查`;
  if (snapshot.status === "REPAIRING") return `正在处理${equipment}${label}`;
  return `开始检查${equipment}${label}`;
}

function describeStateChange(state, now) {
  if (state.work_state === "LEAVE") return "今日进入请假状态";
  if (state.work_state === "OVERTIME") return "进入加班工作";
  if (state.work_state === "CALLED_OUT") return "被召回处理工作事项";
  if (!state.is_workday) return "今日为非工作日";
  const { minutes } = localInfo(now);
  if (minutes < 510) return "目前尚未进入正式工作时段";
  if (minutes < 720) return "已进入上午工作时段";
  if (minutes < 870) return "已进入午休";
  if (minutes < 1050) return "已恢复下午工作";
  return "正常班次已结束";
}

function buildWorkSyncNote({ state = null, knowledge = null, dailyLife = null, now = new Date(), isOnLeave = false, cursor = null, force = false } = {}) {
  const effective = getEffectiveCurrentState({ state, now, isOnLeave });
  if (!effective) return { context: "", cursor: null };
  const signature = stateSyncSignature(effective, now);
  const firstSync = !cursor?.last_synced_at;
  const cursorTime = cursor?.last_synced_at || null;
  const recent = [];
  if (!firstSync) {
    for (const fact of knownWorkFacts(knowledge)) {
      const at = factTime(fact);
      if (timestampAfter(at, cursorTime)) recent.push({ at, text: describeRecentKnownFact(fact) });
    }
    const { date } = localInfo(now);
    for (const event of (dailyLife?.events || [])) {
      const at = event.occurred_at || event.created_at;
      if (event.date === date && isDailyLifeEventVisible(event, now) && timestampAfter(at, cursorTime)) recent.push({ at, text: event.summary });
    }
    if (cursor?.state_signature !== signature) recent.push({ at: now.toISOString(), text: describeStateChange(effective, now) });
  }
  recent.sort((left, right) => String(left.at).localeCompare(String(right.at)));
  const recentLines = recent.slice(-3).map(item => item.text);
  const shouldSync = force || firstSync || recentLines.length > 0;
  if (!shouldSync) return { context: "", cursor: null };

  const progress = buildKnownWorkProgressContext(knowledge);
  const nowLines = [`- 当前工作状态：${workStateLabel(effective, now)}`, `- 当前阶段：${effective.onboarding_phase || "未知"}`];
  // 午休只提供客观时间边界；不把后台的普通午休 activity 强加为模型当前行为。
  if (effective.work_state !== "LUNCH") {
    if (effective.activity) nowLines.push(`- 当前活动：${effective.activity}`);
    if (effective.location) nowLines.push(`- 位置：${effective.location}`);
  }
  const boundary = compactShiftBoundary({ state: effective, now });
  const lines = ["【工作同步】", "近期："];
  if (recentLines.length) lines.push(...recentLines.map(item => `- ${item}`));
  else lines.push("- 当前工作状态已同步。");
  lines.push("现在：", ...nowLines, "后续：", `- ${progress.upcoming}`);
  if (boundary) lines.push("班次边界：", ...boundary.split("\n").map(item => `- ${item.replace(/^-\s*/, "")}`));
  return {
    context: lines.join("\n"),
    cursor: { schema_version: 1, state_signature: signature }
  };
}

function prepareWorkSyncContext(now = new Date(), { force = false } = {}) {
  try {
    if (!fs.existsSync(STATE_PATH)) return { context: "", cursor: null };
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    const { date } = localInfo(now);
    return buildWorkSyncNote({
      state,
      knowledge: loadKnowledge(),
      dailyLife: loadDailyLife(),
      now,
      isOnLeave: isOnApprovedLeave(loadLeaves(), date),
      cursor: loadWorkSyncCursor(),
      force
    });
  } catch (error) {
    console.error("构建 Shane Work 同步纸条失败:", error.message);
    return { context: "", cursor: null };
  }
}

function markWorkSyncDelivered(cursor, now = new Date()) {
  if (!cursor) return;
  fs.mkdirSync(WORK_DIR, { recursive: true });
  writeJsonAtomicSync(SYNC_CURSOR_PATH, { ...cursor, last_synced_at: now.toISOString() });
}

function buildCurrentWorkContext({ state = null, knowledge = null, dailyLife = null, now = new Date(), isOnLeave = false } = {}) {
  const effective = getEffectiveCurrentState({ state, now, isOnLeave });
  if (!effective) return "";
  const { date } = localInfo(now);
  const sections = [
    buildCurrentSelfStateContext({ state: effective, knowledge, currentTime: formatDateTimeInTimeZone(now, TIME_ZONE), now }),
    buildShiftBoundaryContext({ state: effective, now }),
    buildTodayContext({ dailyLife, date, now })
  ].filter(Boolean);
  return ["## 当前工作上下文", ...sections].join("\n\n");
}

function loadCurrentWorkContext(now = new Date()) {
  try {
    if (!fs.existsSync(STATE_PATH)) return "";
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    const { date } = localInfo(now);
    return buildCurrentWorkContext({ state, knowledge: loadKnowledge(), dailyLife: loadDailyLife(), now, isOnLeave: isOnApprovedLeave(loadLeaves(), date) });
  } catch (error) {
    console.error("读取 Shane 当前工作上下文失败:", error.message);
    return "";
  }
}

function insertTransientCurrentWorkContext(messages, context) {
  const clean = (messages || []).filter(message => !(message?.role === "system" && /^(## 当前工作上下文|【工作同步】)/.test(String(message.content || ""))));
  if (!context) return [...clean];
  const index = clean.map(message => message.role).lastIndexOf("user");
  const target = index >= 0 ? index : clean.length;
  const result = [...clean];
  result.splice(target, 0, { role: "system", content: context });
  return result;
}

module.exports = {
  buildContext,
  buildCurrentSelfStateContext,
  buildKnownWorkProgressContext,
  buildWorkSyncNote,
  buildCurrentWorkContext,
  buildShiftBoundaryContext,
  buildTodayContext,
  getEffectiveCurrentState,
  insertTransientCurrentWorkContext,
  loadCurrentWorkContext,
  loadWorkSyncCursor,
  markWorkSyncDelivered,
  prepareWorkSyncContext
};
