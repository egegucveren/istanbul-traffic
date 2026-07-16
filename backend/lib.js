// backend/lib.js
// Pure, side-effect-free helpers extracted out of server.js so they're easy to unit test.

/**
 * Şehir geneli "trafik yoğunluğu %"si — TomTom/Yandex tarzı bir congestion
 * index: trafikte geçen TOPLAM ekstra sürenin, trafiksiz toplam süreye oranı.
 *
 *   index = (Σ inTrafficSec / Σ normalSec − 1) × 100, [0, 100] aralığına kıstırılır
 *
 * Süre-ağırlıklı toplam kullanmak önemli: 45 dakikalık E5 koridoru, 5
 * dakikalık tünel geçişiyle aynı ağırlıkta sayılmaz (eskiden sayılıyordu ve
 * kısa/akıcı rotalar endeksi gerçekçi olmayan biçimde aşağı çekiyordu).
 * normalSec/inTrafficSec verilmemişse increasePct'lerin (negatifler 0'a
 * çekilmiş) düz ortalamasına düşülür. %0 = tamamen akıcı, %100 = tipik
 * sürenin en az iki katı.
 *
 * @param {{name: string, increasePct?: number, normalSec?: number, inTrafficSec?: number, error?: string}[]} results
 */
function computeIndex(results) {
  const ok = results.filter((r) => !r.error && Number.isFinite(r.increasePct));
  if (!ok.length) throw new Error("No routes computed");

  const weighted = ok.filter((r) => Number.isFinite(r.normalSec) && Number.isFinite(r.inTrafficSec) && r.normalSec > 0);
  let increase;
  if (weighted.length === ok.length) {
    const totalNormal = weighted.reduce((s, r) => s + r.normalSec, 0);
    const totalInTraffic = weighted.reduce((s, r) => s + Math.max(r.inTrafficSec, r.normalSec), 0);
    increase = (totalInTraffic / totalNormal - 1) * 100;
  } else {
    increase = ok.reduce((s, r) => s + Math.max(0, r.increasePct), 0) / ok.length;
  }

  let index = Math.round(Math.min(100, Math.max(0, increase)));
  if (!Number.isFinite(index)) index = 0;

  return { index, avgIncreasePct: Math.round(increase), level: trafficLevel(index) };
}

/** İnsan-okur yoğunluk etiketi. Frontend'de aynı eşikler kullanılır. */
function trafficLevel(index) {
  if (index < 10) return "Akıcı";
  if (index < 25) return "Hafif";
  if (index < 45) return "Orta";
  if (index < 70) return "Yoğun";
  return "Çok yoğun";
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
  // Ek büyük mekanlar — Biletix'te sık görülen, trafik etkisi olan yerler.
  // (Koordinatlar yaklaşık merkez noktalarıdır; etkinlik-rota yakınlık
  // hesabı için yeterli hassasiyettedir.)
  { key: "ora-arena", match: /ora arena/i, name: "Ora Arena", lat: 40.9926, lng: 29.1215 },
  { key: "festival-park-yenikapi", match: /festival park yenikapı|yenikapı etkinlik/i, name: "Festival Park Yenikapı", lat: 40.9997, lng: 28.9532 },
  { key: "volkswagen-arena", match: /volkswagen arena/i, name: "Volkswagen Arena", lat: 41.1090, lng: 29.0190 },
  { key: "uniq-istanbul", match: /uniq (açıkhava|hall|istanbul|expo)/i, name: "UNIQ İstanbul", lat: 41.1090, lng: 29.0190 },
  { key: "bostanci-gosteri-merkezi", match: /bostancı gösteri merkezi|\bbgm\b/i, name: "Bostancı Gösteri Merkezi", lat: 40.9520, lng: 29.0900 },
  { key: "tim-show-center", match: /türker inanoğlu|tim show|maslak show/i, name: "TİM Show Center (Maslak)", lat: 41.1060, lng: 29.0250 },
  { key: "maltepe-acikhava", match: /maltepe (açıkhava|etkinlik|sahil)/i, name: "Maltepe Açıkhava / Etkinlik Alanı", lat: 40.9190, lng: 29.1380 },
  { key: "ataturk-olimpiyat", match: /olimpiyat stad/i, name: "Atatürk Olimpiyat Stadyumu", lat: 41.0742, lng: 28.7650 },
  { key: "is-sanat", match: /iş sanat|iş kuleleri salon/i, name: "İş Sanat Kültür Merkezi (Levent)", lat: 41.0778, lng: 29.0128 },
  { key: "trump-sahne", match: /trump sahne|trump kültür/i, name: "Trump Sahne (Mecidiyeköy)", lat: 41.0668, lng: 28.9925 },
  { key: "lutfi-kirdar", match: /lütfi kırdar|istanbul convention/i, name: "Lütfi Kırdar Kongre Merkezi (Harbiye)", lat: 41.0466, lng: 28.9878 },
  { key: "basaksehir-stadi", match: /başakşehir fatih terim|başakşehir stad/i, name: "Başakşehir Fatih Terim Stadyumu", lat: 41.1052, lng: 28.8083 },
  { key: "parkorman", match: /parkorman/i, name: "Parkorman (Maslak)", lat: 41.1150, lng: 28.9970 },
  { key: "jolly-joker-vadistanbul", match: /jolly joker vadistanbul|vadistanbul/i, name: "Jolly Joker Vadistanbul", lat: 41.1210, lng: 28.9880 },
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
 * Google encoded polyline decoder (standart algoritma) — rota geometrisini
 * backend'de açıp "etkinlik mekanı rotanın ÜZERİNDE mi" diye bakabilmek için.
 * @returns {{lat:number,lng:number}[]}
 */
function decodePolyline(encoded) {
  if (!encoded) return [];
  let index = 0, lat = 0, lng = 0;
  const path = [];
  while (index < encoded.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, b;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    path.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return path;
}

/*
 * Bir etkinliğin trafiği GERÇEKTEN etkilediği zaman pencereleri:
 *   - Giriş: başlangıçtan 2 saat öncesi → başlangıçtan 30 dk sonrası
 *     (seyirci akını; tam etki)
 *   - Çıkış: bitişten 30 dk öncesi → bitişten 45 dk sonrası
 *     (toplu çıkış; tam etki)
 *   - Gösteri sırası: herkes içeride — hafif etki (0.3x)
 *   - Bunların dışında (örn. konsere 5 saat varken): SIFIR etki, uyarı yok.
 */
const EVENT_ARRIVAL_PRE_MS = 2 * 60 * 60 * 1000;
const EVENT_ARRIVAL_POST_MS = 30 * 60 * 1000;
const EVENT_EXIT_PRE_MS = 30 * 60 * 1000;
const EVENT_EXIT_POST_MS = 45 * 60 * 1000;

/** @returns {{phase: "arrival"|"departure"|"ongoing"|"unknown"|null, weight: number}} */
function eventImpactPhase(ev, at = new Date()) {
  const start = new Date(ev.start ?? ev.startISO).getTime();
  // Hiç tarihi olmayan etkinlik (ör. elle girilmiş, saatsiz): faz bilinemez,
  // çağıran zaten splitEvents ile zaman-kapsamına almıştır — tam etki say.
  if (!Number.isFinite(start)) return { phase: "unknown", weight: 1 };
  let end = new Date(ev.end ?? ev.endISO).getTime();
  if (!Number.isFinite(end) || end <= start) end = start + 3 * 60 * 60 * 1000; // ~3 saatlik gösteri varsayımı
  const t = at.getTime();
  // Çıkış penceresi önce kontrol edilir: kısa etkinliklerde giriş/çıkış
  // pencereleri örtüşebilir, çıkış kalabalığı daha belirleyicidir.
  if (t >= end - EVENT_EXIT_PRE_MS && t <= end + EVENT_EXIT_POST_MS) return { phase: "departure", weight: 1 };
  if (t >= start - EVENT_ARRIVAL_PRE_MS && t <= start + EVENT_ARRIVAL_POST_MS) return { phase: "arrival", weight: 1 };
  if (t > start && t < end) return { phase: "ongoing", weight: 0.3 };
  return { phase: null, weight: 0 };
}

/**
 * Turns a list of "active" events (already pre/post-buffered around the
 * queried time, see splitEvents) into a duration multiplier + reasons.
 *
 * İki boyutlu kontrol:
 *  1) MEKAN YAKINLIĞI — başlangıç/varış VE (verildiyse) rota geometrisinin
 *     kendisi: rota mekanın dibinden geçiyorsa uçlar uzak olsa bile sayılır.
 *  2) ZAMAN FAZI — eventImpactPhase: sadece giriş/çıkış kalabalığı
 *     pencerelerinde tam etki; gösteri sürerken hafif; onun dışında hiç.
 * Events without coordinates (city-wide public holidays) get a small flat
 * discount instead. Reasons are date-stamped and phase-specific.
 * @param {{title:string, lat:number|null, lng:number|null, venue:string, start?:string, end?:string}[]} activeEvents
 * @param {{lat:number,lng:number}[]} [routePath] rota geometrisi (opsiyonel)
 */
function computeEventFactor(activeEvents, origin, destination, targetDate = new Date(), routePath = null) {
  if (!activeEvents || !activeEvents.length) return { multiplier: 1, reasons: [] };

  // Rota geometrisini ~25 noktaya seyrelt — yakınlık için fazlası gerekmez.
  let samplePoints = [origin, destination].filter(Boolean);
  if (routePath && routePath.length) {
    const step = Math.max(1, Math.floor(routePath.length / 25));
    for (let i = 0; i < routePath.length; i += step) samplePoints.push(routePath[i]);
  }

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

    const { phase, weight } = eventImpactPhase(ev, targetDate);
    if (!weight) continue; // etkinliğe saatler var / çoktan bitti — uyarı yok

    const point = { lat: ev.lat, lng: ev.lng };
    if (!samplePoints.length) continue;
    const minDist = Math.min(...samplePoints.map((p) => haversineKm(p, point)));

    // Mesafeye göre taban etki; zaman fazına göre ölçekle.
    let baseExtra = 0;
    if (minDist <= 1.5) baseExtra = 0.25;
    else if (minDist <= 3) baseExtra = 0.12;
    if (!baseExtra) continue;

    multiplier *= 1 + baseExtra * weight;

    const onRoute = routePath && routePath.length ? "rota üzerinde" : "yakınında";
    if (phase === "arrival") {
      reasons.push(`${whenPrefix}${ev.title} (${ev.venue}) ${onRoute} — giriş saati kalabalığı bekleniyor`);
    } else if (phase === "departure") {
      reasons.push(`${whenPrefix}${ev.title} (${ev.venue}) ${onRoute} — çıkış saatine denk geliyor, yoğunluk bekleniyor`);
    } else if (phase === "ongoing") {
      reasons.push(`${whenPrefix}${ev.title} (${ev.venue}) sürüyor — çevresinde hafif yoğunluk olabilir`);
    } else if (minDist <= 1.5) {
      reasons.push(`${whenPrefix}${ev.title} (${ev.venue}) çok yakın — yoğun trafik bekleniyor`);
    } else {
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
function computeExpectedMinutes(nowMin, mode, weather, activeEvents, origin, destination, targetDate = new Date(), routePath = null) {
  if (nowMin == null) return { expectedMin: null, reasons: [] };

  const weatherFx = computeWeatherFactor(weather, targetDate);
  const eventFx = mode === "walking"
    ? { multiplier: 1, reasons: [] }
    : computeEventFactor(activeEvents, origin, destination, targetDate, routePath);

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
  trafficLevel,
  classifyVenue,
  homeTeamFromSummary,
  isHolidayEvent,
  splitEvents,
  ISTANBUL_VENUES,
  haversineKm,
  decodePolyline,
  eventImpactPhase,
  computeWeatherFactor,
  computeEventFactor,
  computeExpectedMinutes,
  formatShortDateTR,
};
