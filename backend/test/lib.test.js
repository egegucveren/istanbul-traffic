// backend/test/lib.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeIndex,
  classifyVenue,
  homeTeamFromSummary,
  isHolidayEvent,
  splitEvents,
  haversineKm,
  computeWeatherFactor,
  computeEventFactor,
  computeExpectedMinutes,
} = require("../lib");

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

// ---------- Beklenen süre (hava + etkinlik) ----------

test("haversineKm returns ~0 for the same point and a sane value for a known offset", () => {
  assert.ok(haversineKm({ lat: 41.0, lng: 29.0 }, { lat: 41.0, lng: 29.0 }) < 0.001);
  // 1 degree of latitude is ~111km
  const d = haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  assert.ok(d > 110 && d < 112);
});

test("computeWeatherFactor is neutral with no data or calm forecast", () => {
  assert.deepEqual(computeWeatherFactor(null), { multiplier: 1, reasons: [] });
  const calm = computeWeatherFactor({ current: { precipitation: 0 }, next3h: { probability: [10, 5], rain: [0, 0] } });
  assert.equal(calm.multiplier, 1);
  assert.deepEqual(calm.reasons, []);
});

test("computeWeatherFactor escalates with rain probability and current rain", () => {
  const moderate = computeWeatherFactor({ current: { precipitation: 0 }, next3h: { probability: [50], rain: [0] } });
  assert.equal(moderate.multiplier, 1.12);

  const heavy = computeWeatherFactor({ current: { precipitation: 0 }, next3h: { probability: [80], rain: [5] } });
  assert.equal(heavy.multiplier, 1.25);

  const heavyAndRainingNow = computeWeatherFactor({ current: { precipitation: 2 }, next3h: { probability: [80], rain: [5] } });
  assert.ok(Math.abs(heavyAndRainingNow.multiplier - 1.25 * 1.08) < 1e-9);
  assert.equal(heavyAndRainingNow.reasons.length, 2);
});

test("computeEventFactor scales with proximity and discounts city-wide holidays", () => {
  const origin = { lat: 41.0391, lng: 29.0006 }; // Vodafone Park itself

  const none = computeEventFactor([], origin, origin);
  assert.deepEqual(none, { multiplier: 1, reasons: [] });

  const close = computeEventFactor(
    [{ title: "Beşiktaş Maçı", venue: "Vodafone Park", lat: 41.0391, lng: 29.0006 }],
    origin,
    origin
  );
  assert.equal(close.multiplier, 1.25);

  const far = computeEventFactor(
    [{ title: "Uzak Etkinlik", venue: "Uzak Yer", lat: 41.5, lng: 29.5 }],
    origin,
    origin
  );
  assert.equal(far.multiplier, 1);

  const holiday = computeEventFactor(
    [{ title: "Resmi Tatil", venue: "İstanbul geneli (resmi tatil)", lat: null, lng: null }],
    origin,
    origin
  );
  assert.equal(holiday.multiplier, 0.95);
});

test("computeExpectedMinutes passes through null when there's no base duration", () => {
  assert.deepEqual(computeExpectedMinutes(null, "driving", null, [], null, null), { expectedMin: null, reasons: [] });
});

test("computeExpectedMinutes weighs driving > transit > walking for the same conditions", () => {
  const weather = { current: { precipitation: 2 }, next3h: { probability: [80], rain: [5] } };
  const origin = { lat: 41.0391, lng: 29.0006 };
  const events = [{ title: "Maç", venue: "Vodafone Park", lat: 41.0391, lng: 29.0006 }];

  const driving = computeExpectedMinutes(100, "driving", weather, events, origin, origin);
  const transit = computeExpectedMinutes(100, "transit", weather, events, origin, origin);
  const walking = computeExpectedMinutes(100, "walking", weather, events, origin, origin);

  assert.ok(driving.expectedMin > transit.expectedMin);
  assert.ok(transit.expectedMin > walking.expectedMin);
  // Walking ignores events entirely — only weather-driven reasons should appear.
  assert.ok(!walking.reasons.some((r) => r.includes("Maç")));
  assert.ok(driving.reasons.some((r) => r.includes("Maç")));
});

test("computeExpectedMinutes clamps extreme combined multipliers", () => {
  const weather = { current: { precipitation: 5 }, next3h: { probability: [100], rain: [10] } };
  const origin = { lat: 41.0391, lng: 29.0006 };
  const events = [{ title: "Dev Maç", venue: "Vodafone Park", lat: 41.0391, lng: 29.0006 }];
  const { expectedMin, multiplier } = computeExpectedMinutes(100, "driving", weather, events, origin, origin);
  assert.ok(multiplier <= 1.6);
  assert.equal(expectedMin, Math.round(100 * multiplier));
});

// ---------- homeTeamFromSummary / classifyVenue via SUMMARY ----------

test("homeTeamFromSummary pulls the home team out of 'Home - Away' text", () => {
  assert.equal(homeTeamFromSummary("Beşiktaş - Alanyaspor"), "Beşiktaş");
  assert.equal(homeTeamFromSummary("Galatasaray - Fenerbahçe (4-1)"), "Galatasaray");
  assert.equal(homeTeamFromSummary(""), "");
});

test("classifyVenue matches a home team name pulled from SUMMARY (no LOCATION needed)", () => {
  // Most football .ics feeds (fixtur.es included) never set LOCATION at all.
  const home = homeTeamFromSummary("Beşiktaş - Alanyaspor");
  assert.equal(classifyVenue(home)?.name, "Vodafone Park");

  const away = homeTeamFromSummary("Alanyaspor - Beşiktaş"); // Beşiktaş deplasmanda
  assert.equal(classifyVenue(away), null);
});

// ---------- Future-dated trips: weather windowing around an arbitrary time ----------

test("computeWeatherFactor windows a multi-day hourly forecast around targetDate", () => {
  const hourly = {
    time: ["2026-08-20T10:00:00Z", "2026-08-20T14:00:00Z", "2026-08-21T14:00:00Z"],
    probability: [10, 80, 10],
    rain: [0, 5, 0],
  };
  // Right around the 14:00 slot on the 20th -> should pick up the 80%/heavy entry.
  const nearRain = computeWeatherFactor({ current: { precipitation: 0 }, hourly }, new Date("2026-08-20T13:30:00Z"));
  assert.equal(nearRain.multiplier, 1.25);

  // A day later at the same hour but the calm 10% entry is nearest -> no rain reasons.
  const nearCalm = computeWeatherFactor({ current: { precipitation: 0 }, hourly }, new Date("2026-08-21T14:00:00Z"));
  assert.equal(nearCalm.multiplier, 1);
});

test("computeWeatherFactor ignores 'raining right now' when targetDate is in the future", () => {
  const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const { reasons } = computeWeatherFactor({ current: { precipitation: 5 }, next3h: { probability: [0], rain: [0] } }, future);
  assert.ok(!reasons.some((r) => r.includes("Şu anda")));
});

test("computeEventFactor reasons are date-stamped so they still make sense for a future trip", () => {
  const origin = { lat: 41.0391, lng: 29.0006 };
  const { reasons } = computeEventFactor(
    [{ title: "Beşiktaş - Eyüpspor", venue: "Vodafone Park", lat: 41.0391, lng: 29.0006, start: "2026-08-16T15:00:00Z" }],
    origin,
    origin
  );
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /Ağu/); // Turkish short month abbreviation shows up in the date stamp
});
