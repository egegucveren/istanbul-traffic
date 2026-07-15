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
};

type CommuteResp = {
  routes: CommuteRoute[];
  fastestMode: string | null;
  generatedAt: string;
};

type IndexResp = {
  index: number;
  avgIncreasePct: number;
  updatedAt: string;
};

type EventItem = {
  title: string;
  lat: number;
  lng: number;
  startISO: string;
  endISO: string;
  venue: string;
};

const API_BASE = process.env.REACT_APP_API_BASE || "http://localhost:5050";

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

  const [routes, setRoutes] = useState<CommuteRoute[]>([]);
  const [selected, setSelected] = useState<CommuteRoute | null>(null);

  const [events, setEvents] = useState<EventItem[]>([]);

  // ---------- Trafik endeksi (5 dakikada bir) ----------
  useEffect(() => {
    let alive = true;

    const load = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/index`);
        const j: IndexResp = await r.json();
        if (!alive) return;
        setIndexPct(j.index);
        setIndexTime(new Date(j.updatedAt).toLocaleTimeString());
      } catch {
        setIndexPct(null);
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
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/events/upcoming`);
        const j = await r.json();
        const items: EventItem[] = [...(j.active || []), ...(j.upcoming || [])];
        setEvents(items);
      } catch {
        setEvents([]);
      }
    })();
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
    const qs = new URLSearchParams({
      from: `${origin.lat},${origin.lng}`,
      to: `${destination.lat},${destination.lng}`,
      modes: "driving,transit,walking",
    });
    try {
      const r = await fetch(`${API_BASE}/api/commute?${qs.toString()}`);
      if (!r.ok) throw new Error(await r.text());
      const j: CommuteResp = await r.json();
      setRoutes(j.routes);
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

  // ---------- Render ----------
  return (
    <LoadScript
      googleMapsApiKey={process.env.REACT_APP_GOOGLE_MAPS_KEY as string}
      libraries={["places", "geometry"] as any}
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
              {indexPct == null ? "—" : `%${indexPct}`}
            </div>
            {indexTime && (
              <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>
                Son güncelleme: {indexTime}
              </div>
            )}

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

            <button
              style={{ marginTop: 10, width: "100%", padding: 10, fontWeight: 600 }}
              onClick={calcRoute}
              disabled={!origin || !destination}
            >
              Rota Hesapla
            </button>

            {/* Rota özetleri */}
            {routes.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Seçenekler</div>
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
                      Şu an: {r.nowMin ?? "-"} dk &nbsp;|&nbsp; Tipik: {r.typicalMin ?? "-"} dk
                      {typeof r.diffToFastestMin === "number" && r.diffToFastestMin !== 0 && (
                        <> &nbsp;(+{r.diffToFastestMin} dk)</>
                      )}
                      {typeof r.deltaPctVsTypical === "number" && (
                        <> &nbsp;({r.deltaPctVsTypical > 0 ? "+" : ""}{r.deltaPctVsTypical}%)</>
                      )}
                    </div>
                    {r.warnings && <div style={{ color: "#b00", fontSize: 12 }}>{r.warnings}</div>}
                  </div>
                ))}
              </div>
            )}

            {/* Etkinlikler */}
            {events.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Etkinlikler</div>
                {events.map((ev, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <b>{ev.title}</b> – {ev.venue}
                    <div style={{ fontSize: 12, color: "#666" }}>
                      {new Date(ev.startISO).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
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

            {/* Etkinlik markerları */}
            {events.map((ev, i) => (
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