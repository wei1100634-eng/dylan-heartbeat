function buildContext({ state = null, knowledge = null, dailyLife = null, events = [], tasks = [] } = {}) {
  const lines = ["当前状态："];
  if (state) {
    lines.push(`时间：${state.current_time || "未知"}`);
    lines.push(`工作阶段：${state.onboarding_phase || "未知"}`);
    lines.push(`工作：${state.work_state || "未知"} / ${state.activity || "未知"}`);
  }
  const knownKeys = new Set((knowledge?.facts || []).map(fact => fact.fact_key));
  const today = state?.current_date || state?.current_time?.slice(0, 10) || null;
  const todayEvents = buildTodayContext({ dailyLife, date: today });
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

function buildTodayContext({ dailyLife = null, date = null } = {}) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const events = (dailyLife?.events || []).filter(event => event.date === date && event.summary);
  if (!events.length) return "";
  return ["## 今日经历", ...events.slice(-3).map(event => `- ${event.summary}`)].join("\n");
}

function buildCurrentSelfStateContext({ state = null, currentTime = "未知" } = {}) {
  const workStateLabels = { LUNCH: "午休", ON_DUTY: "工作中", OFF_DUTY: "下班", LEAVE: "请假" };
  const lines = ["## 当前状态", `- 工作状态：${workStateLabels[state?.work_state] || state?.work_state || "未知"}`];
  lines.push(`- 当前活动：${state?.activity || "未知"}`);
  lines.push(`- 位置：${state?.location || "未知"}`);
  if (Array.isArray(state?.with) && state.with.length) lines.push(`- 同行：${state.with.join("、")}`);
  lines.push(`- 当前阶段：${state?.onboarding_phase || "未知"}`);
  lines.push(`- 当前时间：${currentTime}`);
  return lines.join("\n");
}

module.exports = { buildContext, buildCurrentSelfStateContext, buildTodayContext };
