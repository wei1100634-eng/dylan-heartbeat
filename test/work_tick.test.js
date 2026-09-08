const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shane-work-tick-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";
process.env.TARGET_API_URL = "http://model.test/v1/chat/completions";
process.env.TARGET_API_KEY = "test-key";
process.env.MODEL_NAME = "test-model";

const originalModuleLoad = Module._load;
Module._load = function fixtureModuleLoad(request, parent, isMain) {
  if (request === "dotenv") return { config() {} };
  return originalModuleLoad.call(this, request, parent, isMain);
};
const { runtimeDirectory } = require("../runtime_paths");
const { WORK_TICK_INTERVAL_MS, isWorkTickWindow, runWorkTick, runWakeUp } = require("../wake_up");
Module._load = originalModuleLoad;
const TIMELINE = path.join(DATA_DIR, "enhanced_messages.json");
const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const originalFetch = global.fetch;

function reset() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.writeFileSync(TIMELINE, JSON.stringify([
    { role: "system", content: "人格提示" },
    { role: "user", content: "（2020-01-01 10:00）旧消息" }
  ]));
}

test.after(() => {
  global.fetch = originalFetch;
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test("Work Tick 仅在工作日 08:30–17:30 的本地时间窗口运行", () => {
  assert.equal(WORK_TICK_INTERVAL_MS, 30 * 60 * 1000);
  assert.equal(isWorkTickWindow(new Date("2026-09-07T08:29:00+08:00")), false);
  assert.equal(isWorkTickWindow(new Date("2026-09-07T08:30:00+08:00")), true);
  assert.equal(isWorkTickWindow(new Date("2026-09-07T17:29:00+08:00")), true);
  assert.equal(isWorkTickWindow(new Date("2026-09-07T17:30:00+08:00")), false);
  assert.equal(isWorkTickWindow(new Date("2026-09-12T10:00:00+08:00")), false);
});

test("没有 Work request 的 Work Tick 不调用模型或普通 wake", async () => {
  reset();
  let modelCalls = 0;
  global.fetch = async url => {
    if (String(url).includes("model.test")) modelCalls++;
    throw new Error(`unexpected fetch: ${url}`);
  };
  const result = await runWorkTick(new Date("2026-09-07T10:00:00+08:00"));
  assert.deepEqual(result, { ran: true, dispatched: false });
  assert.equal(modelCalls, 0);
});

test("并发 wake 只允许一次模型调用", async () => {
  reset();
  let modelCalls = 0;
  global.fetch = async url => {
    if (String(url).includes("model.test")) {
      modelCalls++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ choices: [{ message: { content: "[NO_ACTION] 测试" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("/internal/wake-event")) return new Response("{}", { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const [first, second] = await Promise.all([runWakeUp(), runWakeUp()]);
  assert.equal(modelCalls, 1);
  assert.deepEqual([first.outcome, second.outcome].sort(), ["NO_ACTION", "WAKE_IN_PROGRESS"]);
});
