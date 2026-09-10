const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shane-location-awareness-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";
const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");
const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const STATE_PATH = path.join(WORK_DIR, "state.json");
const { tick } = require("../shane_work/shane_work");
const { loadKnowledge } = require("../shane_work/knowledge");

function seedCompletedDay2() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.rmSync(path.join(WORK_DIR, "knowledge.json"), { force: true });
  writeJsonAtomicSync(STATE_PATH, {
    schema_version: 6,
    employment_started_at: "2026-09-08T08:30:00+08:00",
    onboarding_day: 2,
    onboarding_phase: "GUIDED",
    work_day_started_date: "2026-09-09",
    work_state: "OFF_DUTY",
    activity: "off_duty",
    location: "OFF_SITE",
    with: [],
    known_npc_ids: ["george_nelson", "erin_walker"],
    onboarding_session: {
      session_id: "SHANE-ONBOARDING-2026-09-08", status: "COMPLETED", active: false,
      history: [
        "ONBOARDING_DAY1_REPORT", "MEET_ERIN_AND_GEORGE", "LUNCH_DAY1", "FACTORY_ORIENTATION",
        "BASIC_WORK_TRAINING", "DAY1_REVIEW", "DAY1_COMPLETED", "DAY2_START", "SHADOW_GEORGE",
        "LUNCH_DAY2", "FIRST_PRACTICAL_TASK", "ONBOARDING_REVIEW", "ONBOARDING_COMPLETED"
      ].map(step_id => ({ step_id, occurred_at: "2026-09-09T17:00:00+08:00" }))
    },
    equipment: []
  });
  writeJsonAtomicSync(path.join(WORK_DIR, "events.json"), []);
  writeJsonAtomicSync(path.join(WORK_DIR, "tasks.json"), { schema_version: 1, tasks: [] });
}

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test("旧 Day2 存档恢复已接触地点，但不自动获得 BREAK_ROOM", () => {
  seedCompletedDay2();
  const state = tick(new Date("2026-09-09T12:30:00+08:00"));
  assert.deepEqual(state.known_location_ids.sort(), ["CAFETERIA", "FACTORY_FLOOR", "MAINTENANCE_ROOM", "OFF_SITE", "SAFETY_EXIT", "WAREHOUSE"]);
  assert.notEqual(state.location, "BREAK_ROOM");
  assert.equal(state.onboarding_phase, "GUIDED");
});

test("Day3 首次午休由 George 带领认识 BREAK_ROOM，并持久化个人设施", () => {
  seedCompletedDay2();
  tick(new Date("2026-09-09T12:30:00+08:00"));
  const state = tick(new Date("2026-09-10T12:30:00+08:00"));
  assert.ok(state.known_location_ids.includes("BREAK_ROOM"));
  assert.deepEqual(state.personal_facilities, { rest_bed_id: "SHANE_BED_04", locker_id: "SHANE_LOCKER_04" });
  assert.equal(state.location, "BREAK_ROOM");
  assert.equal(state.activity, "chatting");
  assert.deepEqual(state.with, ["george_nelson"]);
  assert.equal(state.onboarding_phase, "NORMAL");
});

test("BREAK_ROOM 认知在重复 tick 后保持稳定且不创建新认知文件", () => {
  seedCompletedDay2();
  tick(new Date("2026-09-10T12:30:00+08:00"));
  const first = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  const second = tick(new Date("2026-09-10T12:45:00+08:00"));
  assert.deepEqual(second.known_location_ids, first.known_location_ids);
  assert.deepEqual(second.personal_facilities, first.personal_facilities);
  assert.equal(fs.existsSync(path.join(WORK_DIR, "location_knowledge.json")), false);
});

test("首次认识 BREAK_ROOM 只建立一条窄地点认知事实", () => {
  seedCompletedDay2();
  tick(new Date("2026-09-10T12:30:00+08:00"));
  const facts = loadKnowledge().facts.filter(fact => fact.fact_key === "LOCATION_DISCOVERED:BREAK_ROOM");
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0].known_snapshot, { location_id: "BREAK_ROOM", label: "厂内休息室" });
  assert.doesNotMatch(JSON.stringify(facts[0]), /SHANE_BED_04|SHANE_LOCKER_04|personal_facilities/);

  tick(new Date("2026-09-10T12:45:00+08:00"));
  assert.equal(loadKnowledge().facts.filter(fact => fact.fact_key === "LOCATION_DISCOVERED:BREAK_ROOM").length, 1);
});

test("已有 BREAK_ROOM 的旧状态只补建一次地点认知事实", () => {
  seedCompletedDay2();
  const prior = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  prior.known_location_ids = ["CAFETERIA", "FACTORY_FLOOR", "MAINTENANCE_ROOM", "OFF_SITE", "BREAK_ROOM"];
  prior.personal_facilities = { rest_bed_id: "SHANE_BED_04", locker_id: "SHANE_LOCKER_04" };
  writeJsonAtomicSync(STATE_PATH, prior);

  tick(new Date("2026-09-10T10:00:00+08:00"));
  let facts = loadKnowledge().facts.filter(fact => fact.fact_key === "LOCATION_DISCOVERED:BREAK_ROOM");
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0].known_snapshot, { location_id: "BREAK_ROOM", label: "厂内休息室" });

  tick(new Date("2026-09-10T10:30:00+08:00"));
  facts = loadKnowledge().facts.filter(fact => fact.fact_key === "LOCATION_DISCOVERED:BREAK_ROOM");
  assert.equal(facts.length, 1);
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  assert.ok(state.known_location_ids.includes("BREAK_ROOM"));
  assert.deepEqual(state.personal_facilities, prior.personal_facilities);
});
test("已完成 onboarding 的旧状态补齐基础厂区认知，但不自动获得 BREAK_ROOM", () => {
  seedCompletedDay2();
  const state = tick(new Date("2026-09-10T10:00:00+08:00"));
  for (const locationId of ["FACTORY_FLOOR", "MAINTENANCE_ROOM", "WAREHOUSE", "SAFETY_EXIT"]) {
    assert.ok(state.known_location_ids.includes(locationId));
  }
  assert.equal(state.known_location_ids.includes("BREAK_ROOM"), false);
  assert.equal(state.onboarding_session.status, "COMPLETED");
  const facts = loadKnowledge().facts.filter(fact => fact.fact_key === "ONBOARDING:CORE_FACILITY_AWARENESS");
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0].known_snapshot, { label: "生产区域、维修间、仓库、安全出口及主要设备区域的基本划分" });

  tick(new Date("2026-09-10T10:30:00+08:00"));
  assert.equal(loadKnowledge().facts.filter(fact => fact.fact_key === "ONBOARDING:CORE_FACILITY_AWARENESS").length, 1);
});
