# Istanbul Traffic

[![CI](https://github.com/egegucveren/istanbul-traffic/actions/workflows/ci.yml/badge.svg)](https://github.com/egegucveren/istanbul-traffic/actions/workflows/ci.yml)

A live traffic dashboard for Istanbul. It combines real-time driving data, a commute planner, event awareness (football fixtures, public holidays, concerts, theater, stand-up), and weather into a single **expected travel time** — not just what Google says right now, but what it's likely to become once rain or a nearby event kicks in, for right now *or* a trip you're planning days ahead.

## Quick start (TL;DR)

You need two terminals — one for the backend, one for the frontend — plus a Google Maps API key.

```bash
# Terminal 1 — backend
cd backend
npm install
cp .env.example .env        # paste your Google Maps server key into it (skip if .env already exists)
npm start                   # → http://localhost:5050

# Terminal 2 — frontend
cd frontend
npm install
cp .env.example .env        # paste your Google Maps browser key into it (skip if .env already exists)
npm start                   # → http://localhost:3000, opens automatically
```

Leave both running and open `http://localhost:3000`. See [Getting started](#getting-started) below for API key setup, and [Troubleshooting](#troubleshooting) if `/api/index` or `/api/commute` error out.

## What it does

- **Expected travel time** — for any commute (right now, or up to 7 days ahead), the backend layers the weather forecast and any nearby Istanbul events on top of Google's traffic-predicted duration, producing an `expectedMin` figure with plain-language reasons ("Yağış ihtimali var", "16 Ağu 15:00 — Beşiktaş - Eyüpspor (Vodafone Park) çok yakın — yoğun trafik bekleniyor"). See [How "expected time" is calculated](#how-expected-time-is-calculated).
- **Plan a future trip** — pick a date/time (up to 7 days out) in the commute planner instead of "now". Google Directions returns a traffic *prediction* for that time, the weather check looks at the forecast for that specific hour instead of right now, and events are matched against whatever's happening on that day, not today.
- **City-wide traffic index** — polls Google Directions on 8 major corridors (E5, TEM, both Bosphorus bridges, Eurasia Tunnel, airport route) and derives a single congestion percentage, refreshed every 5 minutes.
- **Commute assistant** — pick an origin and destination (with Places autocomplete) and compare driving, transit, and walking times against typical conditions and the weather/event-adjusted expected time, with the fastest option highlighted on the map.
- **Event awareness, three automatic sources merged together:**
  1. Football fixtures + Turkish public holidays from live `.ics` feeds (only home games at Istanbul stadiums are kept; away games are filtered out).
  2. Concerts, theater, stand-up, and other sports, scraped automatically from Biletix's server-rendered category pages — see the [Biletix integration](#biletix-integration-concertstheaterstand-up) section for exactly how this works and its limits.
  3. An optional hand-maintained `events.manual.json` for anything the automatic sources miss.
- **Weather context** — pulls a 7-day hourly forecast and shows current conditions + a 3-hour outlook, with an on-panel warning when rain is likely.
- **Live map** — Google Maps with the traffic layer enabled, plus the selected route and event venues drawn on top.
- Loading/error states throughout the panel instead of silent failures, input validation and rate limiting on the backend, a `/api/health` check, and CI running the full test suite on every push.

## How "expected time" is calculated

`GET /api/commute` still returns Google's raw `nowMin` (traffic-predicted duration for the requested time) and `typicalMin` (no-traffic baseline) unchanged. Alongside them it now returns:

- `expectedMin` — `nowMin` adjusted by a weather factor and an events factor (see `backend/lib.js`):
  - **Weather** (`computeWeatherFactor`): looks at the max rain probability/volume forecast within ±2h of the requested travel time (fetched for the midpoint of your route from a 7-day hourly Open-Meteo forecast) and, if the trip is right now, whether it's raining at this exact moment. Calm → ×1.0. ≥40% chance or light rain → ×1.12. ≥70% chance or heavy rain → ×1.25. Raining right now (only applies to "now" trips) → an extra ×1.08.
  - **Events** (`computeEventFactor`): checks every Istanbul event active around the requested travel time (home match, public holiday, concert, theater, stand-up — from all three sources above) against the straight-line distance to your origin/destination. Within 1.5 km of a venue → ×1.25. Within 3 km → ×1.12. A city-wide public holiday → ×0.95 (Istanbul traffic is typically lighter on holidays).
  - The two factors combine and scale per travel mode — driving feels the full effect, transit half of it, walking only reacts to weather (crowds don't slow down a sidewalk) — then clamp to a sane ×0.85–×1.6 range.
- `adjustmentReasons` — the human-readable, date-stamped reasons behind that adjustment, shown directly under each route option in the UI.
- `travelAt` / `isFutureTrip` — the actual time the estimate was computed for, and whether it's a future trip (vs. "now").
- Top-level `weatherConsidered` (bool) and `eventsConsidered` (count) so you can tell whether the adjustment actually had data to work with.

All of this logic lives in pure, unit-tested functions in `backend/lib.js` (`haversineKm`, `computeWeatherFactor`, `computeEventFactor`, `computeExpectedMinutes`) — see `backend/test/lib.test.js`.

## Biletix integration (concerts/theater/stand-up)

Biletix has no public API. Its homepage is JS-rendered, but its **category listing pages** (`biletix.com/category/{MUSIC,ART,SPORT,FAMILY}/TURKIYE/tr`) do render a "Hot Tickets" list of upcoming events server-side, with real title/venue/date data in the initial HTML — no JavaScript execution needed to read it. `backend/biletix.js` fetches those pages and extracts events at venues it recognizes from `ISTANBUL_VENUES` (see below).

**Caveats, read before relying on this:**
- This was built and verified by fetching Biletix's pages directly, but **could not be tested end-to-end from inside this backend** — the sandbox this was built in blocks outbound requests to `biletix.com` entirely (unrelated to Biletix itself; unfamiliar/non-allowlisted domains get blocked at the sandbox's network layer). It should work the same from a normal machine, but verify it after pulling this repo: `curl http://localhost:5050/api/events/upcoming` and check `"source"` includes `"biletix"`.
- It's HTML scraping, not an API — if Biletix changes their page markup, this silently returns fewer/no events rather than crashing (same fallback behavior as the other event sources). No exact showtime is given on the listing cards, so scraped events default to a 20:00–23:00 window — treat their timing as approximate, unlike the ICS-sourced match times which are exact.
- Only events at venues listed in `ISTANBUL_VENUES` (`backend/lib.js`) are kept, since the traffic-impact calculation needs real coordinates. Extend that list (see below) to widen coverage.

## Known Istanbul venues (`ISTANBUL_VENUES` in `backend/lib.js`)

| Venue | Key | What's there |
|---|---|---|
| Vodafone Park | `vodafone-park` | Beşiktaş football |
| Rams Park | `rams-park` | Galatasaray football |
| Şükrü Saracoğlu Stadyumu | `sukru-saracoglu` | Fenerbahçe football |
| Ülker Sports Arena | `ulker-sports-arena` | Basketball, concerts |
| Sinan Erdem Spor Salonu | `sinan-erdem` | Basketball, concerts, big events |
| Zorlu PSM | `zorlu-psm` | Concerts, musicals, theater |
| KüçükÇiftlik Park | `kucukciftlik-park` | Open-air concerts |
| Cemal Reşit Rey Konser Salonu (CRR) | `crr` | Classical concerts, ballet |
| Harbiye Cemil Topuzlu Açıkhava Tiyatrosu | `harbiye-acikhava` | Open-air concerts/theater |
| Atatürk Kültür Merkezi (AKM) | `akm` | Opera, theater, concerts |
| TÜYAP Fuar ve Kongre Merkezi | `tuyap` | Fairs/expos |

Coordinates were checked against Wikipedia/official sources at the time this was written. To add a venue: add an entry to `ISTANBUL_VENUES` with a `key`, a `match` regex (matches either a LOCATION field or, for football, the team name), `name`, `lat`, `lng`.

## Optional manual events (`backend/events.manual.json`)

If the automatic sources miss something you know about, copy `backend/events.manual.example.json` to `backend/events.manual.json` (gitignored — not committed, edit freely) and add entries:

```json
[{ "title": "...", "venueKey": "zorlu-psm", "start": "2026-09-12T20:30:00+03:00", "end": "2026-09-12T23:00:00+03:00" }]
```

`venueKey` must match one of the keys above; alternatively skip it and provide `lat`/`lng`/`venue` directly for a venue not in the list.

## Tech stack

| Layer    | Stack |
|----------|-------|
| Frontend | React 19 + TypeScript (Create React App), `@react-google-maps/api` |
| Backend  | Node.js + Express 5, `node-ical`, `express-rate-limit` |
| External APIs / sources | Google Maps (Directions, Places, Traffic Layer), Open-Meteo (weather), `.ics` fixture/holiday feeds, Biletix (scraped) |
| CI | GitHub Actions — backend unit tests + frontend typecheck/test/build on every push and PR |

## Project structure

```
istanbul-traffic/
├── .github/workflows/ci.yml        # CI: backend tests + frontend typecheck/test/build
├── backend/
│   ├── server.js                    # Express API: index, commute (+expected time), events, weather, health
│   ├── lib.js                       # Pure helpers — traffic index, venue matching, event bucketing,
│   │                                 #   weather/event ETA adjustment — all unit tested
│   ├── biletix.js                   # Biletix category-page scraper (see caveats above)
│   ├── events.manual.example.json   # Template for optional hand-added events
│   ├── events.manual.json           # Your real manual events (gitignored, optional)
│   ├── test/                        # node:test suites for lib.js and biletix.js
│   ├── .env.example                  # Template — copy to .env and fill in real values
│   └── .env                          # Server-side secrets (gitignored, not committed)
└── frontend/
    ├── src/
    │   ├── App.tsx
    │   ├── App.test.tsx              # Smoke tests for the side panel
    │   └── TrafficMap.tsx            # Main map + side panel UI (incl. date/time picker)
    ├── .env.example                   # Template — copy to .env and fill in real values
    └── .env                           # Client-side keys (gitignored, not committed)
```

## Getting started

### Prerequisites

- Node.js 18+
- A Google Maps API key with the **Directions API**, **Places API**, and **Maps JavaScript API** enabled ([console.cloud.google.com](https://console.cloud.google.com/) → APIs & Services → Enable APIs)

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env   # then fill in your real key (skip if .env already exists)
npm start
```

The API will be available at `http://localhost:5050`. You should see `✅ Backend http://localhost:5050 üzerinde çalışıyor` in the terminal.

`backend/.env`:

```
GOOGLE_MAPS_SERVER_KEY=your_server_side_key
PORT=5050
TIMEZONE=Europe/Istanbul

# Optional — team fixtures + TR holiday .ics feeds. If left empty,
# /api/events/upcoming still gets events from Biletix (see above); if that's
# also empty it falls back to a small sample.
EVENTS_ICS_URLS=https://ics.fixtur.es/v2/galatasaray.ics,https://ics.fixtur.es/v2/fenerbahce.ics,https://ics.fixtur.es/v2/besiktas.ics,https://calendar.google.com/calendar/ical/tr.turkish%23holiday%40group.v.calendar.google.com/public/basic.ics

# Optional — lock CORS down to your deployed frontend in production.
# ALLOWED_ORIGIN=https://your-app.netlify.app
```

> `EVENTS_ICS_URLS` uses `ics.fixtur.es/v2/{team}.ics` — an earlier version of this project used `ics.fixtur.es/en/team/{team}.ics`, which now 404s. The backend auto-corrects the old-style URL if it's still in your `.env`, so this isn't a breaking change either way.

### 2. Frontend

In a second terminal:

```bash
cd frontend
npm install
cp .env.example .env   # then fill in your real key (skip if .env already exists)
npm start
```

The app opens automatically at `http://localhost:3000`.

`frontend/.env`:

```
REACT_APP_GOOGLE_MAPS_KEY=your_browser_side_key
REACT_APP_BACKEND=http://localhost:5050
```

Both servers need to be running at the same time — the frontend calls the backend at `REACT_APP_BACKEND` for every panel section (traffic index, weather, events, commute).

> Use separate Google Maps keys for backend and frontend, and restrict each one (server key by IP/API, browser key by HTTP referrer) in the Google Cloud Console. Never commit real `.env` files — only the `.env.example` templates are tracked.

## Troubleshooting

**`/api/index` returns "No routes computed" / logs show `Index error: all routes failed`.** Every one of the 8 reference routes failed to get a Directions response — almost always a Google Maps API configuration problem, not a network blip. The response body and server log now include each route's actual error message (e.g. `REQUEST_DENIED`, `This API project is not authorized to use this API`, billing not enabled). Check: Directions API is enabled on your Google Cloud project, billing is set up, and `GOOGLE_MAPS_SERVER_KEY` isn't restricted to the wrong IP/referrer.

**`ICS fetch failed: ... 404 Not Found`.** You're on the old `ics.fixtur.es/en/team/...` URL style — see the note above; the backend now auto-corrects it, but double check `backend/.env` if it persists.

**Events panel only shows the sample "Örnek: ..." entries.** This means all three real sources (ICS, Biletix, manual) came up empty — check the backend log for `ICS fetch failed`, `Biletix fetch error`, or `events.manual.json okunamadı` to see which one(s) failed and why.

## Testing

```bash
# Backend — unit tests for the pure calculation/filtering/ETA/scraping logic
cd backend && npm test

# Frontend — component smoke tests + TypeScript check + production build
cd frontend
npx tsc --noEmit
npm test -- --watchAll=false
npm run build
```

The same three frontend commands and `npm test` in the backend run automatically on every push/PR via `.github/workflows/ci.yml`.

## API reference (backend)

| Endpoint | Description |
|----------|--------------|
| `GET /api/health` | Liveness check — `{ status: "ok", uptime }`. Useful for deployment platforms. |
| `GET /api/index` | City-wide traffic index (1–99%), averaged across 8 reference routes. Cached for 30s. Rate limited. On total failure, returns each route's actual Google error for diagnosis. |
| `GET /api/commute?from=lat,lng&to=lat,lng&modes=driving,transit,walking&when=ISO` | Travel time comparison across modes: `nowMin`/`typicalMin` (raw Google data) plus `expectedMin`/`adjustmentReasons` (weather + event adjusted). `when` is optional (ISO datetime, up to 7 days ahead) — omit it for "now". Validates `from`/`to`/`modes`/`when`. Rate limited to 20 req/min/IP. |
| `GET /api/events/upcoming` | Active and upcoming events (matches, holidays, concerts, theater, stand-up) merged from ICS + Biletix + manual sources, cached for 15 min. `source` field shows which combination actually returned data (e.g. `"ics+biletix"`), or `"fallback"` if all three failed. |
| `GET /api/weather?lat=&lng=` | Current conditions + a 7-day hourly forecast (`hourly`) and a next-3-hour slice (`next3h`) for the simple UI widget. Defaults to central Istanbul. Cached per ~5km area for 10 min. |

## Notes

- The 8 reference routes for the traffic index are hardcoded in `backend/server.js` (`ROUTES`) and can be adjusted to cover different corridors.
- The weather/event ETA multipliers in `computeWeatherFactor`/`computeEventFactor`/`computeExpectedMinutes` are a hand-tuned heuristic, not a fitted model — treat `expectedMin` as a directional estimate, and feel free to retune the thresholds in `backend/lib.js` (they're the parts under test).
- Frontend deploys via Netlify (`frontend/netlify.toml`); the publish directory is `build`, matching Create React App's actual output folder.
- The repo is public on GitHub — no API keys or `.env` files have ever been committed (only `.env.example` templates are tracked, plus `events.manual.json` is gitignored), but double-check before pushing anything new that touches credentials.
