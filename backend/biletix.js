// backend/biletix.js
//
// PRIMARY SOURCE — Biletix's internal Solr search API. The public site's
// search box is backed by a plain Solr endpoint that returns structured JSON
// (event name, venue, real start/end timestamps, category, on-sale status)
// with no HTML parsing needed. Verified live on 2026-07-16: region:ISTANBUL
// returned 1800+ events. Example:
//   https://www.biletix.com/solr/tr/select/?q=*:*&fq=region:ISTANBUL&rows=500&wt=json
// This is unofficial and could change/disappear, so:
//
// FALLBACK — the original best-effort scraper for the server-rendered
// "Hot Tickets" list on /category/{CAT}/TURKIYE/tr pages. Much lower
// coverage (~10 events per category page) but better than nothing if the
// Solr endpoint goes away.
//
// Either way this module never throws — worst case it resolves to [] and
// the rest of the events pipeline (ICS + manual) continues to work.
//
// Only events at venues we recognize (backend/lib.js ISTANBUL_VENUES) are
// kept, since we need real coordinates to judge how close an event is to a
// given commute route. Everything else is discarded.
const fetch = require("node-fetch");
const { ISTANBUL_VENUES } = require("./lib");

// How far ahead to ask Solr for events. Slightly wider than server.js's
// 21-day window so its own inWindow() filter stays the single source of truth.
const SOLR_LOOKAHEAD_DAYS = 22;
const SOLR_URL =
  "https://www.biletix.com/solr/tr/select/" +
  `?q=${encodeURIComponent(`start:[NOW TO NOW+${SOLR_LOOKAHEAD_DAYS}DAYS]`)}` +
  `&fq=${encodeURIComponent("region:ISTANBUL")}` +
  "&rows=1000&wt=json" +
  `&fl=${encodeURIComponent("id,name,venue,venuecode,start,end,city,category,status")}`;

const CATEGORY_URLS = [
  "https://www.biletix.com/category/MUSIC/TURKIYE/tr", // konser
  "https://www.biletix.com/category/ART/TURKIYE/tr", // tiyatro, stand-up, gösteri, bale-dans
  "https://www.biletix.com/category/SPORT/TURKIYE/tr", // basketbol, voleybol vb. (futbol ayrıca ICS'ten geliyor)
  "https://www.biletix.com/category/FAMILY/TURKIYE/tr", // aile etkinlikleri
];

const TR_MONTHS = {
  "oca": 0, "şub": 1, "mar": 2, "nis": 3, "may": 4, "haz": 5,
  "tem": 6, "ağu": 7, "eyl": 8, "eki": 9, "kas": 10, "ara": 11,
};

/** Parses a Turkish short date like "15 Cmt Ağu 2026" or "15 Ağu 2026" into a Date (local Istanbul evening). */
function parseTrShortDate(text) {
  const m = text.match(/(\d{1,2})\s+(?:[A-ZÇĞİÖŞÜa-zçğıöşü]{3}\s+)?([A-ZÇĞİÖŞÜa-zçğıöşü]{3})[A-ZÇĞİÖŞÜa-zçğıöşü]*\s+(\d{4})/);
  if (!m) return null;
  const day = Number(m[1]);
  const monKey = m[2].toLowerCase();
  const month = TR_MONTHS[monKey];
  if (month == null || !day) return null;
  const year = Number(m[3]);
  // Exact showtime isn't in the listing card — default to a typical evening
  // slot; splitEvents' pre/post buffers absorb some of that uncertainty.
  return new Date(`${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T20:00:00+03:00`);
}

function matchKnownVenue(venueText) {
  return ISTANBUL_VENUES.find((v) => v.match.test(venueText)) || null;
}

/**
 * Extracts (title, venueText, dateText) triples from raw HTML by pairing
 * each /etkinlik/ link with the nearest following /mekan/ link and the
 * nearest preceding date-shaped text — a structure-agnostic heuristic that
 * survives CSS/class changes since it only relies on link ordering.
 */
function extractEventsFromHtml(html) {
  const stripTags = (s) => s.replace(/<[^>]+>/g, "").trim();

  const eventLinkRe = /<a[^>]+href="[^"]*\/etkinlik\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const venueLinkRe = /<a[^>]+href="[^"]*\/mekan\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const eventMatches = [...html.matchAll(eventLinkRe)].map((m) => ({ index: m.index, title: stripTags(m[1]) }));
  const venueMatches = [...html.matchAll(venueLinkRe)].map((m) => ({ index: m.index, text: stripTags(m[1]) }));
  const dateRe = /\d{1,2}\s+(?:[A-ZÇĞİÖŞÜa-zçğıöşü]{3}\s+)?[A-ZÇĞİÖŞÜa-zçğıöşü]{3}[A-ZÇĞİÖŞÜa-zçğıöşü]*\s+\d{4}/g;
  const dateMatches = [...html.matchAll(dateRe)].map((m) => ({ index: m.index, text: m[0] }));

  const out = [];
  for (const ev of eventMatches) {
    if (!ev.title) continue;
    const venue = venueMatches.find((v) => v.index > ev.index && v.index - ev.index < 600);
    const date = [...dateMatches].reverse().find((d) => d.index < ev.index && ev.index - d.index < 400);
    if (!venue || !date) continue;
    out.push({ title: ev.title, venueText: venue.text, dateText: date.text });
  }
  return out;
}

async function fetchCategoryEvents(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        "Accept-Language": "tr-TR,tr;q=0.9",
      },
    });
    if (!res.ok) {
      console.error(`Biletix fetch failed: ${url} -> HTTP ${res.status}`);
      return [];
    }
    const html = await res.text();
    return extractEventsFromHtml(html);
  } catch (e) {
    console.error("Biletix fetch error:", url, e.message);
    return [];
  }
}

/**
 * Maps raw Solr docs to the pipeline event shape, keeping only events in
 * İstanbul proper (region:ISTANBUL also covers Bursa/Kocaeli etc.) at venues
 * we have coordinates for. Multi-day listings (e.g. a play running for a
 * month with end far after start) are kept as-is; splitEvents' time-window
 * logic downstream decides what's "active" for a given moment.
 */
function mapSolrDocs(docs) {
  const seen = new Set();
  const out = [];
  for (const doc of docs) {
    if (!doc || !doc.name || !doc.start) continue;
    if ((doc.city || "").toLocaleLowerCase("tr") !== "istanbul".toLocaleLowerCase("tr") &&
        !/i̇?stanbul/i.test(doc.city || "")) continue;
    if (/cancel|iptal/i.test(doc.status || "")) continue;

    const venue = matchKnownVenue(doc.venue || "");
    if (!venue) continue;

    const start = new Date(doc.start);
    if (Number.isNaN(start.getTime())) continue;
    let end = doc.end ? new Date(doc.end) : null;
    // Many single-show docs have end === start; assume ~3h show.
    if (!end || Number.isNaN(end.getTime()) || end <= start) {
      end = new Date(start.getTime() + 3 * 60 * 60 * 1000);
    }
    // Solr also returns "group"/tour listings whose start..end spans weeks or
    // months (e.g. a play's whole run, or an artist's tour). Counting those
    // as one continuous "active" event would poison the traffic factor for
    // the entire span, so only keep single-show entries (<= 24h).
    if (end - start > 24 * 60 * 60 * 1000) continue;

    const key = doc.id || `${doc.name}|${venue.key}|${start.toISOString().slice(0, 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      title: doc.name.trim(),
      lat: venue.lat,
      lng: venue.lng,
      start: start.toISOString(),
      end: end.toISOString(),
      venue: venue.name,
    });
  }
  return out;
}

/** Primary source: Biletix's Solr JSON search endpoint. */
async function fetchSolrEvents() {
  const res = await fetch(SOLR_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      "Accept": "application/json",
      "Accept-Language": "tr-TR,tr;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`Biletix Solr HTTP ${res.status}`);
  const json = await res.json();
  const docs = json?.response?.docs;
  if (!Array.isArray(docs)) throw new Error("Biletix Solr: unexpected response shape");
  return mapSolrDocs(docs);
}

/** Fallback source: scrape the server-rendered "Hot Tickets" category pages. */
async function fetchHotTicketsEvents() {
  const perCategory = await Promise.all(CATEGORY_URLS.map(fetchCategoryEvents));
  const raw = perCategory.flat();

  const seen = new Set();
  const out = [];
  for (const { title, venueText, dateText } of raw) {
    if (!/i̇?stanbul/i.test(venueText)) continue; // sadece İstanbul
    const venue = matchKnownVenue(venueText);
    if (!venue) continue; // koordinatı olmayan mekanı trafik hesabına katamıyoruz

    const start = parseTrShortDate(dateText);
    if (!start || Number.isNaN(start.getTime())) continue;
    const end = new Date(start.getTime() + 3 * 60 * 60 * 1000); // ~3 saatlik gösteri varsayımı

    const key = `${title}|${venue.key}|${start.toISOString().slice(0, 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      title: `${title} (saat yaklaşık)`,
      lat: venue.lat,
      lng: venue.lng,
      start: start.toISOString(),
      end: end.toISOString(),
      venue: venue.name,
    });
  }
  return out;
}

/**
 * Returns Biletix events at known Istanbul venues, in the same shape as the
 * rest of the events pipeline: {title, lat, lng, start, end, venue}.
 * Tries the Solr API first (full catalog); falls back to Hot Tickets
 * scraping if that fails. Never throws.
 */
async function fetchBiletixIstanbulEvents() {
  try {
    const events = await fetchSolrEvents();
    if (events.length) return events;
    console.warn("Biletix Solr returned 0 matching events, trying Hot Tickets fallback");
  } catch (e) {
    console.error("Biletix Solr fetch failed, falling back to Hot Tickets scrape:", e.message);
  }
  try {
    return await fetchHotTicketsEvents();
  } catch (e) {
    console.error("Biletix Hot Tickets fallback failed too:", e.message);
    return [];
  }
}

module.exports = {
  fetchBiletixIstanbulEvents,
  extractEventsFromHtml,
  parseTrShortDate,
  mapSolrDocs,
};
