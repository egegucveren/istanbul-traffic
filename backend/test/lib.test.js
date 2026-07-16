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

test("computeIndex falls back to plain mean of increasePct when durations are missing", () => {
  const { index, avgIncreasePct } = computeIndex([
    { name: "a", increasePct: 10 },
    { name: "b", increasePct: 20 },
  ]);
  assert.equal(avgIncreasePct, 15);
  assert.equal(index, 15);
});

test("computeIndex is duration-weighted when normalSec/inTrafficSec are present", () => {
  // 45 dk'lık koridor %50 yavaşlamış, 5 dk'lık tünel akıcı: düz ortalama %25
  // derdi; süre-ağırlıklı gerçek: (4050+300)/(2700+300)-1 = %45.
  const { index } = computeIndex([
    { name: "E5", increasePct: 50, normalSec: 2700, inTrafficSec: 4050 },
    { name: "Tünel", increasePct: 0, normalSec: 300, inTrafficSec: 300 },
  ]);
  assert.equal(index, 45);
});

test("computeIndex ignores errored routes", () => {
  const { index } = computeIndex([
    { name: "a", increasePct: 10 },
    { name: "b", error: "timeout" },
  ]);
  assert.equal(index, 10);
});

test("computeIndex clamps into [0, 100] and floors 'faster than typical' at 0", () => {
  assert.equal(computeIndex([{ name: "a", increasePct: 500 }]).index, 100);
  assert.equal(computeIndex([{ name: "a", increasePct: -50 }]).index, 0);
  // Süre-ağırlıklı yolda da: trafik tipikten hızlıysa negatife düşmek yerine 0.
  assert.equal(
    computeIndex([{ name: "a", increasePct: -20, normalSec: 1000, inTrafficSec: 800 }]).index,
    0
  );
});

test("computeIndex returns a human-readable level", () => {
  assert.equal(computeIndex([{ name: "a", increasePct: 5 }]).level, "Akıcı");
  assert.equal(computeIndex([{ name: "a", increasePct: 15 }]).level, "Hafif");
  assert.equal(computeIndex([{ name: "a", increasePct: 30 }]).level, "Orta");
  assert.equal(computeIndex([{ name: "a", increasePct: 55 }]).level, "Yoğun");
  assert.equal(computeIndex([{ name: "a", increasePct: 90 }]).level, "Çok yoğun");
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
    [{ title: "Beşiktaş - Eyüpspor", venue: "Vodafone Park", lat: 41.0391, lng: 29.0006, start: "2026-08-16T15:00:00Z", end: "2026-08-16T17:00:00Z" }],
    origin,
    origin,
    new Date("2026-08-16T14:00:00Z") // maça 1 saat kala — giriş penceresi
  );
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /Ağu/); // Turkish short month abbreviation shows up in the date stamp
});

// ---------- Etkinlik zaman fazları: sadece giriş/çıkış pencerelerinde uyar ----------

test("computeEventFactor stays silent hours before the event (no 5-hours-early warnings)", () => {
  const origin = { lat: 41.0391, lng: 29.0006 }; // Vodafone Park'ın dibi
  const ev = { title: "Konser", venue: "Vodafone Park", lat: 41.0391, lng: 29.0006, start: "2026-08-16T20:00:00Z", end: "2026-08-16T23:00:00Z" };

  // 5 saat önce: sıfır etki, sıfır uyarı — mekanın dibinden geçiliyor olsa bile.
  const early = computeEventFactor([ev], origin, origin, new Date("2026-08-16T15:00:00Z"));
  assert.deepEqual(early, { multiplier: 1, reasons: [] });

  // 1 saat önce: giriş kalabalığı — tam etki.
  const arrival = computeEventFactor([ev], origin, origin, new Date("2026-08-16T19:00:00Z"));
  assert.equal(arrival.multiplier, 1.25);
  assert.match(arrival.reasons[0], /giriş saati/);

  // Gösteri ortası: hafif etki.
  const mid = computeEventFactor([ev], origin, origin, new Date("2026-08-16T21:30:00Z"));
  assert.ok(mid.multiplier > 1 && mid.multiplier < 1.25);
  assert.match(mid.reasons[0], /sürüyor/);

  // Bitişten 20 dk sonra: çıkış kalabalığı — tam etki.
  const exit = computeEventFactor([ev], origin, origin, new Date("2026-08-16T23:20:00Z"));
  assert.equal(exit.multiplier, 1.25);
  assert.match(exit.reasons[0], /çıkış saatine/);

  // 2 saat sonra: bitti, etki yok.
  const gone = computeEventFactor([ev], origin, origin, new Date("2026-08-17T01:00:00Z"));
  assert.deepEqual(gone, { multiplier: 1, reasons: [] });
});

test("computeEventFactor detects venues on the route path, not just at the endpoints", () => {
  // Uçlar mekandan uzak (~6+ km), ama rota Vodafone Park'ın dibinden geçiyor.
  const origin = { lat: 41.10, lng: 29.00 };
  const destination = { lat: 40.98, lng: 29.03 };
  const routePath = [
    { lat: 41.10, lng: 29.00 },
    { lat: 41.06, lng: 29.005 },
    { lat: 41.039, lng: 29.0006 }, // stadın dibi
    { lat: 41.00, lng: 29.02 },
    { lat: 40.98, lng: 29.03 },
  ];
  const ev = { title: "Maç", venue: "Vodafone Park", lat: 41.0391, lng: 29.0006, start: "2026-08-16T20:00:00Z", end: "2026-08-16T22:00:00Z" };
  const at = new Date("2026-08-16T19:00:00Z"); // giriş penceresi

  const withoutPath = computeEventFactor([ev], origin, destination, at);
  assert.equal(withoutPath.multiplier, 1); // uçlara bakınca uzak görünüyor

  const withPath = computeEventFactor([ev], origin, destination, at, routePath);
  assert.equal(withPath.multiplier, 1.25); // rota geometrisi yakalıyor
  assert.match(withPath.reasons[0], /rota üzerinde/);
});
