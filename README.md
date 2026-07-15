# Istanbul Traffic

A live traffic dashboard for Istanbul. It combines real-time driving data, a commute planner, upcoming events (matches, concerts, fairs), and short-term weather to help you understand — and plan around — the city's notoriously heavy traffic.

## What it does

- **City-wide traffic index** — polls Google Directions on 8 major corridors (E5, TEM, both Bosphorus bridges, Eurasia Tunnel, airport route) and derives a single congestion percentage, refreshed every 5 minutes.
- **Commute assistant** — pick an origin and destination (with Places autocomplete) and compare driving, transit, and walking times against typical conditions, with the fastest option highlighted on the map.
- **Event awareness** — surfaces active and upcoming events (football matches, concerts, fairs) with venue markers, since these are common local causes of sudden congestion spikes.
- **Weather context** — pulls current conditions and a 3-hour precipitation outlook, since rain is one of the biggest traffic multipliers in Istanbul.
- **Live map** — Google Maps with the traffic layer enabled, plus the selected route drawn on top.

## Tech stack

| Layer    | Stack |
|----------|-------|
| Frontend | React 19 + TypeScript (Create React App), `@react-google-maps/api` |
| Backend  | Node.js + Express 5 |
| External APIs | Google Maps (Directions, Places, Traffic Layer), Open-Meteo (weather) |

## Project structure

```
istanbul-traffic/
├── backend/
│   ├── server.js        # Express API: traffic index, commute, events, weather
│   └── .env              # Server-side secrets (Google Maps server key, etc.)
└── frontend/
    ├── src/
    │   ├── App.tsx
    │   └── TrafficMap.tsx  # Main map + side panel UI
    └── .env               # Client-side keys (Google Maps browser key, API base URL)
```

## Getting started

### Prerequisites

- Node.js 18+
- A Google Maps API key with the **Directions API**, **Places API**, and **Maps JavaScript API** enabled

### 1. Backend

```bash
cd backend
npm install
```

Create/edit `backend/.env`:

```
GOOGLE_MAPS_SERVER_KEY=your_server_side_key
PORT=5050
TIMEZONE=Europe/Istanbul
```

Run it:

```bash
npm start
```

The API will be available at `http://localhost:5050`.

### 2. Frontend

```bash
cd frontend
npm install
```

Create/edit `frontend/.env`:

```
REACT_APP_GOOGLE_MAPS_KEY=your_browser_side_key
REACT_APP_BACKEND=http://localhost:5050
```

Run it:

```bash
npm start
```

The app opens at `http://localhost:3000`.

> Use separate Google Maps keys for backend and frontend, and restrict each one (server key by IP/API, browser key by HTTP referrer) in the Google Cloud Console.

## API reference (backend)

| Endpoint | Description |
|----------|--------------|
| `GET /api/index` | City-wide traffic index (0–99%), averaged across 8 reference routes. Cached for 30s. |
| `GET /api/commute?from=lat,lng&to=lat,lng&modes=driving,transit,walking` | Travel time comparison across modes, with the fastest one flagged. |
| `GET /api/events/upcoming` | Active and upcoming events (matches, concerts, fairs) that could affect nearby traffic. |
| `GET /api/weather?lat=&lng=` | Current conditions and next-3-hour precipitation outlook (defaults to central Istanbul). |

## Notes

- The 8 reference routes for the traffic index are hardcoded in `backend/server.js` (`ROUTES`) and can be adjusted to cover different corridors.
- Sample events in `EVENTS` are placeholders — wire this up to a real fixtures/events feed for production use.
- Never commit `.env` files; both are already excluded via `.gitignore`.
