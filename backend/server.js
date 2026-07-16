// backend/server.js
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // v2
const rateLimit = require("express-rate-limit");
const ical = require("node-ical");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const {
  computeIndex,
  classifyVenue,
  homeTeamFromSummary,
  isHolidayEvent,
  splitEvents,
  computeExpectedMinutes,
  decodePolyline,
  ISTANBUL_VENUES,
} = require("./lib");
const { fetchBiletixIstanbulEvents } = require("./biletix");

const app = express();

// ALLOWED_ORIGIN lets you lock this down to your deployed frontend's origin
// in production (e.g. https://your-app.netlify.app). Left unset, CORS stays
// permissive so local development (localhost:3000 etc.) keeps working.
const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(cors(allowedOrigin ? { origin: allowedOrigin } : undefined));

const PORT = process.env.PORT || 5050;
const GMAPS_KEY = process.env.GOOGLE_MAPS_SERVER_KEY;
if (!GMAPS_KEY) {
  console.warn(
    "⚠️  GOOGLE_MAPS_SERVER_KEY tanımlı değil — /api/index ve /api/commute Google Directions çağrılarında hata verecek."
  );
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

/* ----------------------------
   Rate limiting
   Google Directions calls cost money per request, so every route that can
   trigger one is capped per IP. /api/commute is the most abuse-prone (user
   controlled origin/destination, no caching), so it gets a tighter limit.
   ---------------------------- */
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
const commuteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla istek gönderildi, lütfen bir dakika sonra tekrar deneyin." },
});
app.use(generalLimiter);

/* ----------------------------
   Şehir Geneli Trafik İndeksi (Directions üzerinden türetilir)
   ---------------------------- */
const ROUTES = [
  { name: "E5 Batı→Merkez (Beylikdüzü→Bakırköy)", from: { lat: 41.0018, lng: 28.6401 }, to: { lat: 40.9799, lng: 28.8721 } },
  { name: "E5 Doğu→Merkez (Kartal→Kadıköy)",       from: { lat: 40.9076, lng: 29.2278 }, to: { lat: 40.9871, lng: 29.0356 } },
  { name: "TEM Batı→Merkez (Hadımköy→Maslak)",     from: { lat: 41.1361, lng: 28.5870 }, to: { lat: 41.1115, lng: 29.0203 } },
  { name: "TEM Doğu→Merkez (Şile→Ümraniye)",       from: { lat: 41.1717, lng: 29.3535 }, to: { lat: 41.0332, lng: 29.0985 } },
  { name: "1.Köprü Asya→Avrupa (Kuzguncuk→Beşiktaş)",from: { lat: 41.0408, lng: 29.0320 }, to: { lat: 41.0423, lng: 29.0050 } },
  { name: "2.Köprü Asya→Avrupa (Kavacık→Levent)",  from: { lat: 41.0917, lng: 29.0745 }, to: { lat: 41.0854, lng: 29.0218 } },
  { name: "Avrasya Tüneli (Acıbadem→Yenikapı)",    from: { lat: 41.0087, lng: 29.0396 }, to: { lat: 41.0044, lng: 28.9557 } },
  { name: "Havalimanı→Taksim",                     from: { lat: 41.2620, lng: 28.7424 }, to: { lat: 41.0369, lng: 28.9850 } },
];

async function directionsCall({ origin, destination, mode = "driving", depart = "now" }) {
  const base = "https://maps.googleapis.com/maps/api/directions/json";
  const params = new URLSearchParams({ origin, destination, mode, key: GMAPS_KEY });
  if (mode === "driving") {
    params.set("departure_time", depart);
    params.set("traffic_model", "best_guess");
  }
  if (mode === "transit") params.set("departure_time", depart);

  const res = await fetch(`${base}?${params.toString()}`);
  const data = await res.json();
  if (!data.routes || !data.routes.length) {
    // Surface Google's actual status/error_message (e.g. REQUEST_DENIED,
    // "This API project is not authorized...") instead of a generic string —
    // that's almost always the real reason /api/index or /api/commute fails.
    throw new Error(data.error_message || `Directions request failed (status: ${data.status || "unknown"})`);
  }
  const leg = data.routes[0].legs[0];
  return { leg, overview_polyline: data.routes[0].overview_polyline?.points || null };
}

async function getLegTimes(from, to) {
  const origin = `${from.lat},${from.lng}`;
  const destination = `${to.lat},${to.lng}`;
  const { leg } = await directionsCall({ origin, destination, mode: "driving", depart: "now" });
  const normal = leg.duration?.value; // saniye
  const inTraffic = leg.duration_in_traffic?.value || normal;
  if (!normal || !inTraffic) throw new Error("duration fields missing");
  return { normal, inTraffic };
}

/* ----------------------------
   Serbest akış (free-flow) tabanı
   ÖNEMLİ: Google'ın `duration` alanı "trafiksiz" süre DEĞİL — o saatin
   tipik/ortalama trafiğini zaten içeren statik tahmin. Canlıyı ona
   kıyaslamak "bugün her zamankinden ne kadar farklı"yı ölçer; haritadaki
   kırmızıların temsil ettiği MUTLAK sıkışıklığı değil. (Canlı doğrulandı:
   akşam 20:20'de E5'te duration=33 dk, duration_in_traffic=30 dk → eski
   formül %0 diyordu, yol kıpkırmızıyken.)
   Doğru taban: aynı rotanın GECE 03:30 (boş yol) tahmini. TomTom congestion
   index'i de aynen böyle hesaplanır. Rota başına günde 1 ek Directions
   çağrısı (24 saat cache).
   ---------------------------- */
const freeflowCache = new Map(); // key -> { sec, at }
const FREEFLOW_TTL = 24 * 60 * 60 * 1000;
const FREEFLOW_CACHE_MAX = 500;

// Bir sonraki 03:30 Europe/Istanbul (TR'de DST yok, sabit UTC+3 → 00:30 UTC).
function nextNightEpochSec() {
  const now = Date.now();
  const d = new Date(now);
  let night = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 30, 0);
  if (night <= now) night += 24 * 60 * 60 * 1000;
  return Math.floor(night / 1000);
}

async function getFreeflowSec(from, to) {
  const key = `${from.lat.toFixed(3)},${from.lng.toFixed(3)}|${to.lat.toFixed(3)},${to.lng.toFixed(3)}`;
  const cached = freeflowCache.get(key);
  if (cached && Date.now() - cached.at < FREEFLOW_TTL) return cached.sec;

  const origin = `${from.lat},${from.lng}`;
  const destination = `${to.lat},${to.lng}`;
  const { leg } = await directionsCall({ origin, destination, mode: "driving", depart: String(nextNightEpochSec()) });
  const sec = leg.duration_in_traffic?.value || leg.duration?.value;
  if (!sec) throw new Error("freeflow duration missing");

  if (freeflowCache.size >= FREEFLOW_CACHE_MAX) {
    freeflowCache.delete(freeflowCache.keys().next().value);
  }
  freeflowCache.set(key, { sec, at: Date.now() });
  return sec;
}

/** Canlı süre + serbest akış tabanı → gerçek sıkışıklık ölçümü. */
async function measureCongestion(from, to) {
  const t = await getLegTimes(from, to);
  // Freeflow çağrısı başarısız olursa tipik süreye düş (eski davranış) —
  // ölçüm hiç dönmemekten iyidir.
  const freeflow = await getFreeflowSec(from, to).catch(() => t.normal);
  // Güvenlik: gece tahmini bir tuhaflıkla tipikten uzun çıkarsa tipiği taban al.
  const base = Math.min(freeflow, t.normal);
  return {
    increasePct: (t.inTraffic / base - 1) * 100,
    normalSec: base,
    inTrafficSec: t.inTraffic,
  };
}

let indexCache = null;
let indexCacheAt = 0;
const INDEX_TTL = 30 * 1000;

app.get("/api/index", async (_req, res) => {
  try {
    if (indexCache && Date.now() - indexCacheAt < INDEX_TTL) return res.json(indexCache);

    const results = await Promise.all(
      ROUTES.map(async (r) => {
        try {
          // measureCongestion: canlı süre / GECE boş yol süresi — mutlak
          // sıkışıklık. from/to koordinatları frontend'in "görünen bölgeye
          // göre yoğunluk" hesabı için; normalSec/inTrafficSec süre-ağırlıklı
          // yüzde hesabı için (uzun koridor kısa tünelden çok ağırlık alır).
          const m = await measureCongestion(r.from, r.to);
          return { name: r.name, ...m, from: r.from, to: r.to };
        } catch (e) {
          return { name: r.name, error: e.message, from: r.from, to: r.to };
        }
      })
    );

    let index, avgIncreasePct, level;
    try {
      ({ index, avgIncreasePct, level } = computeIndex(results));
    } catch (computeErr) {
      // Every single route failed — this is almost always a Google API
      // config problem (bad/restricted key, Directions API not enabled,
      // billing not set up), not a transient network blip. Log and return
      // the actual per-route error messages so it's diagnosable instead of
      // just "No routes computed".
      console.error("Index error: all routes failed.", JSON.stringify(results));
      return res.status(500).json({ error: computeErr.message, routes: results });
    }

    indexCache = { index, avgIncreasePct, level, routes: results, updatedAt: new Date().toISOString() };
    indexCacheAt = Date.now();
    res.json(indexCache);
  } catch (err) {
    console.error("Index error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ----------------------------
   Görünen bölge için canlı yoğunluk ölçümü
   Sabit 8 koridor şehir genelini temsil eder ama kullanıcı bir mahalleye
   zoomladığında oradaki gerçek durumu göstermez (haritadaki kırmızılar
   Google TrafficLayer'dan gelir, bizim koridorlardan değil). Bu endpoint,
   verilen bbox'ın içinden geçen iki çapraz örnek rotayı Google Directions
   ile CANLI ölçüp aynı süre-ağırlıklı formülle yerel bir yüzde üretir.
   Maliyet kontrolü: bbox ~1km hassasiyetle yuvarlanıp 60 sn cache'lenir,
   frontend da istekleri debounce eder.
   ---------------------------- */
const localIndexCache = new Map(); // key -> { data, at }
const LOCAL_INDEX_TTL = 60 * 1000;
const LOCAL_INDEX_CACHE_MAX = 300;

// Frontend'deki harita kısıtıyla aynı kutu — örnek rotalar İstanbul dışına
// (ör. Marmara'nın karşı kıyısına, İzmit'e) taşmasın.
const ISTANBUL_BBOX = { n: 41.62, s: 40.75, w: 27.95, e: 29.95 };

// Bir koridor doğru parçası verilen bbox ile kesişiyor mu (parça örnekleme —
// 8 koridor için fazlasıyla ucuz ve yeterince hassas).
function segmentIntersectsBbox(from, to, b) {
  const inside = (p) => p.lat <= b.n && p.lat >= b.s && p.lng >= b.w && p.lng <= b.e;
  if (inside(from) || inside(to)) return true;
  const STEPS = 16;
  for (let i = 1; i < STEPS; i++) {
    const t = i / STEPS;
    if (inside({ lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t })) return true;
  }
  return false;
}

app.get("/api/index/local", async (req, res) => {
  try {
    const n = Number(req.query.n), s = Number(req.query.s), e = Number(req.query.e), w = Number(req.query.w);
    if (![n, s, e, w].every(Number.isFinite) || n <= s || e <= w) {
      return res.status(400).json({ error: "n,s,e,w (görünüm bbox'ı) gerekli" });
    }
    // İstanbul kutusuna kırp — görünüm kısmen il dışına taşarsa örnek rota
    // uçları deniz/il dışına düşmesin.
    const cn = Math.min(n, ISTANBUL_BBOX.n), cs = Math.max(s, ISTANBUL_BBOX.s);
    const ce = Math.min(e, ISTANBUL_BBOX.e), cw = Math.max(w, ISTANBUL_BBOX.w);
    if (cn <= cs || ce <= cw) return res.status(400).json({ error: "bbox İstanbul dışında" });

    const latSpan = cn - cs, lngSpan = ce - cw;
    // Çok büyük görünüm = şehir geneli endeksi zaten yeterli; çok küçük =
    // anlamlı rota çıkmaz (birkaç sokak).
    if (latSpan > 0.45 || lngSpan > 0.9) {
      return res.status(400).json({ error: "bbox çok büyük — şehir geneli endeksi kullanın" });
    }
    if (latSpan < 0.004 || lngSpan < 0.004) {
      return res.status(400).json({ error: "bbox çok küçük" });
    }

    // ~1km hassasiyet: yakın pan'lar aynı cache girdisine düşer.
    const key = [cn, cs, ce, cw].map((v) => v.toFixed(2)).join(",");
    const cached = localIndexCache.get(key);
    if (cached && Date.now() - cached.at < LOCAL_INDEX_TTL) return res.json(cached.data);

    // Kenarlardan %18 içeriden üç örnek (iki çapraz + orta yatay): görünümün
    // farklı akslarını yoklar, tek bir caddenin durumuna aşırı bağlı kalmaz.
    const mx = 0.18 * lngSpan, my = 0.18 * latSpan;
    const midLat = (cn + cs) / 2;
    const samples = [
      { from: { lat: cn - my, lng: cw + mx }, to: { lat: cs + my, lng: ce - mx } }, // KB→GD
      { from: { lat: cs + my, lng: cw + mx }, to: { lat: cn - my, lng: ce - mx } }, // GB→KD
      { from: { lat: midLat, lng: cw + mx }, to: { lat: midLat, lng: ce - mx } },   // B→D orta hat
    ];
    const results = await Promise.all(
      samples.map(async (r, i) => {
        try {
          // Aynı mutlak ölçüm: canlı vs gece boş yol (freeflow 24 saat
          // cache'li — aynı bölgeye ikinci bakıştan itibaren ek maliyeti yok).
          const m = await measureCongestion(r.from, r.to);
          return { name: `bölge-örneği-${i + 1}`, ...m };
        } catch (err) {
          return { name: `bölge-örneği-${i + 1}`, error: err.message };
        }
      })
    );

    // Görünümden geçen sabit koridorların TAZE verisi de karışıma katılır:
    // canlı örneklerle birlikte süre-ağırlıklı tek havuzda hesaplanır. Bu,
    // ölçümü yalnızca 3 örnek rotaya bağımlı olmaktan çıkarır.
    const corridorExtras =
      indexCache && Date.now() - indexCacheAt < 5 * 60 * 1000
        ? (indexCache.routes || []).filter(
            (r) => !r.error && r.from && r.to && segmentIntersectsBbox(r.from, r.to, { n: cn, s: cs, e: ce, w: cw })
          )
        : [];

    const { index, avgIncreasePct, level } = computeIndex([...results, ...corridorExtras]); // hepsi hatalıysa throw
    const data = {
      index,
      avgIncreasePct,
      level,
      samples: results.filter((r) => !r.error).length + corridorExtras.length,
      updatedAt: new Date().toISOString(),
    };
    if (localIndexCache.size >= LOCAL_INDEX_CACHE_MAX) {
      localIndexCache.delete(localIndexCache.keys().next().value); // en eskiyi at
    }
    localIndexCache.set(key, { data, at: Date.now() });
    res.json(data);
  } catch (e) {
    console.error("local index error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ----------------------------
   Gidiş Asistanı
   Ham Google Directions süresine ek olarak, seçilen tarih/saatteki hava
   durumu ve İstanbul'da o sırada aktif olan etkinlikleri (maç, resmi tatil,
   konser/tiyatro — bkz. events.manual.json) dikkate alan bir "expectedMin"
   (beklenen süre) hesaplanır — bkz. lib.js computeExpectedMinutes(). `when`
   verilmezse her şey "şu an" için hesaplanır; ileri tarihli bir `when`
   verilirse Google Directions o saat için trafik tahmini üretir, hava durumu
   o saatin etrafındaki tahmine bakılır, ve etkinlikler o tarihe göre
   aktif/pasif olarak sınıflanır — yani "16 Ağustos 14:00'te yola çıksam"
   sorusuna gerçek verilerle cevap verir.
   ---------------------------- */
const COORD_RE = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;
const VALID_MODES = new Set(["driving", "transit", "walking"]);
const MAX_WHEN_DAYS = 7; // Google'ın trafik tahmini ve bizim hava durumu penceremiz bu kadar ileriye kadar anlamlı

function parseLatLng(str) {
  const [lat, lng] = str.split(",").map(Number);
  return { lat, lng };
}

app.get("/api/commute", commuteLimiter, async (req, res) => {
  try {
    const { from, to, modes = "driving,transit,walking", when } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from,to gerekli. Örn: 41.0,29.0" });

    const origin = String(from);
    const destination = String(to);
    if (!COORD_RE.test(origin) || !COORD_RE.test(destination)) {
      return res.status(400).json({ error: "from,to 'lat,lng' formatında olmalı. Örn: 41.03,29.00" });
    }

    const modeList = String(modes).split(",").map((m) => m.trim().toLowerCase());
    const invalidModes = modeList.filter((m) => !VALID_MODES.has(m));
    if (!modeList.length || invalidModes.length) {
      return res.status(400).json({ error: `Geçersiz mod: ${invalidModes.join(", ")}. İzin verilenler: driving, transit, walking` });
    }

    // `when` opsiyonel — verilmezse "şu an". Geçmiş bir zaman verilirse yine
    // "şu an" kabul edilir (Google geçmiş departure_time'ı reddeder).
    const now = new Date();
    let travelAt = now;
    if (when) {
      const parsed = new Date(when);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: "when geçerli bir ISO tarih olmalı, örn. 2026-08-20T14:00:00+03:00" });
      }
      const maxDate = new Date(now.getTime() + MAX_WHEN_DAYS * 24 * 60 * 60 * 1000);
      if (parsed > maxDate) {
        return res.status(400).json({ error: `when en fazla ${MAX_WHEN_DAYS} gün ileri olabilir` });
      }
      if (parsed > now) travelAt = parsed;
    }
    const isFuture = travelAt.getTime() > now.getTime() + 60 * 1000;
    const departParam = isFuture ? String(Math.floor(travelAt.getTime() / 1000)) : "now";

    const results = await Promise.all(
      modeList.map(async (mode) => {
        try {
          const { leg, overview_polyline } = await directionsCall({ origin, destination, mode, depart: departParam });
          const typicalSec = leg.duration?.value || null;
          const nowSec = mode === "driving"
            ? (leg.duration_in_traffic?.value || typicalSec)
            : typicalSec;
          const distanceKm = leg.distance?.value ? leg.distance.value / 1000 : null;

          return {
            mode,
            nowMin: nowSec ? Math.round(nowSec / 60) : null,
            typicalMin: typicalSec ? Math.round(typicalSec / 60) : null,
            distanceKm,
            polyline: overview_polyline,
            warnings: leg.steps?.some(s => s.html_instructions?.includes("Toll")) ? "Ücretli yol olabilir" : null,
          };
        } catch (e) {
          return { mode, nowMin: null, typicalMin: null, distanceKm: null, polyline: null, error: e.message };
        }
      })
    );

    const fastest = results
      .filter(r => r.nowMin != null)
      .sort((a, b) => a.nowMin - b.nowMin)[0];

    // Beklenen süre için hava + etkinlik verisini paralel çekiyoruz; ikisi de
    // başarısız olsa bile commute sonucu yine dönsün diye ayrı try/catch.
    const originLL = parseLatLng(origin);
    const destLL = parseLatLng(destination);
    const midpoint = { lat: (originLL.lat + destLL.lat) / 2, lng: (originLL.lng + destLL.lng) / 2 };

    const [weather, eventsList] = await Promise.all([
      fetchWeatherFor(midpoint.lat, midpoint.lng).catch((e) => {
        console.error("commute weather fetch failed:", e.message);
        return null;
      }),
      getEventsList().catch((e) => {
        console.error("commute events fetch failed:", e.message);
        return { events: [] };
      }),
    ]);
    // Etkinlikleri "şu an" değil, seçilen `when` zamanına göre aktif/pasif
    // olarak sınıflandır — ileri tarihli bir gezi, o günkü maç/tatili görsün.
    const { active: activeEvents } = splitEvents(eventsList.events, travelAt);

    const enriched = results.map(r => {
      // Rota geometrisi de yakınlık kontrolüne girer: etkinlik mekanı
      // başlangıca/varışa uzak olsa bile rota dibinden geçiyorsa uyarılır.
      const routePath = r.polyline ? decodePolyline(r.polyline) : null;
      const expected = computeExpectedMinutes(r.nowMin, r.mode, weather, activeEvents, originLL, destLL, travelAt, routePath);
      return {
        ...r,
        diffToFastestMin: fastest && r.nowMin != null ? r.nowMin - fastest.nowMin : null,
        deltaPctVsTypical: (r.typicalMin && r.nowMin)
          ? Math.round(((r.nowMin / r.typicalMin) - 1) * 100)
          : null,
        expectedMin: expected.expectedMin,
        adjustmentReasons: expected.reasons,
      };
    });

    res.json({
      routes: enriched,
      fastestMode: fastest?.mode || null,
      weatherConsidered: !!weather,
      eventsConsidered: activeEvents.length,
      travelAt: travelAt.toISOString(),
      isFutureTrip: isFuture,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("commute error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ----------------------------
   Etkinlik / Maç Pik Uyarısı
   Üç otomatik kaynak birleştirilir:
     1) EVENTS_ICS_URLS (.env) — takım fikstürü + resmi tatil .ics beslemeleri.
        Sadece İstanbul'daki (ev sahibi) maçlar işlenir; deplasman atlanır.
     2) Biletix — konser/tiyatro/stand-up/spor. Resmi bir API yok, ama
        biletix.com'un kategori sayfaları sunucu tarafında render ediliyor;
        backend/biletix.js bu sayfaları çekip bilinen İstanbul mekanlarındaki
        etkinlikleri ayıklıyor (bkz. o dosyadaki uyarı notu — en iyi çaba
        kazıma, garantili değil).
     3) backend/events.manual.json (opsiyonel) — otomatik kaynaklar bir şeyi
        kaçırırsa elle eklenebilecek etkinlikler.
   Hiçbiri veri döndürmezse (ağ hatası vb.) tarihi her zaman güncel, küçük
   bir örnek listeye düşülür ki panel boş kalmasın.
   ---------------------------- */

// fixtur.es 2024'te ics.fixtur.es/en/team/{slug}.ics yapısından
// ics.fixtur.es/v2/{slug}.ics yapısına geçti (canlı test edilerek doğrulandı:
// eski yol 404 dönüyor). Eski stildeki URL'leri barındıran mevcut .env
// dosyalarını kırmamak için burada otomatik düzeltiyoruz.
function normalizeIcsUrl(url) {
  const m = url.match(/^https?:\/\/ics\.fixtur\.es\/en\/team\/([^/]+?)(\.ics)?$/i);
  if (m) return `https://ics.fixtur.es/v2/${m[1]}.ics`;
  return url;
}

const ICS_URLS = (process.env.EVENTS_ICS_URLS || "")
  .split(",")
  .map((u) => normalizeIcsUrl(u.trim()))
  .filter(Boolean);

const VENUE_BY_KEY = Object.fromEntries(ISTANBUL_VENUES.map((v) => [v.key, v]));

// Elle eklenmiş etkinlikler (opsiyonel). Gerçek dosya .gitignore'da; repo'da
// sadece events.manual.example.json bulunur. Şema:
//   [{ "title": "...", "venueKey": "zorlu-psm", "start": "ISO", "end": "ISO" }]
// venueKey yerine doğrudan "lat"/"lng"/"venue" de verilebilir.
function loadManualEvents() {
  const file = path.join(__dirname, "events.manual.json");
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((ev) => ev.title && ev.start && ev.end)
      .map((ev) => {
        const venue = ev.venueKey ? VENUE_BY_KEY[ev.venueKey] : null;
        return {
          title: ev.title,
          lat: venue ? venue.lat : ev.lat ?? null,
          lng: venue ? venue.lng : ev.lng ?? null,
          start: new Date(ev.start).toISOString(),
          end: new Date(ev.end).toISOString(),
          venue: venue ? venue.name : ev.venue || "İstanbul",
        };
      });
  } catch (e) {
    console.error("events.manual.json okunamadı:", e.message);
    return [];
  }
}

// Dates are computed relative to "now" (rather than hardcoded) so the
// fallback still shows something plausible whenever it's actually used,
// instead of going stale the moment the hardcoded dates are in the past.
function buildFallbackEvents() {
  const at = (daysFromNow, hour) => {
    const d = new Date();
    d.setDate(d.getDate() + daysFromNow);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  return [
    { title: "Örnek: Vodafone Park Maçı", lat: 41.0391, lng: 29.0006, start: at(3, 18), end: at(3, 20), venue: "Vodafone Park" },
    { title: "Örnek: Rams Park Maçı", lat: 41.1032, lng: 28.9989, start: at(4, 20), end: at(4, 22), venue: "Rams Park" },
  ];
}

async function fetchIcsEvents(url) {
  try {
    const data = await ical.async.fromURL(url);
    return Object.values(data).filter((ev) => ev.type === "VEVENT");
  } catch (e) {
    console.error("ICS fetch failed:", url, e.message);
    return [];
  }
}

async function loadEvents() {
  const now = new Date();
  const horizon = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000); // 3 hafta ileri bak
  const inWindow = (start, end) => end >= now && start <= horizon;

  const [icsRaw, biletix, manual] = await Promise.all([
    ICS_URLS.length ? Promise.all(ICS_URLS.map(fetchIcsEvents)).then((a) => a.flat()) : Promise.resolve([]),
    fetchBiletixIstanbulEvents().catch((e) => {
      console.error("Biletix fetch failed:", e.message);
      return [];
    }),
    Promise.resolve(loadManualEvents()),
  ]);

  const mapped = [];
  for (const ev of icsRaw) {
    if (!ev.start || !ev.end) continue;
    const start = new Date(ev.start);
    const end = new Date(ev.end);
    if (!inWindow(start, end)) continue; // sadece yakın zaman aralığı

    // Çoğu futbol .ics beslemesi (fixtur.es dahil) LOCATION set etmez;
    // SUMMARY "Ev Sahibi - Deplasman" formatındadır, ev sahibi takımdan
    // venue'yu çıkarıyoruz.
    const venue = classifyVenue(ev.location || "") || classifyVenue(homeTeamFromSummary(ev.summary || ""));
    if (venue) {
      mapped.push({
        title: ev.summary || "Maç",
        lat: venue.lat,
        lng: venue.lng,
        start: start.toISOString(),
        end: end.toISOString(),
        venue: venue.name,
      });
    } else if (isHolidayEvent(ev.summary || "")) {
      mapped.push({
        title: ev.summary,
        lat: null,
        lng: null,
        start: start.toISOString(),
        end: end.toISOString(),
        venue: "İstanbul geneli (resmi tatil)",
      });
    }
    // Diğerleri (İstanbul dışındaki deplasman maçları vb.) atlanır.
  }

  const biletixInWindow = biletix.filter((ev) => inWindow(new Date(ev.start), new Date(ev.end)));

  const combined = [...mapped, ...biletixInWindow, ...manual];
  if (combined.length) {
    const sources = [];
    if (mapped.length) sources.push("ics");
    if (biletixInWindow.length) sources.push("biletix");
    if (manual.length) sources.push("manual");
    return { events: combined, source: sources.join("+") };
  }

  console.warn("No events from ICS/Biletix/manual sources, using fallback sample");
  return { events: buildFallbackEvents(), source: "fallback" };
}

let eventsCache = null;
let eventsCacheAt = 0;
const EVENTS_TTL = 15 * 60 * 1000;

// Cached raw event list (not yet split into active/upcoming), shared by
// /api/events/upcoming (relative to "now") and /api/commute's expected-time
// calc (relative to whatever `when` the trip is being planned for).
async function getEventsList() {
  if (!eventsCache || Date.now() - eventsCacheAt > EVENTS_TTL) {
    eventsCache = await loadEvents();
    eventsCacheAt = Date.now();
  }
  return eventsCache;
}

app.get("/api/events/upcoming", async (_req, res) => {
  try {
    const { events, source } = await getEventsList();
    const { active, upcoming } = splitEvents(events, new Date());
    res.json({ active, upcoming, generatedAt: new Date().toISOString(), source });
  } catch (e) {
    console.error("events error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ----------------------------
   Hava
   fetchWeatherFor() paylaşılan bir yardımcı: hem /api/weather hem de
   /api/commute'un "beklenen süre" hesaplaması bunu kullanır. Koordinatları
   ~5km'lik kutucuklara yuvarlayıp 10 dakika cache'leyerek Open-Meteo'ya
   gereksiz tekrar istek atılmasını önler.
   ---------------------------- */
const weatherCache = new Map(); // key -> { data, at }
const WEATHER_TTL = 10 * 60 * 1000;
const WEATHER_BUCKET = 0.05; // ~5km
const WEATHER_FORECAST_DAYS = 7; // matches MAX_WHEN_DAYS below

// Fetches a 7-day hourly forecast (not just "next 3h") so future-dated trips
// (see /api/commute `when`) can look up the forecast for their own specific
// time instead of only "right now". `hourly` carries the full multi-day
// series with real timestamps; `next3h` is a slice of it for the simple
// current-conditions widget in the UI (kept for backward compatibility).
async function fetchWeatherFor(lat, lng) {
  const key = `${Math.round(lat / WEATHER_BUCKET)}:${Math.round(lng / WEATHER_BUCKET)}`;
  const cached = weatherCache.get(key);
  if (cached && Date.now() - cached.at < WEATHER_TTL) return cached.data;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&timezone=auto&current=temperature_2m,precipitation,weather_code,wind_speed_10m&hourly=precipitation,precipitation_probability,rain&forecast_days=${WEATHER_FORECAST_DAYS}`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error(j.reason || "Open-Meteo error");

  const current = j.current || j.current_weather || {};
  const hourly = j.hourly || {};
  const times = hourly.time || [];

  // Open-Meteo's hourly series starts at 00:00 today, not "now" — find the
  // first entry at/after the current moment so next3h is actually the next
  // 3 hours, not the first 3 hours of today (which could already be past).
  const nowIdx = Math.max(0, times.findIndex((t) => new Date(t).getTime() >= Date.now()));
  const slice = (arr) => (arr || []).slice(nowIdx, nowIdx + 3);

  const data = {
    current: {
      temperature: current.temperature_2m ?? current.temperature ?? null,
      precipitation: current.precipitation ?? 0,
      weatherCode: current.weather_code ?? current.weathercode ?? null,
      windSpeed: current.wind_speed_10m ?? current.windspeed ?? null,
    },
    hourly: {
      time: times,
      precipitation: hourly.precipitation || [],
      probability: hourly.precipitation_probability || [],
      rain: hourly.rain || [],
    },
    next3h: {
      time: slice(times),
      precipitation: slice(hourly.precipitation),
      probability: slice(hourly.precipitation_probability),
      rain: slice(hourly.rain),
    },
    updatedAt: new Date().toISOString(),
  };

  weatherCache.set(key, { data, at: Date.now() });
  return data;
}

app.get("/api/weather", async (req, res) => {
  try {
    const lat = req.query.lat ? Number(req.query.lat) : 41.01; // İstanbul
    const lng = req.query.lng ? Number(req.query.lng) : 28.97;
    const out = await fetchWeatherFor(lat, lng);
    res.json(out);
  } catch (e) {
    console.error("weather error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`✅ Backend http://localhost:${PORT} üzerinde çalışıyor`));
}

module.exports = app;
