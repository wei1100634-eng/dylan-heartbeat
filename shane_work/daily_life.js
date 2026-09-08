const fs = require("fs");
const path = require("path");
const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");
const { getDatePartsInTimeZone, resolveTimeZone } = require("../time_utils");

const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const FILE = path.join(WORK_DIR, "daily_life.json");
const TIME_ZONE = resolveTimeZone();

const DEFINITIONS = [
  { category: "LUNCH", probability: 22, cooldownDays: 2, summary: "午餐时段有一顿正常的员工餐。", weekdaysOnly: true },
  { category: "BREAK", seedKey: "COMMUTE_HOME", probability: 18, cooldownDays: 3, summary: "工厂工作时段出现了一次正常的短暂休息。", weekdaysOnly: true },
  { category: "WEATHER_CHANGE", probability: 10, cooldownDays: 2, summary: "当天出现了轻微天气变化。", weekdaysOnly: false },
  { category: "COWORKER_ENCOUNTER", probability: 14, cooldownDays: 2, summary: "在日常活动中偶遇一位同事。", weekdaysOnly: true },
  { category: "SMALL_INCIDENT", probability: 4, cooldownDays: 5, summary: "发生了一件很小的日常插曲。", weekdaysOnly: true }
];

function emptyStore() { return { schema_version: 1, events: [] }; }
function loadDailyLife() {
  if (!fs.existsSync(FILE)) return emptyStore();
  try {
    const value = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return value && Array.isArray(value.events) ? { schema_version: 1, events: value.events } : emptyStore();
  } catch (error) {
    console.error("Daily Life 读取 daily_life.json 失败:", error.message);
    return emptyStore();
  }
}
function saveDailyLife(store) { fs.mkdirSync(WORK_DIR, { recursive: true }); writeJsonAtomicSync(FILE, store); }
function dateKey(now) {
  const parts = getDatePartsInTimeZone(now, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function weekday(date) { return new Date(`${date}T00:00:00Z`).getUTCDay(); }
function hashText(value) { let hash = 0; for (const char of String(value)) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0; return hash; }
function dayDistance(left, right) { return Math.round((Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86400000); }

function isCoolingDown(events, definition, date) {
  return events.some(event => event.category === definition.category && dayDistance(event.date, date) < definition.cooldownDays);
}

function ticksDailyLife(now = new Date(), state = null) {
  const date = dateKey(now);
  const store = loadDailyLife();
  if (store.events.some(event => event.date === date)) return { date, events: store.events.filter(event => event.date === date), changed: false };
  const day = weekday(date);
  const created = [];
  for (const definition of DEFINITIONS) {
    if (definition.weekdaysOnly && (day === 0 || day === 6)) continue;
    if (isCoolingDown(store.events, definition, date)) continue;
    if (hashText(`${date}|daily-life|${definition.seedKey || definition.category}`) % 100 >= definition.probability) continue;
    created.push({
      event_id: `LIFE-${date.replace(/-/g, "")}-${String(created.length + 1).padStart(3, "0")}`,
      date,
      category: definition.category,
      importance: "LOW",
      summary: definition.summary,
      created_at: now.toISOString()
    });
  }
  if (created.length) {
    store.events.push(...created);
    saveDailyLife(store);
  }
  return { date, events: created, changed: created.length > 0 };
}

module.exports = { ticksDailyLife, loadDailyLife, saveDailyLife, dateKey, DEFINITIONS };
