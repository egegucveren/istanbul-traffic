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

// İstanbul il sınırlarını kapsayan kaba dikdörtgen (Silivri'den Şile'ye,
// Karadeniz kıyısından Adalar'ın güneyine). Harita bu kutunun dışına
// kaydırılamaz; minZoom da şehir görünümünden daha fazla uzaklaşmayı önler —
// proje İstanbul trafiğine odaklı, dünya haritasına dönüşmesin.
const ISTANBUL_BOUNDS = {
  north: 41.62,
  south: 40.75,
  west: 27.95,
  east: 29.95,
};

// Başlangıç/Varış autocomplete'leri de aynı kutuya kilitli: strictBounds
// sayesinde İstanbul dışından öneri gelmez (ülke kısıtı da TR).
const AUTOCOMPLETE_OPTIONS: google.maps.places.AutocompleteOptions = {
  bounds: ISTANBUL_BOUNDS,
  strictBounds: true,
  componentRestrictions: { country: "tr" },
  fields: ["geometry.location", "formatted_address", "name"],
};

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

type IndexRoute = {
  name: string;
  increasePct?: number;
  normalSec?: number;
  inTrafficSec?: number;
  error?: string;
  from?: LatLng;
  to?: LatLng;
};

type IndexResp = {
  index: number;
  avgIncreasePct: number;
  level?: string;
  routes?: IndexRoute[];
  updatedAt: string;
};

// Backend'deki computeIndex ile birebir aynı formül: trafikteki TOPLAM ekstra
// sürenin trafiksiz toplam süreye oranı (süre-ağırlıklı, [0,100]). Uzun
// koridorlar kısa geçişlerden daha çok ağırlık alır.
function indexFromRoutes(routes: IndexRoute[]): number | null {
  const usable = routes.filter(
    (r) => typeof r.normalSec === "number" && r.normalSec > 0 && typeof r.inTrafficSec === "number"
  );
  if (!usable.length) return null;
  const totalNormal = usable.reduce((s, r) => s + r.normalSec!, 0);
  const totalInTraffic = usable.reduce((s, r) => s + Math.max(r.inTrafficSec!, r.normalSec!), 0);
  const increase = (totalInTraffic / totalNormal - 1) * 100;
  return Math.min(100, Math.max(0, Math.round(increase)));
}

// Backend'deki trafficLevel ile aynı eşikler.
function trafficLevelLabel(index: number): string {
  if (index < 10) return "Akıcı";
  if (index < 25) return "Hafif";
  if (index < 45) return "Orta";
  if (index < 70) return "Yoğun";
  return "Çok yoğun";
}

// Bir rota doğru parçasının (from→to) verilen harita görünümüyle kesişip
// kesişmediği. Uç noktalardan biri içerideyse yeter; ikisi de dışarıdaysa
// parçayı örnekleyerek kontrol ederiz (küçük N için yeterince hassas ve ucuz).
function segmentIntersectsBounds(from: LatLng, to: LatLng, b: google.maps.LatLngBounds): boolean {
  const contains = (p: LatLng) => b.contains(new google.maps.LatLng(p.lat, p.lng));
  if (contains(from) || contains(to)) return true;
  const STEPS = 16;
  for (let i = 1; i < STEPS; i++) {
    const t = i / STEPS;
    if (contains({ lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t })) {
      return true;
    }
  }
  return false;
}

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
  // Şehir geneli rotalar (koordinatlı) — görünen bölgeye göre yerel endeks
  // hesabı için saklanır. localIndexPct null ise şehir geneli gösterilir.
  const indexRoutesRef = useRef<IndexRoute[]>([]);
  const [localIndexPct, setLocalIndexPct] = useState<number | null>(null);
  const [localRouteCount, setLocalRouteCount] = useState(0);
  // "live": bbox içinden canlı Google ölçümü; "corridor": sabit koridorlardan.
  const [localMode, setLocalMode] = useState<"live" | "corridor" | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const localReqIdRef = useRef(0); // eski (geciken) isteklerin sonucunu ele

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

  // ---------- Görünen bölgeye göre yerel trafik endeksi ----------
  // İki katmanlı yaklaşım:
  //  * Zoom >= 12 (mahalle/ilçe seviyesi): görünümün İÇİNDEN geçen iki çapraz
  //    örnek rota backend üzerinden Google'a CANLI ölçtürülür — haritada
  //    görülen kırmızılarla aynı kaynaktan beslenir. (Backend 60 sn cache'ler,
  //    burada da debounce var; maliyet kontrollü.)
  //  * Daha uzak zoom'larda: görünümle kesişen sabit ölçüm koridorlarının
  //    süre-ağırlıklı ortalaması (ek API maliyeti yok).
  const corridorFallback = (bounds: google.maps.LatLngBounds) => {
    const routes = indexRoutesRef.current;
    const usable = routes.filter((r) => typeof r.increasePct === "number" && r.from && r.to);
    const visible = usable.filter((r) => segmentIntersectsBounds(r.from!, r.to!, bounds));
    if (!visible.length || visible.length === usable.length) {
      // Görünümde ölçüm rotası yoksa yerel değer üretilemez; hepsi
      // görünüyorsa zaten şehir geneli ile aynıdır.
      setLocalIndexPct(null);
      setLocalMode(null);
      setLocalRouteCount(visible.length);
      return;
    }
    setLocalIndexPct(indexFromRoutes(visible));
    setLocalMode("corridor");
    setLocalRouteCount(visible.length);
  };

  const recomputeLocalIndex = async () => {
    const map = mapRef.current;
    const bounds = map?.getBounds();
    if (!map || !bounds) {
      setLocalIndexPct(null);
      setLocalMode(null);
      setLocalRouteCount(0);
      return;
    }
    const zoom = map.getZoom() ?? 11;
    if (zoom < 12) {
      corridorFallback(bounds);
      return;
    }
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const reqId = ++localReqIdRef.current;
    try {
      const qs = new URLSearchParams({
        n: ne.lat().toFixed(4),
        s: sw.lat().toFixed(4),
        e: ne.lng().toFixed(4),
        w: sw.lng().toFixed(4),
      });
      const r = await fetch(`${API_BASE}/api/index/local?${qs.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (reqId !== localReqIdRef.current) return; // bu arada harita oynadı, sonuç bayat
      setLocalIndexPct(typeof j.index === "number" ? j.index : null);
      setLocalMode("live");
      setLocalRouteCount(j.samples ?? 0);
    } catch {
      if (reqId === localReqIdRef.current) corridorFallback(bounds);
    }
  };

  // idle her pan/zoom karesinde tetiklenir; canlı ölçüm isteğini kullanıcı
  // gerçekten durduğunda atmak için 700 ms debounce.
  const onMapIdle = () => {
    if (idleTimerRef.current != null) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(recomputeLocalIndex, 700);
  };

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
        indexRoutesRef.current = j.routes || [];
        recomputeLocalIndex(); // yeni veriyle mevcut görünüm için yerel endeksi tazele
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

  const [placeError, setPlaceError] = useState<string | null>(null);

  // strictBounds önerileri İstanbul'a kısıtlar ama yine de (ör. koordinat
  // yapıştırma, Google'ın kutu kenarındaki esnek eşleşmeleri) son bir
  // doğrulama yapıyoruz: seçilen nokta il sınır kutusunun dışındaysa reddet.
  const inIstanbul = (lat: number, lng: number) =>
    lat >= ISTANBUL_BOUNDS.south && lat <= ISTANBUL_BOUNDS.north &&
    lng >= ISTANBUL_BOUNDS.west && lng <= ISTANBUL_BOUNDS.east;

  const onOriginChanged = () => {
    const p = originAutoRef.current?.getPlace();
    const loc = p?.geometry?.location;
    if (loc) {
      if (!inIstanbul(loc.lat(), loc.lng())) {
        setPlaceError("Başlangıç noktası İstanbul sınırları içinde olmalı");
        setOrigin(null);
        return;
      }
      setPlaceError(null);
      setOrigin({ lat: loc.lat(), lng: loc.lng() });
      setOriginText(p?.formatted_address || p?.name || originText);
    }
  };
  const onDestChanged = () => {
    const p = destAutoRef.current?.getPlace();
    const loc = p?.geometry?.location;
    if (loc) {
      if (!inIstanbul(loc.lat(), loc.lng())) {
        setPlaceError("Varış noktası İstanbul sınırları içinde olmalı");
        setDestination(null);
        return;
      }
      setPlaceError(null);
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

  // ---------- Etkinlikleri seçilen seyahat zamanına göre filtrele ----------
  // "Ne zaman?" boşsa yolculuk "şu an" demektir: sadece şu an aktif olan
  // veya bugün (gece yarısına kadar) başlayacak etkinlikler gösterilir —
  // haftalarca ilerideki etkinlikler o senaryoda gürültüdür. İleri tarihli
  // bir zaman seçilirse o GÜNÜN etkinlikleri gösterilir, böylece "cumartesi
  // 18:00'de yola çıksam" diyen kullanıcı o günkü maçı/konseri görür.
  const visibleEvents = useMemo(() => {
    const parsed = whenText ? new Date(whenText) : null;
    const ref = parsed && !Number.isNaN(parsed.getTime()) && parsed > new Date()
      ? parsed
      : new Date();
    const dayStart = new Date(ref); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(ref); dayEnd.setHours(23, 59, 59, 999);
    return events.filter((ev) => {
      const start = new Date(ev.startISO);
      const end = new Date(ev.endISO);
      // O gün ile kesişen her etkinlik: gün içinde başlayan, ya da daha önce
      // başlayıp o gün hâlâ süren (ör. çok günlük resmi tatil).
      return start <= dayEnd && end >= dayStart;
    });
  }, [events, whenText]);

  const eventsHeading = useMemo(() => {
    const parsed = whenText ? new Date(whenText) : null;
    if (parsed && !Number.isNaN(parsed.getTime()) && parsed > new Date()) {
      return `Etkinlikler — ${parsed.toLocaleDateString("tr-TR", { day: "2-digit", month: "long" })}`;
    }
    return "Bugünkü Etkinlikler";
  }, [whenText]);

  // Sadece koordinatı olan etkinlikler haritada işaretlenebilir (örn. resmi
  // tatiller şehir geneli olduğu için konumsuz gelir).
  const mappableEvents = useMemo(
    () => visibleEvents.filter((ev): ev is EventItem & { lat: number; lng: number } => ev.lat != null && ev.lng != null),
    [visibleEvents]
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
              {indexLoading
                ? "Yükleniyor…"
                : (localIndexPct ?? indexPct) == null
                ? "—"
                : `%${localIndexPct ?? indexPct} · ${trafficLevelLabel((localIndexPct ?? indexPct)!)}`}
            </div>
            {indexTime && !indexError && (
              <div style={mutedStyle}>
                {localIndexPct != null && localMode === "live"
                  ? `Görünen bölge (canlı ölçüm) · Şehir geneli: %${indexPct ?? "—"}`
                  : localIndexPct != null
                  ? `Görünen bölge (${localRouteCount} koridor) · Şehir geneli: %${indexPct ?? "—"}`
                  : "Şehir geneli"}
                {" · "}Son güncelleme: {indexTime}
              </div>
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
            <Autocomplete onLoad={onOriginLoad} onPlaceChanged={onOriginChanged} options={AUTOCOMPLETE_OPTIONS}>
              <input
                value={originText}
                onChange={(e) => setOriginText(e.target.value)}
                placeholder="Örn. Beşiktaş"
                style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
              />
            </Autocomplete>

            <div style={labelStyle}>Varış</div>
            <Autocomplete onLoad={onDestLoad} onPlaceChanged={onDestChanged} options={AUTOCOMPLETE_OPTIONS}>
              <input
                value={destText}
                onChange={(e) => setDestText(e.target.value)}
                placeholder="Örn. Kadıköy"
                style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
              />
            </Autocomplete>

            {placeError && <div style={errorStyle}>{placeError}</div>}

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
              <div style={{ fontWeight: 700, marginBottom: 6 }}>{eventsHeading}</div>
              {eventsLoading && <div style={mutedStyle}>Yükleniyor…</div>}
              {eventsError && <div style={errorStyle}>{eventsError}</div>}
              {!eventsLoading && !eventsError && visibleEvents.length === 0 && (
                <div style={mutedStyle}>Bu tarihte etkinlik yok</div>
              )}
              {visibleEvents.map((ev, i) => (
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
            onIdle={onMapIdle}
            mapContainerStyle={containerStyle}
            center={center}
            zoom={11}
            options={{
              gestureHandling: "greedy",
              mapTypeControl: false,
              // Haritayı İstanbul il sınırlarına kilitle: pan bu kutunun
              // dışına çıkamaz, zoom şehir seviyesinin altına inemez.
              restriction: { latLngBounds: ISTANBUL_BOUNDS, strictBounds: false },
              minZoom: 9,
            }}
          >
            {/* Trafik katmanı */}
            <TrafficLayer />

            {/* Seçilen rota — SADECE seçili modun çizgisi gösterilir.
                key={mode}: mod değişince Polyline tamamen yeniden kurulur,
                eski modun (ör. araba) çizgisi haritada asla kalmaz. */}
            {decodedPath && selected && (
              <Polyline
                key={selected.mode}
                path={decodedPath}
                options={
                  selected.mode === "walking"
                    ? {
                        // Yürüyüş: yeşil kesikli — araba rotasıyla karışmaz.
                        strokeColor: "#2e7d32",
                        strokeOpacity: 0,
                        strokeWeight: 5,
                        icons: [
                          {
                            icon: { path: "M 0,-1 0,1", strokeOpacity: 1, strokeColor: "#2e7d32", strokeWeight: 4, scale: 3 },
                            offset: "0",
                            repeat: "18px",
                          },
                        ],
                      }
                    : {
                        strokeColor: selected.mode === "transit" ? "#6a1b9a" : "#1976d2",
                        strokeOpacity: 0.9,
                        strokeWeight: 6,
                        icons: [],
                      }
                }
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
