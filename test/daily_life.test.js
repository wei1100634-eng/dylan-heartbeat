const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shane-daily-life-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";
const { runtimeDirectory } = require("../runtime_paths");
const { ticksDailyLife, loadDailyLife } = require("../shane_work/daily_life");
const { buildContext, buildTodayContext } = require("../shane_work/context_builder");
const FILE = path.join(runtimeDirectory("shane_work", "shane_work"), "daily_life.json");

function reset() { fs.rmSync(DATA_DIR, { recursive: true, force: true }); fs.mkdirSync(path.dirname(FILE), { recursive: true }); }
test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test("同一天重复 tick 不重复写入 Daily Life 事件", () => {
  reset();
  const now = new Date("2026-09-08T08:30:00+08:00");
  const first = ticksDailyLife(now, {});
  const before = fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : null;
  const second = ticksDailyLife(new Date("2026-09-08T15:00:00+08:00"), {});
  assert.equal(second.changed, false);
  assert.equal(second.events.length, first.events.length);
  assert.equal(fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : null, before);
});

test("重启重新加载后同一天结果一致，且没有事件日合法", () => {
  reset();
  const first = ticksDailyLife(new Date("2026-09-08T08:30:00+08:00"), {});
  delete require.cache[require.resolve("../shane_work/daily_life")];
  const reloaded = require("../shane_work/daily_life").ticksDailyLife(new Date("2026-09-08T15:00:00+08:00"), {});
  assert.deepEqual(reloaded.events, first.events);
  assert.ok(Array.isArray(loadDailyLife().events));
});

test("Daily Life 只进入独立存储，不自动进入窄 Context", () => {
  reset();
  const result = ticksDailyLife(new Date("2026-09-08T08:30:00+08:00"), {});
  const context = buildContext({ state: { current_date: "2026-09-09", current_time: "2026-09-09T08:30:00+08:00", onboarding_phase: "NORMAL", work_state: "ON_DUTY", activity: "waiting" }, dailyLife: { events: result.events }, knowledge: { facts: [] }, events: [], tasks: [] });
  assert.equal(context.includes("今日经历"), false);
  assert.equal(context.includes("生活："), false);
  assert.equal(fs.existsSync(path.join(DATA_DIR, "shane_work", "events.json")), false);
  assert.equal(fs.existsSync(path.join(DATA_DIR, "shane_work", "tasks.json")), false);
});

test("当天 Daily Life 可生成短期 Today Context，次日自动失效", () => {
  const dailyLife = { events: [
    { event_id: "LIFE-1", date: "2026-09-08", category: "LUNCH", summary: "午餐期间与George交流。", secret: "DO_NOT_LEAK" },
    { event_id: "LIFE-2", date: "2026-09-07", category: "BREAK", summary: "昨天的事件不应出现。" }
  ] };
  const today = buildTodayContext({ dailyLife, date: "2026-09-08" });
  assert.match(today, /## 今日经历/);
  assert.match(today, /午餐期间与George交流/);
  assert.doesNotMatch(today, /昨天的事件|DO_NOT_LEAK/);
  assert.equal(buildTodayContext({ dailyLife, date: "2026-09-09" }), "");
});

test("Today Context 不进入 Knowledge、不创建 Wake，也不读取 Work 数据", () => {
  const context = buildContext({
    state: { current_date: "2026-09-08", work_state: "ON_DUTY", activity: "waiting" },
    dailyLife: { events: [{ event_id: "LIFE-3", date: "2026-09-08", summary: "当天有一次短暂休息。" }] },
    knowledge: { facts: [] },
    events: [],
    tasks: []
  });
  assert.match(context, /今日经历/);
  assert.doesNotMatch(context, /events\.json|tasks\.json|wake_requests/);
});
