const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shane-npc-awareness-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";

const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");
const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const STATE_PATH = path.join(WORK_DIR, "state.json");
const { tick } = require("../shane_work/shane_work");
const { loadKnowledge } = require("../shane_work/knowledge");
const { buildBaselineAwarenessContext, prepareWorkSyncContext, markWorkSyncDelivered } = require("../shane_work/context_builder");

function write(file, value) { writeJsonAtomicSync(file, value); }
function completedHistory() {
  return ["ONBOARDING_DAY1_REPORT", "MEET_ERIN_AND_GEORGE", "LUNCH_DAY1", "FACTORY_ORIENTATION", "BASIC_WORK_TRAINING", "DAY1_REVIEW", "DAY1_COMPLETED", "DAY2_START", "SHADOW_GEORGE", "LUNCH_DAY2", "FIRST_PRACTICAL_TASK", "ONBOARDING_REVIEW", "ONBOARDING_COMPLETED"].map(step_id => ({ step_id, occurred_at: "2026-09-09T17:00:00+08:00" }));
}
function seed({ known = [], session = null, tasks = [] } = {}) {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  write(STATE_PATH, {
    schema_version: 6, employment_started_at: "2026-09-08T08:30:00+08:00", company: "星果食品有限公司", role: "设备维修技师",
    work_state: "OFF_DUTY", activity: "off_duty", location: "OFF_SITE", with: [], known_npc_ids: known,
    onboarding_session: session, equipment: [], event_schedule: { sequence: 0, next_candidate_date: "2099-01-01" },
    task_schedule: { sequence: 0, next_candidate_date: "2099-01-01" }
  });
  write(path.join(WORK_DIR, "events.json"), []);
  write(path.join(WORK_DIR, "tasks.json"), { schema_version: 1, tasks });
  write(path.join(WORK_DIR, "knowledge.json"), { schema_version: 1, facts: [] });
}
function baseline(state) { return buildBaselineAwarenessContext({ state, knowledge: loadKnowledge() }); }

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test("Day1 实际会议明确认识 George 与 Erin，并建立稳定窄认知", () => {
  seed();
  const state = tick(new Date("2026-09-08T11:30:00+08:00"));
  assert.deepEqual(state.known_npc_ids.sort(), ["erin_walker", "george_nelson"]);
  const facts = loadKnowledge().facts;
  assert.ok(facts.some(fact => fact.fact_key === "NPC_KNOWN:george_nelson"));
  assert.ok(facts.some(fact => fact.fact_key === "NPC_KNOWN:erin_walker"));
  assert.match(baseline(state), /George Nelson（设备维修技师，入职阶段带教）/);
  assert.match(baseline(state), /Erin Walker（维修与设施主管）/);
});

test("Day3 首个正常工作 tick 确定性认识 Miguel，且重启与重复 tick 不重放", () => {
  seed({ known: ["george_nelson", "erin_walker"], session: { session_id: "SHANE-ONBOARDING-2026-09-08", status: "COMPLETED", active: false, history: completedHistory() } });
  const first = tick(new Date("2026-09-10T09:00:00+08:00"));
  assert.ok(first.known_npc_ids.includes("miguel_santos"));
  assert.equal(loadKnowledge().facts.filter(fact => fact.fact_key === "NPC_KNOWN:miguel_santos").length, 1);
  const second = tick(new Date("2026-09-10T09:00:00+08:00"));
  assert.equal(second.known_npc_ids.filter(id => id === "miguel_santos").length, 1);
  assert.equal(loadKnowledge().facts.filter(fact => fact.fact_key === "NPC_KNOWN:miguel_santos").length, 1);
  assert.match(baseline(second), /Miguel Santos（设备维修技师，维修同事）/);
});

test("后台预分配不会提前认识 NPC；任务实际进入 ACTIVE 后才建立共同处理认知", () => {
  const task = { task_id: "TASK-000001", category: "ASSIST_COWORKER", equipment_id: "A02", zone: "A区", assigned_by: null, assigned_with: ["miguel_santos"], created_at: "2026-09-10T08:00:00+08:00", due_date: "2026-09-10", status: "PLANNED", started_at: null, completed_at: null, deferred_at: null, activity_ends_at: null, source_event_id: null };
  seed({ session: { session_id: "SHANE-ONBOARDING-2026-09-08", status: "COMPLETED", active: false, history: completedHistory() }, tasks: [task] });
  const prework = tick(new Date("2026-09-10T08:20:00+08:00"));
  assert.ok(!prework.known_npc_ids.includes("miguel_santos"));
  assert.equal(loadKnowledge().facts.some(fact => fact.fact_key === "NPC_KNOWN:miguel_santos"), false);
  const active = tick(new Date("2026-09-10T09:00:00+08:00"));
  assert.ok(active.known_npc_ids.includes("miguel_santos"));
});

test("Noah 仅在 registry 中不会成为已知同事，也不会进入 baseline 或 cursor 后的同步", () => {
  seed({ known: ["george_nelson"], session: { session_id: "SHANE-ONBOARDING-2026-09-08", status: "COMPLETED", active: false, history: completedHistory() } });
  const state = tick(new Date("2026-09-10T08:20:00+08:00"));
  assert.ok(!state.known_npc_ids.includes("noah_holmes"));
  assert.equal(loadKnowledge().facts.some(fact => fact.fact_key === "NPC_KNOWN:noah_holmes"), false);
  assert.doesNotMatch(baseline(state), /Noah/);
  const sync = prepareWorkSyncContext(new Date("2026-09-10T09:00:00+08:00"));
  markWorkSyncDelivered(sync.cursor, new Date("2026-09-10T09:00:00+08:00"));
  assert.doesNotMatch(baseline(state), /Noah/);
});
