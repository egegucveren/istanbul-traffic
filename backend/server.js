// backend/server.js
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // v2
require("dotenv").config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 5050;
const GMAPS_KEY = process.env.GOOGLE_MAPS_SERVER_KEY;

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
    throw new Error(data.error_message || "Directions route not found");
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

let indexCache = null;
let indexCacheAt = 0;
const INDEX_TTL = 30 * 1000;

app.get("/api/index", async (_req, res) => {
  try {
    if (indexCache && Date.now() - indexCacheAt < INDEX_TTL) return res.json(indexCache);

    const results = await Promise.all(
      ROUTES.map(async (r) => {
        try {
          const t = await getLegTimes(r.from, r.to);
          const ratio = t.inTraffic / t.normal;
          return { name: r.name, increasePct: (ratio - 1) * 100 };
        } catch (e) {
          return { name: r.name, error: e.message };
        }
      })
    );
    const ok = results.filter(r => !r.error);
    if (!ok.length) throw new Error("No routes computed");
    const avgIncrease = ok.reduce((s, r) => s + r.increasePct, 0) / ok.length;
    let index = Math.round(Math.min(99, Math.max(1, 1 + avgIncrease)));
    if (!Number.isFinite(index)) index = 1;

    indexCache = { index, avgIncreasePct: Math.round(avgIncrease), routes: results, updatedAt: new Date().toISOString() };
    indexCacheAt = Date.now();
    res.json(indexCache);
  } catch (err) {
    console.error("Index error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ----------------------------
   Gidiş Asistanı
   ---------------------------- */
app.get("/api/commute", async (req, res) => {
  try {
    const { from, to, modes = "driving,transit,walking" } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from,to gerekli. Örn: 41.0,29.0" });

    const origin = String(from);
    const destination = String(to);
    const modeList = String(modes).split(",").map(m => m.trim().toLowerCase());

    const results = [];
    for (const mode of modeList) {
      const { leg, overview_polyline } = await directionsCall({ origin, destination, mode, depart: "now" });
      const typicalSec = leg.duration?.value || null;
      const nowSec = mode === "driving"
        ? (leg.duration_in_traffic?.value || typicalSec)
        : typicalSec;
      const distanceKm = leg.distance?.value ? leg.distance.value / 1000 : null;

      results.push({
        mode,
        nowMin: nowSec ? Math.round(nowSec / 60) : null,
        typicalMin: typicalSec ? Math.round(typicalSec / 60) : null,
        distanceKm,
        polyline: overview_polyline,
        warnings: leg.steps?.some(s => s.html_instructions?.includes("Toll")) ? "Ücretli yol olabilir" : null,
      });
    }

    const fastest = results
      .filter(r => r.nowMin != null)
      .sort((a, b) => a.nowMin - b.nowMin)[0];

    const enriched = results.map(r => ({
      ...r,
      diffToFastestMin: fastest && r.nowMin != null ? r.nowMin - fastest.nowMin : null,
      deltaPctVsTypical: (r.typicalMin && r.nowMin)
        ? Math.round(((r.nowMin / r.typicalMin) - 1) * 100)
        : null
    }));

    res.json({ routes: enriched, fastestMode: fastest?.mode || null, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error("commute error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ----------------------------
   Etkinlik / Maç Pik Uyarısı (örnek)
   ---------------------------- */
const EVENTS = [
  { title: "Vodafone Park Maçı",   lat: 41.0391, lng: 29.0006, start: "2025-09-01T18:00:00+03:00", end: "2025-09-01T21:00:00+03:00", venue: "Vodafone Park" },
  { title: "Rams Park Maçı",       lat: 41.1032, lng: 28.9989, start: "2025-09-02T20:00:00+03:00", end: "2025-09-02T23:00:00+03:00", venue: "Rams Park" },
  { title: "TÜYAP Fuarı",          lat: 41.0065, lng: 28.6414, start: "2025-09-05T10:00:00+03:00", end: "2025-09-05T19:00:00+03:00", venue: "TÜYAP" },
  { title: "Ülker Arena Konseri",  lat: 40.9857, lng: 29.1171, start: "2025-09-03T19:00:00+03:00", end: "2025-09-03T22:30:00+03:00", venue: "Ülker Sports Arena" },
];

app.get("/api/events/upcoming", (_req, res) => {
  const now = new Date();
  const active = [];
  const upcoming = [];
  for (const ev of EVENTS) {
    const start = new Date(ev.start);
    const end = new Date(ev.end);
    const pre = new Date(start.getTime() - 2 * 60 * 60 * 1000); // 2 saat önce
    const post = new Date(end.getTime() + 60 * 60 * 1000);      // 1 saat sonra
    const item = { ...ev, startISO: start.toISOString(), endISO: end.toISOString() };
    if (now >= pre && now <= post) active.push(item);
    else if (start > now) upcoming.push(item);
  }
  res.json({ active, upcoming, generatedAt: now.toISOString() });
});

/* ----------------------------
   Hava
   ---------------------------- */
app.get("/api/weather", async (req, res) => {
  try {
    const lat = req.query.lat ? Number(req.query.lat) : 41.01; // İstanbul
    const lng = req.query.lng ? Number(req.query.lng) : 28.97;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&timezone=auto&current=temperature_2m,precipitation,weather_code,wind_speed_10m&hourly=precipitation,precipitation_probability,rain&forecast_hours=3`;
    const r = await fetch(url);
    const j = await r.json();

    const current = j.current || j.current_weather || {};
    const hourly = j.hourly || {};

    const out = {
      current: {
        temperature: current.temperature_2m ?? current.temperature ?? null,
        precipitation: current.precipitation ?? 0,
        weatherCode: current.weather_code ?? current.weathercode ?? null,
        windSpeed: current.wind_speed_10m ?? current.windspeed ?? null,
      },
      next3h: {
        time: hourly.time || [],
        precipitation: hourly.precipitation || [],
        probability: hourly.precipitation_probability || [],
        rain: hourly.rain || [],
      },
      updatedAt: new Date().toISOString(),
    };

    res.json(out);
  } catch (e) {
    console.error("weather error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`✅ Backend http://localhost:${PORT} üzerinde çalışıyor`));