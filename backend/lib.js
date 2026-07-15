// backend/lib.js
// Pure, side-effect-free helpers extracted out of server.js so they're easy to unit test.

/**
 * Averages the traffic increase % across a set of route results and clamps
 * it into a 1-99 "index" score, the same way /api/index used to do it inline.
 * @param {{name: string, increasePct?: number, error?: string}[]} results
 */
function computeIndex(results) {
  const ok = results.filter((r) => !r.error && Number.isFinite(r.increasePct));
  if (!ok.length) throw new Error("No routes computed");

  const avgIncrease = ok.reduce((s, r) => s + r.increasePct, 0) / ok.length;
  let index = Math.round(Math.min(99, Math.max(1, 1 + avgIncrease)));
  if (!Number.isFinite(index)) index = 1;

  return { index, avgIncreasePct: Math.round(avgIncrease) };
}

// Known Istanbul event venues (verified against Wikipedia / official sites —
// see README for sources). Football stadiums also match on the team's own
// name, so we can recognize a home game from the home team in a
// "Home - Away" style SUMMARY line even when the feed sets no LOCATION at
// all (true of fixtur.es and most football .ics feeds). `key` is a stable
// slug used by manual events (see events.manual.json) to reference a venue
// without repeating its coordinates.
const ISTANBUL_VENUES = [
  { key: "vodafone-park", match: /vodafone park|tüpraş stadyumu|beşiktaş/i, name: "Vodafone Park", lat: 41.0391, lng: 29.0006 },
  { key: "rams-park", match: /rams park|türk telekom stadyumu|galatasaray/i, name: "Rams Park", lat: 41.1032, lng: 28.9989 },
  { key: "sukru-saracoglu", match: /şükrü saracoğlu|fenerbahçe/i, name: "Şükrü Saracoğlu Stadyumu", lat: 40.9877, lng: 29.0369 },
  { key: "ulker-sports-arena", match: /ülker sports arena|ülker spor arena/i, name: "Ülker Sports Arena", lat: 40.9931, lng: 29.1044 },
  { key: "sinan-erdem", match: /sinan erdem/i, name: "Sinan Erdem Spor Salonu", lat: 40.9886, lng: 28.8539 },
  { key: "zorlu-psm", match: /zorlu psm|zorlu performing arts|zorlu performans/i, name: "Zorlu PSM", lat: 41.0672, lng: 29.0173 },
  { key: "kucukciftlik-park", match: /küçükçiftlik/i, name: "KüçükÇiftlik Park", lat: 41.0470, lng: 28.9895 },
  { key: "crr", match: /cemal reşit rey|\bcrr\b/i, name: "Cemal Reşit Rey Konser Salonu", lat: 41.0481, lng: 28.9900 },
  { key: "harbiye-acikhava", match: /harbiye.*açıkhava|cemil topuzlu/i, name: "Harbiye Cemil Topuzlu Açıkhava Tiyatrosu", lat: 41.0478, lng: 28.9897 },
  { key: "akm", match: /atatürk kültür merkezi|\bakm\b/i, name: "Atatürk Kültür Merkezi", lat: 41.0374, lng: 28.9853 },
  { key: "tuyap", match: /tüyap/i, name: "TÜYAP Fuar ve Kongre Merkezi", lat: 41.0065, lng: 28.6414 },
];

/**
 * Matches free text (an ICS LOCATION field, or a home-team name) against
 * known Istanbul venues. Returns the venue descriptor or null (e.g. an away
 * game, or an unrelated team).
 */
function classifyVenue(locationText = "") {
  return ISTANBUL_VENUES.find((v) => v.match.test(locationText)) || null;
}

/**
 * Most football .ics feeds (fixtur.es included) format SUMMARY as
 * "Home Team - Away Team" and never set LOCATION at all. This pulls out the
 * home team name so classifyVenue() can still work off SUMMARY alone.
 */
function homeTeamFromSummary(summary = "") {
  const [home] = summary.split(/\s+-\s+/);
  return (home || "").trim();
}

/** Rough heuristic for "this VEVENT is a public holiday" entries in the TR holiday feed. */
function isHolidayEvent(summary = "") {
  return /tatil|holiday|bayram/i.test(summary);
}

/**
 * Splits a flat list of {title, lat, lng, start, end, venue} events into
 * "active now" (within a pre/post buffer) vs "upcoming" (starts in the future).
 * @param {{start: string, end: string}[]} events
 * @param {Date} now
 * @param {number} preMs buffer before start still counted as active (default 2h)
 * @param {number} postMs buffer after end still counted as active (default 1h)
 */
function splitEvents(events, now = new Date(), preMs = 2 * 60 * 60 * 1000, postMs = 60 * 60 * 1000) {
  const active = [];
  const upcoming = [];
  for (const ev of events) {
    const start = new Date(ev.start);
    const end = new Date(ev.end);
    const pre = new Date(start.getTime() - preMs);
    const post = new Date(end.getTime() + postMs);
    const item = { ...ev, startISO: ev.start, endISO: ev.end };
    if (now >= pre && now <= post) active.push(item);
    else if (start > now) upcoming.push(item);
  }
  return { active, upcoming };
}

/**
 * Great-circle distance between two {lat,lng} points, in kilometers.
 */
function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Turns an /api/weather-shaped response into a duration multiplier + a
 * human-readable reason. Heavier / more likely rain pushes the multiplier
 * up, since wet roads are one of the biggest real-world traffic multipliers
 * in Istanbul.
 *
 * Supports two shapes for backward/forward compatibility:
 *  - legacy `next3h.{probability,rain}` arrays with no timestamps — treated
 *    as "the next few hours from now", used as-is (old behavior).
 *  - multi-day `hourly.{time,probability,rain}` arrays with real ISO
 *    timestamps — filtered to a ±2h window around `targetDate`, so a future
 *    trip only reacts to the forecast for *that* time, not right now.
 * If neither has data covering `targetDate` the function falls back to the
 * max over whatever it has, so it never silently returns "no rain".
 * @param {object} weather
 * @param {Date} [targetDate] when the trip is happening (defaults to now)
 */
function computeWeatherFactor(weather, targetDate = new Date()) {
  if (!weather) return { multiplier: 1, reasons: [] };

  const hourly = weather.hourly;
  let probs, rains;

  if (hourly?.time?.length) {
    const windowMs = 2 * 60 * 60 * 1000;
    const idx = hourly.time
      .map((t, i) => ({ i, diff: Math.abs(new Date(t).getTime() - targetDate.getTime()) }))
      .filter((x) => x.diff <= windowMs)
      .map((x) => x.i);
    if (idx.length) {
      probs = idx.map((i) => hourly.probability?.[i]);
      rains = idx.map((i) => hourly.rain?.[i]);
    } else {
      // targetDate falls outside the forecast window we fetched — fall back
      // to the whole series rather than silently assuming calm weather.
      probs = hourly.probability || [];
      rains = hourly.rain || [];
    }
  } else {
    probs = weather.next3h?.probability || [];
    rains = weather.next3h?.rain || [];
  }

  const maxProb = probs.length ? Math.max(...probs.filter((p) => Number.isFinite(p)), 0) : 0;
  const maxRain = rains.length ? Math.max(...rains.filter((r) => Number.isFinite(r)), 0) : 0;

  // "Is it raining right now" only makes sense when targetDate ~= now.
  const isNow = Math.abs(targetDate.getTime() - Date.now()) < 30 * 60 * 1000;
  const rainingNow = isNow && (weather.current?.precipitation || 0) > 0;

  let multiplier = 1;
  const reasons = [];

  if (maxProb >= 70 || maxRain >= 4) {
    multiplier = 1.25;
    reasons.push("Kuvvetli yağış bekleniyor");
  } else if (maxProb >= 40 || maxRain >= 1) {
    multiplier = 1.12;
    reasons.push("Yağış ihtimali var");
  }

  if (rainingNow) {
    multiplier *= 1.08;
    reasons.push("Şu anda yağış var");
  }

  return { multiplier, reasons };
}

/** Formats an ISO date as e.g. "16 Ağu 14:00" (Europe/Istanbul, short form for reasons). */
function formatShortDateTR(iso) {
  try {
    return new Date(iso).toLocaleString("tr-TR", {
      timeZone: "Europe/Istanbul",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Turns a list of "active" events (already pre/post-buffered around the
 * queried time, see splitEvents) into a duration multiplier + reasons, based
 * on how close each event's venue is to the given origin/destination. Events
 * without coordinates (city-wide public holidays) get a small flat discount
 * instead, since Istanbul traffic is typically lighter on official holidays.
 * Reasons are date-stamped so they still make sense for a future trip, not
 * just "right now".
 * @param {{title:string, lat:number|null, lng:number|null, venue:string, start?:string}[]} activeEvents
 */
function computeEventFactor(activeEvents, origin, destination) {
  if (!activeEvents || !activeEvents.length) return { multiplier: 1, reasons: [] };

  let multiplier = 1;
  const reasons = [];

  for (const ev of activeEvents) {
    const when = ev.start ? formatShortDateTR(ev.start) : null;
    const whenPrefix = when ? `${when} — ` : "";

    if (ev.lat == null || ev.lng == null) {
      // City-wide (e.g. public holiday) — mild reduction, only applied once.
      multiplier *= 0.95;
      reasons.push(`${whenPrefix}${ev.title}: trafik genel olarak daha sakin olabilir`);
      continue;
    }

    const point = { lat: ev.lat, lng: ev.lng };
    const distances = [origin, destination]
      .filter(Boolean)
      .map((p) => haversineKm(p, point));
    if (!distances.length) continue;
    const minDist = Math.min(...distances);

    if (minDist <= 1.5) {
      multiplier *= 1.25;
      reasons.push(`${whenPrefix}${ev.title} (${ev.venue}) çok yakın — yoğun trafik bekleniyor`);
    } else if (minDist <= 3) {
      multiplier *= 1.12;
      reasons.push(`${whenPrefix}${ev.title} (${ev.venue}) yakınında olası yoğunluk`);
    }
  }

  return { multiplier, reasons };
}

/**
 * Combines weather + nearby events into a single "expected" duration,
 * starting from the live traffic-based duration (nowMin). Different travel
 * modes are affected differently: driving feels the full effect, transit a
 * reduced one, walking only reacts to weather (crowd/road congestion barely
 * slows a pedestrian down, heavy rain does). `activeEvents` should already be
 * scoped to whatever time is being queried (see splitEvents(events, when)),
 * so this works the same whether "when" is right now or a future trip.
 * @param {number} nowMin live traffic-based duration in minutes
 * @param {"driving"|"transit"|"walking"} mode
 * @param {Date} [targetDate] when the trip is happening (defaults to now)
 */
function computeExpectedMinutes(nowMin, mode, weather, activeEvents, origin, destination, targetDate = new Date()) {
  if (nowMin == null) return { expectedMin: null, reasons: [] };

  const weatherFx = computeWeatherFactor(weather, targetDate);
  const eventFx = mode === "walking"
    ? { multiplier: 1, reasons: [] }
    : computeEventFactor(activeEvents, origin, destination);

  const modeWeight = mode === "driving" ? 1 : mode === "transit" ? 0.5 : 0.3;
  const combinedMultiplier = 1 + (weatherFx.multiplier * eventFx.multiplier - 1) * modeWeight;
  const clamped = Math.min(1.6, Math.max(0.85, combinedMultiplier));

  const expectedMin = Math.round(nowMin * clamped);
  return {
    expectedMin,
    multiplier: clamped,
    reasons: [...weatherFx.reasons, ...eventFx.reasons],
  };
}

module.exports = {
  computeIndex,
  classifyVenue,
  homeTeamFromSummary,
  isHolidayEvent,
  splitEvents,
  ISTANBUL_VENUES,
  haversineKm,
  computeWeatherFactor,
  computeEventFactor,
  computeExpectedMinutes,
  formatShortDateTR,
};
