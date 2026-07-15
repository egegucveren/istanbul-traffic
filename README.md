# Istanbul Traffic

A live traffic dashboard for Istanbul. It combines real-time driving data, a commute planner, event awareness (football fixtures, public holidays), and short-term weather to help you understand — and plan around — the city's notoriously heavy traffic.

## What it does

- **City-wide traffic index** — polls Google Directions on 8 major corridors (E5, TEM, both Bosphorus bridges, Eurasia Tunnel, airport route) and derives a single congestion percentage, refreshed every 5 minutes.
- **Commute assistant** — pick an origin and destination (with Places autocomplete) and compare driving, transit, and walking times against typical conditions, with the fastest option highlighted on the map.
- **Event awareness** — pulls Galatasaray/Fenerbahçe/Beşiktaş fixtures and Turkish public holidays from live `.ics` feeds, keeps only home games at their Istanbul stadiums (away games are filtered out), and shows them as active/upcoming with venue markers on the map.
- **Weather context** — pulls current conditions and a 3-hour precipitation outlook, with an on-panel warning when rain is likely, since rain is one of the biggest traffic multipliers in Istanbul.
- **Live map** — Google Maps with the traffic layer enabled, plus the selected route drawn on top.
- Loading and error states throughout the panel instead of silent failures, and basic rate limiting on the backend to protect the Google Maps key from abuse.

## Tech stack

| Layer    | Stack |
|----------|-------|
| Frontend | React 19 + TypeScript (Create React App), `@react-google-maps/api` |
| Backend  | Node.js + Express 5, `node-ical`, `express-rate-limit` |
| External APIs | Google Maps (Directions, Places, Traffic Layer), Open-Meteo (weather), `.ics` fixture/holiday feeds |

## Project structure

```
istanbul-traffic/
├── backend/
│   ├── server.js         # Express API: traffic index, commute, events, weather
│   ├── lib.js             # Pure helpers (index calc, venue matching, event bucketing) — unit tested
│   ├── test/lib.test.js   # node:test suite for lib.js
│   ├── .env.example       # Template — copy to .env and fill in real values
│   └── .env               # Server-side secrets (gitignored, not committed)
└── frontend/
    ├── src/
    │   ├── App.tsx
    │   ├── App.test.tsx    # Smoke tests for the side panel
    │   └── TrafficMap.tsx  # Main map + side panel UI
    ├── .env.example        # Template — copy to .env and fill in real values
    └── .env                # Client-side keys (gitignored, not committed)
```

## Getting started

### Prerequisites

- Node.js 18+
- A Google Maps API key with the **Directions API**, **Places API**, and **Maps JavaScript API** enabled

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env   # then fill in your real key
npm start
```

The API will be available at `http://localhost:5050`.

`backend/.env`:

```
GOOGLE_MAPS_SERVER_KEY=your_server_side_key
PORT=5050
TIMEZONE=Europe/Istanbul

# Optional — team fixtures + TR holiday .ics feeds. If left empty,
# /api/events/upcoming falls back to a small static sample.
EVENTS_ICS_URLS=https://ics.fixtur.es/en/team/galatasaray.ics,https://ics.fixtur.es/en/team/fenerbahce.ics,https://ics.fixtur.es/en/team/besiktas.ics,https://calendar.google.com/calendar/ical/tr.turkish%23holiday%40group.v.calendar.google.com/public/basic.ics
```

### 2. Frontend

```bash
cd frontend
npm install
cp .env.example .env   # then fill in your real key
npm start
```

The app opens at `http://localhost:3000`.

`frontend/.env`:

```
REACT_APP_GOOGLE_MAPS_KEY=your_browser_side_key
REACT_APP_BACKEND=http://localhost:5050
```

> Use separate Google Maps keys for backend and frontend, and restrict each one (server key by IP/API, browser key by HTTP referrer) in the Google Cloud Console. Never commit real `.env` files — only the `.env.example` templates are tracked.

## Testing

```bash
# Backend — unit tests for the pure calculation/filtering logic
cd backend && npm test

# Frontend — component smoke tests + TypeScript check
cd frontend && npm test -- --watchAll=false
npx tsc --noEmit
```

## API reference (backend)

| Endpoint | Description |
|----------|--------------|
| `GET /api/index` | City-wide traffic index (1–99%), averaged across 8 reference routes. Cached for 30s. Rate limited. |
| `GET /api/commute?from=lat,lng&to=lat,lng&modes=driving,transit,walking` | Travel time comparison across modes, with the fastest one flagged. Rate limited more tightly (20 req/min/IP) since it's user-triggered and uncached. |
| `GET /api/events/upcoming` | Active and upcoming events (home matches, public holidays) that could affect traffic, sourced from `.ics` feeds and cached for 15 min. Falls back to a static sample if no feed is configured or all feeds fail. |
| `GET /api/weather?lat=&lng=` | Current conditions and next-3-hour precipitation outlook (defaults to central Istanbul). |

## Notes

- The 8 reference routes for the traffic index are hardcoded in `backend/server.js` (`ROUTES`) and can be adjusted to cover different corridors.
- Event venue matching (`backend/lib.js`, `ISTANBUL_VENUES`) only recognizes Vodafone Park, Rams Park, and Şükrü Saracoğlu Stadyumu — extend this list if you add more `.ics` sources.
- Frontend deploys via Netlify (`frontend/netlify.toml`); the publish directory is `build`, matching Create React App's actual output folder.
