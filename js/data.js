// Network layer: every external data source the app uses lives here.
// All endpoints are free, keyless and send CORS headers, so the app can be
// hosted as plain static files.

const SWPC = 'https://services.swpc.noaa.gov';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

// Open-Meteo serves ECMWF's open IFS data. ecmwf_ifs is the native ~9 km
// model; ecmwf_ifs025 (0.25 deg) is the fallback if the former is unavailable.
const ECMWF_MODELS = ['ecmwf_ifs', 'ecmwf_ifs025'];

const SPACECRAFT = { SOLAR1: 'SWFO-L1', IMAP: 'IMAP', ACE: 'ACE', DSCOVR: 'DSCOVR' };

async function getJSON(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) {
      const reason = await res.json().then((b) => b.reason, () => null);
      throw new Error(reason ?? `${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const utc = (s) => Date.parse(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');

/** OVATION aurora nowcast: global 1-degree grid of aurora probability. */
export async function fetchOvation() {
  const d = await getJSON(`${SWPC}/json/ovation_aurora_latest.json`);
  return {
    observed: utc(d['Observation Time']),
    forecast: utc(d['Forecast Time']),
    coordinates: d.coordinates,
  };
}

/** NOAA planetary Kp: recent observations plus the 3-day forecast. */
export async function fetchKp() {
  const d = await getJSON(`${SWPC}/products/noaa-planetary-k-index-forecast.json`);
  // Older versions of this product were an array of arrays with a header row.
  const rows = Array.isArray(d[0])
    ? d.slice(1).map((r) => Object.fromEntries(d[0].map((k, i) => [k, r[i]])))
    : d;
  return rows
    .map((r) => ({ t: utc(r.time_tag), kp: Number(r.kp), kind: r.observed }))
    .filter((r) => Number.isFinite(r.kp))
    .sort((a, b) => a.t - b.t);
}

/**
 * Real-time solar wind measured at the L1 point, 1.5 million km sunward.
 * SWPC merges several spacecraft; `active` marks the one in operational use.
 */
export async function fetchSolarWind() {
  const [mag, wind] = await Promise.all([
    getJSON(`${SWPC}/json/rtsw/rtsw_mag_1m.json`),
    getJSON(`${SWPC}/json/rtsw/rtsw_wind_1m.json`),
  ]);
  const pick = (rows, field) => {
    const ok = rows.filter((r) => r[field] != null);
    const active = ok.filter((r) => r.active);
    return (active.length ? active : ok)
      .map((r) => ({ ...r, t: utc(r.time_tag) }))
      .sort((a, b) => a.t - b.t);
  };
  const m = pick(mag, 'bz_gsm');
  const w = pick(wind, 'proton_speed');
  const lm = m.at(-1), lw = w.at(-1);
  const since = Date.now() - 6 * 3600000;
  return {
    spacecraft: SPACECRAFT[lw?.source] ?? lw?.source ?? 'unknown',
    magTime: lm?.t, windTime: lw?.t,
    bz: lm?.bz_gsm, by: lm?.by_gsm, bt: lm?.bt,
    speed: lw?.proton_speed, density: lw?.proton_density,
    bzSeries: m.filter((r) => r.t >= since).map((r) => ({ t: r.t, v: r.bz_gsm })),
    speedSeries: w.filter((r) => r.t >= since).map((r) => ({ t: r.t, v: r.proton_speed })),
  };
}

async function openMeteo(params) {
  let lastErr;
  for (const model of ECMWF_MODELS) {
    try {
      const qs = new URLSearchParams({ ...params, models: model, forecast_days: '4', timeformat: 'unixtime' });
      const d = await getJSON(`${OPEN_METEO}?${qs}`, 30000);
      return { model, data: Array.isArray(d) ? d : [d] };
    } catch (e) {
      lastErr = e;
      if (/limit exceeded/i.test(e.message)) break; // the fallback model would be refused too
    }
  }
  throw lastErr;
}

/** Hourly ECMWF forecast for one spot. Times are UTC milliseconds. */
export async function fetchPointWeather(lat, lon) {
  const { model, data } = await openMeteo({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m,apparent_temperature,wind_speed_10m,precipitation',
    timezone: 'auto',
  });
  const d = data[0];
  const h = d.hourly;
  return {
    model,
    timezone: d.timezone,
    hours: h.time.map((t, i) => ({
      t: t * 1000,
      total: h.cloud_cover[i], low: h.cloud_cover_low[i], mid: h.cloud_cover_mid[i], high: h.cloud_cover_high[i],
      temp: h.temperature_2m[i], feels: h.apparent_temperature[i],
      wind: h.wind_speed_10m[i], precip: h.precipitation[i],
    })),
  };
}

/**
 * Hourly ECMWF cloud layers on an n x n grid covering `bounds`, in one request.
 * Returns a regular grid suitable for bilinear interpolation.
 */
export async function fetchCloudGrid(bounds, n) {
  const { south, north, west, east } = bounds;
  const lats = [], lons = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      lats.push((south + ((north - south) * j) / (n - 1)).toFixed(3));
      lons.push((west + ((east - west) * i) / (n - 1)).toFixed(3));
    }
  }
  const { model, data } = await openMeteo({
    latitude: lats.join(','),
    longitude: lons.join(','),
    hourly: 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high',
    timezone: 'GMT',
  });
  const times = data[0].hourly.time.map((t) => t * 1000);
  const layer = (k) => data.map((p) => p.hourly[k]);
  return {
    model, bounds, n, times,
    total: layer('cloud_cover'), low: layer('cloud_cover_low'),
    mid: layer('cloud_cover_mid'), high: layer('cloud_cover_high'),
  };
}
