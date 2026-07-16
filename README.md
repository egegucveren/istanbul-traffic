# Istanbul Traffic

[![CI](https://github.com/egegucveren/istanbul-traffic/actions/workflows/ci.yml/badge.svg)](https://github.com/egegucveren/istanbul-traffic/actions/workflows/ci.yml)

Live traffic dashboard for Istanbul. Combines Google traffic data with the weather forecast and the city's event calendar (football, concerts, theater, public holidays) to estimate what a trip will actually take, right now or up to a week ahead.

## Quick start

Two terminals, plus a Google Maps API key:

```bash
# Terminal 1 — backend
cd backend
npm install
cp .env.example .env        # add your server-side Google Maps key (skip if .env exists)
npm start                   # → http://localhost:5050

# Terminal 2 — frontend
cd frontend
npm install
cp .env.example .env        # add your browser-side Google Maps key (skip if .env exists)
npm start                   # → http://localhost:3000
```

See [Setup](#setup) for API key details and [Troubleshooting](#troubleshooting) if something errors out.

## Features

- **Traffic index** measured against the empty road, not the daily average. Each of the 8 reference corridors (E5 both directions, TEM both directions, both bridges, the Eurasia Tunnel, airport road) is compared to its own 3:30 AM travel time. 0% means free flow, 100% means trips take at least twice as long. This matters: Google's `duration` field already bakes in typical traffic for the hour, so comparing live time against it tells you "is today unusual?" rather than "is there traffic?" — evening rush would read as ~0%. Comparing against the night baseline gives the number you intuitively expect, and it's how TomTom computes its city congestion rankings.
- **Zoom-aware percentage.** Zoom into a district and the panel re-measures that area live: three sample routes inside the visible map area, blended with whichever reference corridors pass through it. Requests are debounced and results cached server-side (the night baseline for 24h, measurements for 60s), so panning around doesn't burn through API quota.
- **Commute planner** with driving/transit/walking comparison, Places autocomplete locked to Istanbul, and an optional departure time up to 7 days out. Future trips use Google's traffic prediction for that hour, the weather forecast for that hour, and whatever events fall on that day.
- **Expected travel time.** On top of Google's raw estimate, the backend applies a weather factor and an events factor and returns `expectedMin` with human-readable reasons ("Yağış ihtimali var", "Konser (Zorlu PSM) rota üzerinde — çıkış saatine denk geliyor").
- **Event-aware, with realistic timing.** An event only affects the estimate during the windows where it actually affects traffic: the arrival crush (2h before start until 30min after) and the exit crush (30min before the end until 45min after), both at full weight; a small effect while the show is running; nothing outside those windows. A concert 5 hours away doesn't generate warnings. Venue proximity is checked against the actual route geometry, so a route that passes right by a stadium gets flagged even if both endpoints are far from it.
- **Map locked to Istanbul.** Panning/zooming is restricted to the province bounds, and each travel mode draws its own route style (walking is a green dashed line, transit purple, driving blue) so you always know what you're looking at.

## Event sources

Three sources are merged, all optional, all with graceful fallbacks:

1. **Football + public holidays** from `.ics` feeds (`EVENTS_ICS_URLS` in `backend/.env`). Only home games at Istanbul stadiums are kept; away fixtures are dropped by matching the home team name against known venues.
2. **Biletix** for concerts, theater, stand-up and other ticketed events. There's no official API, but the search box on biletix.com is backed by a plain JSON endpoint that returns structured event data (name, venue, real start/end times, status) — `backend/biletix.js` queries it for Istanbul events in the next 3 weeks. If that endpoint ever changes or disappears, the code falls back to scraping the server-rendered category pages, and if that also fails it just returns fewer events instead of crashing. Multi-day listings (a play's whole run, an artist's tour entry) are skipped on purpose: only single shows have a predictable crowd window, and counting a two-month run as one continuous "active" event would poison the traffic estimate for weeks. Cancelled events and events outside İstanbul proper are filtered out.
3. **Manual list** (`backend/events.manual.json`, gitignored) for anything the automatic sources miss. Copy `events.manual.example.json` and edit:

```json
[{ "title": "...", "venueKey": "zorlu-psm", "start": "2026-09-12T20:30:00+03:00", "end": "2026-09-12T23:00:00+03:00" }]
```

Only events at venues with known coordinates count toward the traffic estimate, since the whole point is judging how close the crowd is to your route. The list (`ISTANBUL_VENUES` in `backend/lib.js`) currently covers 24 venues: the three big stadiums plus Başakşehir and the Olympic stadium, the arenas (Ülker, Sinan Erdem, Volkswagen, Ora), the main concert/theater venues (Zorlu PSM, Harbiye Açıkhava, KüçükÇiftlik Park, AKM, CRR, İş Sanat, Trump Sahne, TİM, Bostancı Gösteri Merkezi), open-air/festival grounds (Parkorman, Festival Park Yenikapı, Maltepe, UNIQ), and TÜYAP + Lütfi Kırdar for fairs and congresses. Adding one is a single line: `key`, a `match` regex, `name`, `lat`, `lng`. Some coordinates are approximate venue centers, which is fine for the distance thresholds involved (1.5 / 3 km).

## How "expected time" is calculated

`GET /api/commute` returns Google's raw `nowMin` and `typicalMin` unchanged, plus:

- `expectedMin` — `nowMin` adjusted by two factors (both in `backend/lib.js`, both unit tested):
  - **Weather** (`computeWeatherFactor`): max rain probability/volume within ±2h of the travel time, from a 7-day hourly Open-Meteo forecast fetched for the route midpoint. Calm ×1.0, ≥40% chance or light rain ×1.12, ≥70% or heavy rain ×1.25, plus ×1.08 if it's raining right now (only for "now" trips).
  - **Events** (`computeEventFactor`): every event active around the travel time, checked against origin, destination *and* the decoded route polyline. Within 1.5 km ×1.25, within 3 km ×1.12 — then scaled by the timing phase described above (arrival/exit windows full, mid-show 0.3×, otherwise zero). City-wide holidays apply a flat ×0.95 since Istanbul traffic is usually lighter.
  - Factors combine per mode — driving takes the full effect, transit half, walking only reacts to weather — and clamp to ×0.85–1.6.
- `adjustmentReasons` — date-stamped, phase-specific explanations shown under each route option.
- `travelAt` / `isFutureTrip`, plus `weatherConsidered` and `eventsConsidered` so you can tell whether the adjustment had data behind it.

## Tech stack

| Layer | Stack |
|---|---|
| Frontend | React 19 + TypeScript (CRA), `@react-google-maps/api` |
| Backend | Node.js + Express 5, `node-ical`, `express-rate-limit` |
| Data | Google Maps (Directions, Places, Traffic Layer), Open-Meteo, `.ics` fixture/holiday feeds, Biletix |
| CI | GitHub Actions — backend tests + frontend typecheck/test/build on every push |

## Project structure

```
istanbul-traffic/
├── .github/workflows/ci.yml
├── backend/
│   ├── server.js                    # Express API: index, index/local, commute, events, weather, health
│   ├── lib.js                       # Pure helpers: congestion math, venue matching, event phases,
│   │                                #   weather/event ETA adjustment, polyline decoding — unit tested
│   ├── biletix.js                   # Biletix event source (JSON endpoint + scraper fallback)
│   ├── events.manual.example.json
│   ├── test/                        # node:test suites
│   └── .env.example                 # copy to .env (gitignored)
└── frontend/
    ├── src/TrafficMap.tsx           # map + side panel (index, weather, planner, events)
    └── .env.example                 # copy to .env (gitignored)
```

## Setup

### Prerequisites

- Node.js 18+
- A Google Maps key with **Directions API**, **Places API** and **Maps JavaScript API** enabled, and billing set up

Use separate keys for backend and frontend and restrict them in the Cloud Console (server key by IP/API, browser key by HTTP referrer — include `http://localhost:3000/*` for development). Only the `.env.example` templates are committed.

### Backend (`backend/.env`)

```
GOOGLE_MAPS_SERVER_KEY=your_server_side_key
PORT=5050
TIMEZONE=Europe/Istanbul

# Optional — fixtures + TR holidays. Empty is fine; Biletix still provides events.
EVENTS_ICS_URLS=https://ics.fixtur.es/v2/galatasaray.ics,https://ics.fixtur.es/v2/fenerbahce.ics,https://ics.fixtur.es/v2/besiktas.ics,https://calendar.google.com/calendar/ical/tr.turkish%23holiday%40group.v.calendar.google.com/public/basic.ics

# Optional — lock CORS to your deployed frontend in production.
# ALLOWED_ORIGIN=https://your-app.netlify.app
```

Note: `ics.fixtur.es` moved from `/en/team/{team}.ics` to `/v2/{team}.ics` at some point; the backend auto-corrects old-style URLs, so stale `.env` files keep working.

### Frontend (`frontend/.env`)

```
REACT_APP_GOOGLE_MAPS_KEY=your_browser_side_key
REACT_APP_BACKEND=http://localhost:5050
```

Both servers need to run at the same time.

## API reference

| Endpoint | Description |
|---|---|
| `GET /api/health` | Liveness check. |
| `GET /api/index` | City-wide congestion (0–100%, vs. night free-flow baseline) across 8 corridors, duration-weighted so a 45-minute corridor counts more than a 5-minute tunnel. Includes per-route data and a level label (Akıcı/Hafif/Orta/Yoğun/Çok yoğun). Cached 30s. |
| `GET /api/index/local?n=&s=&e=&w=` | Same measurement for an arbitrary bounding box (what the frontend calls when zoomed in). Three live sample routes inside the box, blended with fresh corridor data passing through it. Box is clamped to Istanbul; results cached ~60s at ~1km granularity. |
| `GET /api/commute?from=lat,lng&to=lat,lng&modes=&when=` | Mode comparison with expected-time adjustment. `when` optional (ISO, up to 7 days ahead). Validated and rate limited (20/min/IP). |
| `GET /api/events/upcoming` | Merged events from ICS + Biletix + manual, cached 15 min. `source` tells you which sources actually returned data, `"fallback"` if none did. |
| `GET /api/weather?lat=&lng=` | Current conditions + 7-day hourly forecast. Cached per ~5km cell for 10 min. |

## Testing

```bash
cd backend && npm test          # unit tests (congestion math, event phases, venue matching, Biletix mapping)

cd frontend
npx tsc --noEmit
npm test -- --watchAll=false
npm run build
```

CI runs the same on every push and PR.

## Troubleshooting

**`/api/index` says "No routes computed" / log shows `Index error: all routes failed`.** Every corridor failed to get a Directions response, which is almost always a Google Cloud config problem: Directions API not enabled, billing missing, or the server key restricted to the wrong IP/API. The response includes each route's actual Google error message to diagnose.

**Map shows "Sorry! Something went wrong" / console warns `InvalidKey`.** That's the *browser* key (`frontend/.env`), a separate thing from the server key. Check that Maps JavaScript API is enabled, billing is on, and the key's referrer restrictions include your dev URL. Restart the dev server after editing `.env` — CRA reads it only at startup.

**Events panel only shows sample "Örnek: ..." entries.** All three sources came up empty; check the backend log for `ICS fetch failed`, `Biletix Solr fetch failed` or `events.manual.json okunamadı` to see which and why.

## Notes

- The 8 reference corridors are hardcoded in `backend/server.js` (`ROUTES`); adjust to taste.
- The weather/event multipliers and the event timing windows are hand-tuned heuristics, not a fitted model. Treat `expectedMin` as directional. The thresholds all live in `backend/lib.js` and are covered by tests, so retuning them is safe.
- The Biletix endpoint is unofficial. If events dry up, run `curl http://localhost:5050/api/events/upcoming` and check the `source` field first.
- Frontend deploys to Netlify (`frontend/netlify.toml`), publish directory `build`.
