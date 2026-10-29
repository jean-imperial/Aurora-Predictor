# Aurora Predictor

A map-based aurora forecast you can install on your phone. Tap anywhere on the map, or
pick a preset spot around Iceland, to get the chance of seeing the aurora hour by hour
for the next ~3 nights. You can also scrub through time to see the forecast over a wide
area.

It is a static website (HTML, CSS and JavaScript) with no build step, no server and no
API keys. The browser fetches all data directly from open sources.

## What it shows

| Layer | Meaning |
|---|---|
| **Viewing** | Chance you actually see aurora = aurora probability × darkness × clear sky |
| **Aurora** | Probability of aurora overhead or low on the poleward horizon |
| **Clouds** | ECMWF cloud forecast (low and mid cloud count fully, thin high cloud half) |

The **solar wind** card (top left) shows live measurements from the L1 point: Bz, speed,
density, Bt, 6-hour traces, a coupling rating, and how long that solar wind takes to reach
Earth.

## Data sources (all free and open)

| Data | Source | Used for |
|---|---|---|
| Real-time solar wind at L1 (`rtsw_mag_1m`, `rtsw_wind_1m`) | NOAA SWPC; whichever L1 spacecraft is active: SWFO-L1, IMAP, ACE or DSCOVR | Live conditions, coupling, arrival time |
| OVATION aurora nowcast | NOAA SWPC (driven by the L1 solar wind) | Aurora for the next ~1–2 h |
| Planetary Kp, 3-day forecast | NOAA SWPC | Aurora further ahead |
| ECMWF IFS (native ~9 km, falls back to 0.25°) | ECMWF open data via [Open-Meteo](https://open-meteo.com) | Cloud layers, temperature, wind |
| Basemap | Esri Dark Gray Canvas | Map background |

## How the aurora forecast works

1. **Now to ~2 h ahead:** NOAA's OVATION model, driven by solar wind measured at L1. The
   oval stays fixed relative to the Sun while the Earth turns underneath it, so the app
   rotates OVATION forward in magnetic local time.
2. **After that:** a standard (climatological) auroral oval sized by NOAA's Kp forecast.
   Its edge at midnight sits at about 66.5° − 1.75·Kp magnetic latitude, and the oval is
   brightest around magnetic midnight. Its overall level is scaled to match OVATION at the
   current time.
3. **Horizon aurora:** you can see aurora low on the poleward horizon from up to about 6°
   of latitude away, with the chance falling off with distance.
4. **Darkness:** sun altitude, from 0 at −4° to 1 at −14° and below.
5. **Magnetic coordinates:** a dipole model with a correction over the North Atlantic. The
   plain dipole puts Iceland about 3.5° too far north.

All of this lives in [js/model.js](js/model.js) and is covered by `npm test`.

**Caveats:** Kp forecasts more than about a day ahead are rough, and solar wind gusts can't
be forecast more than about an hour ahead (the travel time from L1). Use the 3-day view to
plan, and the live solar wind card and "Now" to decide whether to go outside.

## Run locally

```bash
cd repos/aurora_predictor
npm start            # python3 -m http.server 8000
# open http://localhost:8000
npm test             # unit tests for the model (Node 18+)
```

You need a local server rather than opening `index.html` directly, because ES modules and
the service worker don't load from `file://`.

## Host it and put it on your phone

The app is just static files, so any static host works. All of these give you free HTTPS,
which phones require for "My location" and for installing the app.

### Option A: GitHub Pages (recommended, free)

1. Create a new GitHub repo, e.g. `aurora-predictor`, and push **the contents of this
   folder** to its root:
   ```bash
   cd repos/aurora_predictor
   git init -b main && git add . && git commit -m "Aurora predictor"
   git remote add origin https://github.com/<you>/aurora-predictor.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The included workflow ([.github/workflows/pages.yml](.github/workflows/pages.yml)) runs
   the tests and publishes the site. After a minute it is live at
   `https://<you>.github.io/aurora-predictor/`.

### Option B: Netlify or Cloudflare Pages (also free)

Drag and drop this folder onto <https://app.netlify.com/drop>, or connect the GitHub repo
in Cloudflare Pages with **no build command** and the output directory set to `/`.

### Install on your phone

- **iPhone (Safari):** open the URL → Share → **Add to Home Screen**.
- **Android (Chrome):** open the URL → ⋮ menu → **Install app**.

It then opens full-screen like a native app. The service worker caches the app and the
last data it downloaded, and keeps map tiles you have already viewed. So if you lose signal
somewhere dark outside Reykjavík, it still opens and shows the last forecast. Refresh when
you're back online.

## Files

```
index.html               page layout
css/style.css            styling (desktop side panel, phone bottom sheet)
js/model.js              physics and heuristics (pure functions, unit tested)
js/data.js               all network requests
js/app.js                map, layers, time slider, forecast panel
sw.js                    offline cache
manifest.webmanifest     "install as app" metadata
icons/                   app icons (PNG made by scripts/make-icons.mjs)
tests/model.test.mjs     node --test unit tests
```

## Fair use

Open-Meteo's free tier is for non-commercial use, up to 10,000 calls a day. Each cloud map
load asks for 144 grid points, and there is also a limit of about 600 points per minute. If
you pan around quickly the app may briefly report that the limit was exceeded. Wait a minute
and it recovers. NOAA SWPC data is public
domain.
