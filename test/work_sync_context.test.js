const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "work-sync-context-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";

const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");
const {
  prepareWorkSyncContext,
  markWorkSyncDelivered,
  insertTransientCurrentWorkContext
} = require("../shane_work/context_builder");

const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const paths = {
  state: path.join(WORK_DIR, "state.json"),
  knowledge: path.join(WORK_DIR, "knowledge.json"),
  daily: path.join(WORK_DIR, "daily_life.json"),
  events: path.join(WORK_DIR, "events.json"),
  tasks: path.join(WORK_DIR, "tasks.json"),
  wake: path.join(WORK_DIR, "wake_requests.json"),
  hours: path.join(WORK_DIR, "work_hours.json")
};

function at(time) { return new Date(`2026-09-14T${time}:00+08:00`); }
function reset() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  writeJsonAtomicSync(paths.state, {
    work_state: "ON_DUTY", activity: "inspection", location: "A区", with: [], current_equipment_id: "A02",
    onboarding_phase: "NORMAL", is_workday: true, on_call: false, work_session: null
  });
  writeJsonAtomicSync(paths.knowledge, { schema_version: 1, facts: [] });
  writeJsonAtomicSync(paths.daily, { schema_version: 1, events: [] });
  writeJsonAtomicSync(paths.events, [{ event_id: "WORLD-UNKNOWN", category: "SECRET_WORLD_EVENT" }]);
  writeJsonAtomicSync(paths.tasks, [{ task_id: "WORLD-UNKNOWN-TASK" }]);
  writeJsonAtomicSync(paths.wake, { schema_version: 1, requests: [] });
  writeJsonAtomicSync(paths.hours, [{ record_id: "KEEP-HOURS" }]);
}
function update(file, value) { writeJsonAtomicSync(file, value); }
function snapshotFiles() { return new Map(Object.values(paths).map(file => [file, fs.readFileSync(file, "utf8")])); }
function assertFilesUnchanged(before) { for (const [file, text] of before) assert.equal(fs.readFileSync(file, "utf8"), text); }

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test("首次消息注入当前工作同步，连续无变化消息不重复", () => {
  reset();
  const first = prepareWorkSyncContext(at("09:00"));
  assert.match(first.context, /^【工作同步】/);
  assert.match(first.context, /当前工作状态：工作中/);
  markWorkSyncDelivered(first.cursor, at("09:00"));
  const second = prepareWorkSyncContext(at("09:05"));
  assert.equal(second.context, "");
});

test("Shane 已知的新 task/event 最多三条进入近期，未知世界事件不会进入", () => {
  reset();
  const initial = prepareWorkSyncContext(at("09:00"));
  markWorkSyncDelivered(initial.cursor, at("09:00"));
  update(paths.knowledge, {
    schema_version: 1,
    facts: [
      { fact_key: "TASK:TASK-1", subject_type: "TASK", last_known_at: "2026-09-14T09:10:00+08:00", known_snapshot: { equipment_id: "A02", category: "PLANNED_INSPECTION", status: "DONE", completed_at: "2026-09-14T09:10:00+08:00" } },
      { fact_key: "EVENT:EVT-2", subject_type: "EVENT", last_known_at: "2026-09-14T09:20:00+08:00", known_snapshot: { equipment_id: "B02", category: "SENSOR_CHECK", status: "REPAIRING" } },
      { fact_key: "TASK:TASK-3", subject_type: "TASK", last_known_at: "2026-09-14T09:25:00+08:00", known_snapshot: { equipment_id: "C01", category: "HANDOFF_TASK", status: "DEFERRED" } },
      { fact_key: "TASK:TASK-4", subject_type: "TASK", last_known_at: "2026-09-14T09:30:00+08:00", known_snapshot: { equipment_id: "D01", category: "TOOLS_AND_PARTS", status: "DONE", completed_at: "2026-09-14T09:30:00+08:00" } }
    ]
  });
  const sync = prepareWorkSyncContext(at("09:35"));
  assert.match(sync.context, /D01 工具与备件整理完成/);
  assert.match(sync.context, /C01 交接事项暂缓，待继续/);
  assert.match(sync.context, /正在处理B02 传感器检查/);
  assert.doesNotMatch(sync.context, /A02 例行检查完成/);
  assert.doesNotMatch(sync.context, /SECRET_WORLD_EVENT|WORLD-UNKNOWN/);
});

test("已发生 Daily Life 可同步，未来 Daily Life 不可见", () => {
  reset();
  const initial = prepareWorkSyncContext(at("09:00"));
  markWorkSyncDelivered(initial.cursor, at("09:00"));
  update(paths.daily, { schema_version: 1, events: [
    { event_id: "LIFE-1", date: "2026-09-14", category: "BREAK", summary: "上午有一次短暂休息。", occurred_at: "2026-09-14T10:00:00+08:00" },
    { event_id: "LIFE-FUTURE", date: "2026-09-14", category: "LUNCH", summary: "未来午餐不应出现。", occurred_at: "2026-09-14T12:00:00+08:00" }
  ] });
  const sync = prepareWorkSyncContext(at("10:30"));
  assert.match(sync.context, /上午有一次短暂休息/);
  assert.doesNotMatch(sync.context, /未来午餐/);
});

test("跨班次边界会同步，午休无真实事件时不规定具体生活行为", () => {
  reset();
  const morning = prepareWorkSyncContext(at("11:59"));
  markWorkSyncDelivered(morning.cursor, at("11:59"));
  const lunch = prepareWorkSyncContext(at("12:00"));
  assert.match(lunch.context, /已进入午休[\s\S]*当前工作状态：午休[\s\S]*下午班开始：14:30/);
  assert.doesNotMatch(lunch.context, /resting|eating|chatting|reading_manual|BREAK_ROOM|CAFETERIA/);
});

test("同步纸条为 transient，读取不改 Work、Knowledge、Wake 或工时文件", () => {
  reset();
  const before = snapshotFiles();
  const sync = prepareWorkSyncContext(at("09:00"));
  assert.match(sync.context, /【工作同步】/);
  assertFilesUnchanged(before);
  const messages = [{ role: "system", content: "人格" }, { role: "user", content: "你好" }];
  const forWake = insertTransientCurrentWorkContext(messages, sync.context);
  const forKelivo = insertTransientCurrentWorkContext(messages, sync.context);
  assert.deepEqual(forWake, forKelivo);
  assert.equal(messages.length, 2);
});
