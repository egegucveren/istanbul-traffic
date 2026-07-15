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

// Known Istanbul football stadiums the ICS fixture feeds might reference.
// Only fixtures whose LOCATION matches one of these are "home" games in
// Istanbul and worth surfacing as a local traffic risk.
const ISTANBUL_VENUES = [
  { match: /vodafone park|tüpraş stadyumu|besiktas/i, name: "Vodafone Park", lat: 41.0391, lng: 29.0006 },
  { match: /rams park|türk telekom stadyumu|galatasaray/i, name: "Rams Park", lat: 41.1032, lng: 28.9989 },
  { match: /şükrü saracoğlu|fenerbahçe/i, name: "Şükrü Saracoğlu Stadyumu", lat: 40.9877, lng: 29.0369 },
];

/**
 * Matches a free-text ICS LOCATION field against known Istanbul venues.
 * Returns the venue descriptor or null if it doesn't match (e.g. an away game).
 */
function classifyVenue(locationText = "") {
  return ISTANBUL_VENUES.find((v) => v.match.test(locationText)) || null;
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

module.exports = { computeIndex, classifyVenue, isHolidayEvent, splitEvents, ISTANBUL_VENUES };
