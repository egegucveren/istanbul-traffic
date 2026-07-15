// backend/test/lib.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const { computeIndex, classifyVenue, isHolidayEvent, splitEvents } = require("../lib");

test("computeIndex averages increasePct and clamps to 1-99", () => {
  const { index, avgIncreasePct } = computeIndex([
    { name: "a", increasePct: 10 },
    { name: "b", increasePct: 20 },
  ]);
  assert.equal(avgIncreasePct, 15);
  assert.equal(index, 16); // round(1 + 15)
});

test("computeIndex ignores errored routes", () => {
  const { index } = computeIndex([
    { name: "a", increasePct: 10 },
    { name: "b", error: "timeout" },
  ]);
  assert.equal(index, 11); // round(1 + 10)
});

test("computeIndex clamps extreme values into [1, 99]", () => {
  assert.equal(computeIndex([{ name: "a", increasePct: 500 }]).index, 99);
  assert.equal(computeIndex([{ name: "a", increasePct: -50 }]).index, 1);
});

test("computeIndex throws when no usable routes", () => {
  assert.throws(() => computeIndex([{ name: "a", error: "boom" }]));
});

test("classifyVenue matches known Istanbul stadiums", () => {
  assert.equal(classifyVenue("Vodafone Park, İstanbul")?.name, "Vodafone Park");
  assert.equal(classifyVenue("Rams Park")?.name, "Rams Park");
  assert.equal(classifyVenue("Şükrü Saracoğlu Stadyumu")?.name, "Şükrü Saracoğlu Stadyumu");
});

test("classifyVenue returns null for away games / unknown venues", () => {
  assert.equal(classifyVenue("Ankara 19 Mayıs Stadyumu"), null);
  assert.equal(classifyVenue(""), null);
});

test("isHolidayEvent detects holiday-ish summaries", () => {
  assert.equal(isHolidayEvent("Ramazan Bayramı"), true);
  assert.equal(isHolidayEvent("Public Holiday"), true);
  assert.equal(isHolidayEvent("Galatasaray - Fenerbahçe"), false);
});

test("splitEvents buckets into active vs upcoming", () => {
  const now = new Date("2026-07-15T12:00:00+03:00");
  const events = [
    // starts 1h from now -> within 2h pre-buffer -> active
    { title: "soon", start: "2026-07-15T13:00:00+03:00", end: "2026-07-15T15:00:00+03:00" },
    // starts in 5 days -> upcoming
    { title: "later", start: "2026-07-20T13:00:00+03:00", end: "2026-07-20T15:00:00+03:00" },
    // ended 2h ago, outside post-buffer -> neither
    { title: "past", start: "2026-07-15T08:00:00+03:00", end: "2026-07-15T09:00:00+03:00" },
  ];
  const { active, upcoming } = splitEvents(events, now);
  assert.deepEqual(active.map((e) => e.title), ["soon"]);
  assert.deepEqual(upcoming.map((e) => e.title), ["later"]);
});
