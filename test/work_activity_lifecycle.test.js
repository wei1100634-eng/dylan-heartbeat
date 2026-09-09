const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "work-activity-lifecycle-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";

const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");
const { tick } = require("../shane_work/shane_work");
const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const STATE_PATH = path.join(WORK_DIR, "state.json");

function at(time) { return new Date(`2026-09-10T${time}:00+08:00`); }
function reset() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  writeJsonAtomicSync(STATE_PATH, {
    employment_started_at: "2026-09-08T08:30:00+08:00",
    work_state: "ON_DUTY",
    activity: "waiting",
    location: "MAINTENANCE_ROOM",
    with: [],
    current_equipment_id: null,
    activity_ends_at: null,
    activity_index: 1,
    onboarding_session: { session_id: "SHANE-ONBOARDING-2026-09-08", status: "COMPLETED", active: false, history: [] },
    event_schedule: { sequence: 0, next_candidate_date: "2099-01-01" },
    task_schedule: { sequence: 0, next_candidate_date: "2099-01-01" },
    known_npc_ids: [],
    known_location_ids: ["MAINTENANCE_ROOM"],
    personal_facilities: null,
    equipment: []
  });
  writeJsonAtomicSync(path.join(WORK_DIR, "events.json"), []);
  writeJsonAtomicSync(path.join(WORK_DIR, "tasks.json"), []);
  writeJsonAtomicSync(path.join(WORK_DIR, "knowledge.json"), { schema_version: 1, facts: [] });
  writeJsonAtomicSync(path.join(WORK_DIR, "wake_requests.json"), { schema_version: 1, requests: [] });
}

function runSample(index) {
  reset();
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  state.activity_index = index;
  writeJsonAtomicSync(STATE_PATH, state);
  const started = tick(at("09:00"));
  return (new Date(started.activity_ends_at).getTime() - at("09:00").getTime()) / 60_000;
}

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test("普通 inspection 在开始时确定 30–120 分钟持续时间，后续 tick 和重载前保持不变", () => {
  reset();
  const started = tick(at("09:00"));
  assert.equal(started.activity, "inspection");
  const endsAt = started.activity_ends_at;
  const duration = (new Date(endsAt).getTime() - at("09:00").getTime()) / 60_000;
  assert.ok(duration >= 30 && duration <= 120);

  const middle = tick(at("09:30"));
  assert.equal(middle.activity, "inspection");
  assert.equal(middle.activity_ends_at, endsAt);

  delete require.cache[require.resolve("../shane_work/shane_work")];
  const reloaded = require("../shane_work/shane_work").tick(at("09:45"));
  assert.equal(reloaded.activity, "inspection");
  assert.equal(reloaded.activity_ends_at, endsAt);
});

test("普通自由 activity 使用确定性 30–120 分钟范围，而非固定三档", () => {
  const durations = [0, 1, 2, 3, 4, 5, 6, 7].map(runSample);
  for (const duration of durations) assert.ok(duration >= 30 && duration <= 120);
  assert.ok(new Set(durations).size > 3);
  assert.ok(durations.some(duration => ![30, 60, 90].includes(duration)));
});
