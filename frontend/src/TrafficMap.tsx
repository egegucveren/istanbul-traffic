// frontend/src/TrafficMap.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  GoogleMap,
  LoadScript,
  TrafficLayer,
  Autocomplete,
  Marker,
  Polyline,
} from "@react-google-maps/api";

// Stable reference — LoadScript remounts (and reloads the Google Maps
// script) every time this array's identity changes, which was previously
// happening on every render because a new array literal was passed inline.
// That reload loop is what caused the spurious "InvalidKey" errors even
// though the key itself was valid and correctly configured.
const GOOGLE_MAPS_LIBRARIES: ("places" | "geometry")[] = ["places", "geometry"];

type LatLng = google.maps.LatLngLiteral;

type CommuteRoute = {
  mode: "driving" | "transit" | "walking";
  nowMin: number | null;
  typicalMin: number | null;
  distanceKm: number | null;
  polyline: string | null;
  warnings?: string | null;
  diffToFastestMin?: number | null;
  deltaPctVsTypical?: number | null;
  // Hava durumu + yakındaki etkinliklere göre ayarlanmış tahmini süre.
  expectedMin?: number | null;
  adjustmentReasons?: string[];
};

type CommuteResp = {
  routes: CommuteRoute[];
  fastestMode: string | null;
  weatherConsidered?: boolean;
  eventsConsidered?: number;
  travelAt?: string;
  isFutureTrip?: boolean;
  generatedAt: string;
};

type IndexResp = {
  index: number;
  avgIncreasePct: number;
  updatedAt: string;
};

type EventItem = {
  title: string;
  lat: number | null;
  lng: number | null;
  startISO: string;
  endISO: string;
  venue: string;
};

type WeatherResp = {
  current: {
    temperature: number | null;
    precipitation: number;
    weatherCode: number | null;
    windSpeed: number | null;
  };
  next3h: {
    time: string[];
    precipitation: number[];
    probability: number[];
    rain: number[];
  };
  updatedAt: string;
};

// Not: eski kod REACT_APP_API_BASE okuyordu ama .env dosyası REACT_APP_BACKEND
// tanımlıyordu, yani override hiçbir zaman uygulanmıyordu. Düzeltildi.
const API_BASE = process.env.REACT_APP_BACKEND || "http://localhost:5050";

// ---------- Tasarım stilleri (dokunmuyorum) ----------
const containerStyle = { width: "100%", height: "100%" };
const panelStyle: React.CSSProperties = {
  width: 320,
  minWidth: 320,
  background: "#fff",
  borderRight: "1px solid #eee",
  padding: 12,
  overflowY: "auto",
};
const panelHeading: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 18,
  margin: "4px 0 8px",
};
const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#666",
  marginTop: 8,
};
const mutedStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#888",
};
const errorStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#b00020",
  marginTop: 4,
};

export default function TrafficMap() {
  // ---------- Harita merkezi ----------
  const center = useMemo<LatLng>(() => ({ lat: 41.0082, lng: 28.9784 }), []);

  // ---------- Refs & state ----------
  const mapRef = useRef<google.maps.Map | null>(null);
  const originAutoRef = useRef<google.maps.places.Autocomplete | null>(null);
  const destAutoRef = useRef<google.maps.places.Autocomplete | null>(null);

  const [panelOpen, setPanelOpen] = useState(true);

  const [originText, setOriginText] = useState("");
  const [destText, setDestText] = useState("");
  const [origin, setOrigin] = useState<LatLng | null>(null);
  const [destination, setDestination] = useState<LatLng | null>(null);

  const [indexPct, setIndexPct] = useState<number | null>(null);
  const [indexTime, setIndexTime] = useState<string | null>(null);
  const [indexLoading, setIndexLoading] = useState(true);
  const [indexError, setIndexError] = useState<string | null>(null);

  const [routes, setRoutes] = useState<CommuteRoute[]>([]);
  const [selected, setSelected] = useState<CommuteRoute | null>(null);
  const [commuteLoading, setCommuteLoading] = useState(false);
  const [commuteError, setCommuteError] = useState<string | null>(null);
  // Boş = "şu an". datetime-local input değeri (yerel saat, saniyesiz): "2026-08-20T14:00"
  const [whenText, setWhenText] = useState("");
  const [travelAt, setTravelAt] = useState<string | null>(null);
  const [isFutureTrip, setIsFutureTrip] = useState(false);

  const [events, setEvents] = useState<EventItem[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const [weather, setWeather] = useState<WeatherResp | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(true);
  const [weatherError, setWeatherError] = useState<string | null>(null);

  // ---------- Trafik endeksi (5 dakikada bir) ----------
  useEffect(() => {
    let alive = true;

    const load = async () => {
      setIndexLoading(true);
      try {
        const r = await fetch(`${API_BASE}/api/index`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j: IndexResp = await r.json();
        if (!alive) return;
        setIndexPct(j.index);
        setIndexTime(new Date(j.updatedAt).toLocaleTimeString());
        setIndexError(null);
      } catch (e) {
        if (!alive) return;
        setIndexPct(null);
        setIndexError("Trafik verisi alınamadı");
      } finally {
        if (alive) setIndexLoading(false);
      }
    };

    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // ---------- Etkinlikler ----------
  useEffect(() => {
    let alive = true;

    const load = async () => {
      setEventsLoading(true);
      try {
        const r = await fetch(`${API_BASE}/api/events/upcoming`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!alive) return;
        const items: EventItem[] = [...(j.active || []), ...(j.upcoming || [])];
        setEvents(items);
        setEventsError(null);
      } catch {
        if (!alive) return;
        setEvents([]);
        setEventsError("Etkinlikler yüklenemedi");
      } finally {
        if (alive) setEventsLoading(false);
      }
    };

    load();
    const t = setInterval(load, 15 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // ---------- Hava durumu (15 dakikada bir) ----------
  useEffect(() => {
    let alive = true;

    const load = async () => {
      setWeatherLoading(true);
      try {
        const r = await fetch(`${API_BASE}/api/weather`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j: WeatherResp = await r.json();
        if (!alive) return;
        setWeather(j);
        setWeatherError(null);
      } catch {
        if (!alive) return;
        setWeather(null);
        setWeatherError("Hava durumu alınamadı");
      } finally {
        if (alive) setWeatherLoading(false);
      }
    };

    load();
    const t = setInterval(load, 15 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // ---------- Autocomplete bağlama ----------
  const onOriginLoad = (ac: google.maps.places.Autocomplete) => (originAutoRef.current = ac);
  const onDestLoad = (ac: google.maps.places.Autocomplete) => (destAutoRef.current = ac);

  const onOriginChanged = () => {
    const p = originAutoRef.current?.getPlace();
    const loc = p?.geometry?.location;
    if (loc) {
      setOrigin({ lat: loc.lat(), lng: loc.lng() });
      setOriginText(p?.formatted_address || p?.name || originText);
    }
  };
  const onDestChanged = () => {
    const p = destAutoRef.current?.getPlace();
    const loc = p?.geometry?.location;
    if (loc) {
      setDestination({ lat: loc.lat(), lng: loc.lng() });
      setDestText(p?.formatted_address || p?.name || destText);
    }
  };

  // ---------- Rota hesaplama (backend) ----------
  const calcRoute = async () => {
    if (!origin || !destination) return;
    setCommuteLoading(true);
    setCommuteError(null);
    const qs = new URLSearchParams({
      from: `${origin.lat},${origin.lng}`,
      to: `${destination.lat},${destination.lng}`,
      modes: "driving,transit,walking",
    });
    // whenText boşsa "şu an" — datetime-local input yerel saat döndürür,
    // backend bunu ISO olarak parse edip Google/hava durumu/etkinlikler için kullanır.
    if (whenText) {
      const localDate = new Date(whenText);
      if (!Number.isNaN(localDate.getTime())) {
        qs.set("when", localDate.toISOString());
      }
    }
    try {
      const r = await fetch(`${API_BASE}/api/commute?${qs.toString()}`);
      if (!r.ok) throw new Error(await r.text());
      const j: CommuteResp = await r.json();
      setRoutes(j.routes);
      setTravelAt(j.travelAt || null);
      setIsFutureTrip(!!j.isFutureTrip);
      const fastest =
        j.routes.filter((x) => x.nowMin != null).sort((a, b) => (a.nowMin! - b.nowMin!))[0] || null;
      setSelected(fastest || null);

      // Haritayı rota alanına yaklaştır
      if (mapRef.current && origin && destination) {
        const bounds = new google.maps.LatLngBounds();
        bounds.extend(origin);
        bounds.extend(destination);
        mapRef.current.fitBounds(bounds);
      }
    } catch (e) {
      console.error(e);
      setRoutes([]);
      setSelected(null);
      setTravelAt(null);
      setCommuteError("Rota hesaplanamadı, lütfen tekrar deneyin");
    } finally {
      setCommuteLoading(false);
    }
  };

  // ---------- Polyline decode ----------
  const decodedPath = useMemo<google.maps.LatLng[] | null>(() => {
    if (!selected?.polyline) return null;
    // geometry kütüphanesi yüklü olduğundan kullanılabilir
    try {
      // @ts-ignore
      return google.maps.geometry.encoding.decodePath(selected.polyline);
    } catch {
      return null;
    }
  }, [selected]);

  // Sadece koordinatı olan etkinlikler haritada işaretlenebilir (örn. resmi
  // tatiller şehir geneli olduğu için konumsuz gelir).
  const mappableEvents = useMemo(
    () => events.filter((ev): ev is EventItem & { lat: number; lng: number } => ev.lat != null && ev.lng != null),
    [events]
  );

  const rainSoon = useMemo(() => {
    if (!weather) return false;
    return weather.next3h.probability.some((p) => p != null && p >= 50);
  }, [weather]);

  // datetime-local input için yerel saat "YYYY-MM-DDTHH:mm" biçimi.
  const toLocalInputValue = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const minWhen = useMemo(() => toLocalInputValue(new Date()), []);
  const maxWhen = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return toLocalInputValue(d);
  }, []);

  // ---------- Render ----------
  return (
    <LoadScript
      googleMapsApiKey={process.env.REACT_APP_GOOGLE_MAPS_KEY as string}
      libraries={GOOGLE_MAPS_LIBRARIES}
    >
      <div style={{ display: "flex", width: "100vw", height: "100vh" }}>
        {/* Sol Panel (tasarım korunuyor) */}
        {panelOpen && (
          <aside style={panelStyle}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 700 }}>Yol Asistanı</div>
              <button onClick={() => setPanelOpen(false)}>Gizle</button>
            </div>

            <div style={panelHeading}>
              Güncel Trafik Yoğunluğu:{" "}
              {indexLoading ? "Yükleniyor…" : indexPct == null ? "—" : `%${indexPct}`}
            </div>
            {indexTime && !indexError && (
              <div style={mutedStyle}>Son güncelleme: {indexTime}</div>
            )}
            {indexError && <div style={errorStyle}>{indexError}</div>}

            {/* Hava durumu */}
            <div style={{ marginTop: 14 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Hava Durumu</div>
              {weatherLoading && <div style={mutedStyle}>Yükleniyor…</div>}
              {weatherError && <div style={errorStyle}>{weatherError}</div>}
              {!weatherLoading && weather && (
                <div style={{ fontSize: 13 }}>
                  {weather.current.temperature != null ? `${Math.round(weather.current.temperature)}°C` : "—"}
                  {typeof weather.current.windSpeed === "number" && (
                    <> &nbsp;·&nbsp; Rüzgar {Math.round(weather.current.windSpeed)} km/s</>
                  )}
                  {rainSoon && (
                    <div style={{ color: "#a15c00", marginTop: 4 }}>
                      ⚠️ Önümüzdeki 3 saatte yağış bekleniyor — trafik yoğunlaşabilir
                    </div>
                  )}
                </div>
              )}
            </div>

            <div style={labelStyle}>Başlangıç</div>
            <Autocomplete onLoad={onOriginLoad} onPlaceChanged={onOriginChanged}>
              <input
                value={originText}
                onChange={(e) => setOriginText(e.target.value)}
                placeholder="Örn. Beşiktaş"
                style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
              />
            </Autocomplete>

            <div style={labelStyle}>Varış</div>
            <Autocomplete onLoad={onDestLoad} onPlaceChanged={onDestChanged}>
              <input
                value={destText}
                onChange={(e) => setDestText(e.target.value)}
                placeholder="Örn. Kadıköy"
                style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
              />
            </Autocomplete>

            <div style={labelStyle}>Ne zaman? (opsiyonel — boşsa şu an)</div>
            <input
              type="datetime-local"
              value={whenText}
              onChange={(e) => setWhenText(e.target.value)}
              min={minWhen}
              max={maxWhen}
              style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
            />

            <button
              style={{ marginTop: 10, width: "100%", padding: 10, fontWeight: 600 }}
              onClick={calcRoute}
              disabled={!origin || !destination || commuteLoading}
            >
              {commuteLoading ? "Hesaplanıyor…" : "Rota Hesapla"}
            </button>
            {commuteError && <div style={errorStyle}>{commuteError}</div>}

            {/* Rota özetleri */}
            {routes.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 2 }}>
                  {isFutureTrip && travelAt
                    ? `${new Date(travelAt).toLocaleString("tr-TR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} için tahmini`
                    : "Şu an için"}
                </div>
                <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13, color: "#666" }}>Seçenekler</div>
                {routes.map((r, i) => (
                  <div
                    key={i}
                    onClick={() => setSelected(r)}
                    style={{
                      padding: 8,
                      marginBottom: 6,
                      border: "1px solid #eee",
                      borderRadius: 6,
                      cursor: "pointer",
                      background: r === selected ? "#f5f8ff" : "#fff",
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>
                      {r.mode === "driving" ? "Araba" : r.mode === "transit" ? "Toplu Taşıma" : "Yürüyüş"}
                    </div>
                    <div style={{ fontSize: 13 }}>
                      {isFutureTrip ? "Trafik tahmini" : "Şu an"}: {r.nowMin ?? "-"} dk &nbsp;|&nbsp; Tipik: {r.typicalMin ?? "-"} dk
                      {typeof r.diffToFastestMin === "number" && r.diffToFastestMin !== 0 && (
                        <> &nbsp;(+{r.diffToFastestMin} dk)</>
                      )}
                      {typeof r.deltaPctVsTypical === "number" && (
                        <> &nbsp;({r.deltaPctVsTypical > 0 ? "+" : ""}{r.deltaPctVsTypical}%)</>
                      )}
                    </div>
                    {typeof r.expectedMin === "number" && r.expectedMin !== r.nowMin && (
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#a15c00", marginTop: 2 }}>
                        Hava/etkinlik dahil beklenen: {r.expectedMin} dk
                      </div>
                    )}
                    {r.adjustmentReasons && r.adjustmentReasons.length > 0 && (
                      <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 11, color: "#a15c00" }}>
                        {r.adjustmentReasons.map((reason, ri) => (
                          <li key={ri}>{reason}</li>
                        ))}
                      </ul>
                    )}
                    {r.warnings && <div style={{ color: "#b00", fontSize: 12 }}>{r.warnings}</div>}
                  </div>
                ))}
              </div>
            )}

            {/* Etkinlikler */}
            <div style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Etkinlikler</div>
              {eventsLoading && <div style={mutedStyle}>Yükleniyor…</div>}
              {eventsError && <div style={errorStyle}>{eventsError}</div>}
              {!eventsLoading && !eventsError && events.length === 0 && (
                <div style={mutedStyle}>Yakın zamanda etkinlik yok</div>
              )}
              {events.map((ev, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <b>{ev.title}</b> – {ev.venue}
                  <div style={{ fontSize: 12, color: "#666" }}>
                    {new Date(ev.startISO).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </aside>
        )}

        {/* Harita */}
        <div style={{ flex: 1, position: "relative" }}>
          {!panelOpen && (
            <button
              style={{ position: "absolute", zIndex: 2, top: 10, left: 10 }}
              onClick={() => setPanelOpen(true)}
            >
              Paneli Aç
            </button>
          )}

          <GoogleMap
            onLoad={(m) => { mapRef.current = m; }} // ✅ void döner
            mapContainerStyle={containerStyle}
            center={center}
            zoom={11}
            options={{ gestureHandling: "greedy", mapTypeControl: false }}
          >
            {/* Trafik katmanı */}
            <TrafficLayer />

            {/* Seçilen rota */}
            {decodedPath && (
              <Polyline
                path={decodedPath}
                options={{
                  strokeColor: "#1976d2",
                  strokeOpacity: 0.9,
                  strokeWeight: 6,
                }}
              />
            )}

            {/* Etkinlik markerları (konumu olanlar) */}
            {mappableEvents.map((ev, i) => (
              <Marker position={{ lat: ev.lat, lng: ev.lng }} key={i} />
            ))}

            {/* Başlangıç/Varış işaretçi (isteğe bağlı) */}
            {origin && <Marker position={origin} />}
            {destination && <Marker position={destination} />}
          </GoogleMap>
        </div>
      </div>
    </LoadScript>
  );
}
