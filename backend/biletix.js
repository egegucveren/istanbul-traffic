// backend/biletix.js
//
// Best-effort scraper for Biletix's server-rendered category pages
// (biletix.com has no public API, but its /category/{CAT}/TURKIYE/tr pages
// do render a "Hot Tickets" list of upcoming events server-side — confirmed
// by fetching them directly and seeing real event/venue/date data in the
// initial HTML, no JS execution needed).
//
// IMPORTANT CAVEAT: this was built and verified against Biletix's HTML via
// an external fetch tool, but could NOT be end-to-end tested from this
// backend's own runtime (the sandbox this was built in blocks outbound
// requests to biletix.com entirely, unrelated to Biletix itself). It should
// work the same way from a normal machine, but if Biletix changes their
// markup, or blocks server-side scraping, this degrades to returning an
// empty list — it will never throw and break the rest of the app. Treat it
// as best-effort, not guaranteed, and re-check it after pulling this repo.
//
// Only events at venues we recognize (backend/lib.js ISTANBUL_VENUES) are
// kept, since we need real coordinates to judge how close an event is to a
// given commute route. Everything else on the page is discarded.
const fetch = require("node-fetch");
const { ISTANBUL_VENUES } = require("./lib");

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
 * Returns Biletix events at known Istanbul venues, in the same shape as the
 * rest of the events pipeline: {title, lat, lng, start, end, venue}.
 */
async function fetchBiletixIstanbulEvents() {
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

module.exports = { fetchBiletixIstanbulEvents, extractEventsFromHtml, parseTrShortDate };
