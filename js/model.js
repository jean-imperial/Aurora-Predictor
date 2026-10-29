// Pure physics/heuristics for the aurora predictor. No DOM, no network:
// everything here can be unit tested with `node --test`.

const DEG = Math.PI / 180;
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// Geomagnetic north pole of the IGRF dipole, epoch ~2025.
export const POLE = { lat: 80.8, lon: -72.6 };

// ---------------------------------------------------------------- geometry

/** Geographic -> dipole geomagnetic coordinates (degrees). */
export function toMagnetic(lat, lon) {
  const cl = Math.cos(lat * DEG);
  const x = cl * Math.cos(lon * DEG);
  const y = cl * Math.sin(lon * DEG);
  const z = Math.sin(lat * DEG);
  const cp = Math.cos(POLE.lon * DEG), sp = Math.sin(POLE.lon * DEG);
  const x1 = x * cp + y * sp;
  const y1 = -x * sp + y * cp;
  const th = (90 - POLE.lat) * DEG;
  const x2 = x1 * Math.cos(th) - z * Math.sin(th);
  const z2 = x1 * Math.sin(th) + z * Math.cos(th);
  return { mlat: Math.asin(Math.max(-1, Math.min(1, z2))) / DEG, mlon: Math.atan2(y1, x2) / DEG };
}

/** Dipole geomagnetic -> geographic coordinates (degrees). */
export function fromMagnetic(mlat, mlon) {
  const cl = Math.cos(mlat * DEG);
  const x2 = cl * Math.cos(mlon * DEG);
  const y2 = cl * Math.sin(mlon * DEG);
  const z2 = Math.sin(mlat * DEG);
  const th = (90 - POLE.lat) * DEG;
  const x1 = x2 * Math.cos(th) + z2 * Math.sin(th);
  const z = -x2 * Math.sin(th) + z2 * Math.cos(th);
  const cp = Math.cos(POLE.lon * DEG), sp = Math.sin(POLE.lon * DEG);
  const x = x1 * cp - y2 * sp;
  const y = x1 * sp + y2 * cp;
  return { lat: Math.asin(Math.max(-1, Math.min(1, z))) / DEG, lon: Math.atan2(y, x) / DEG };
}

// --------------------------------------------------------------------- sun

/** Low-precision solar position (good to ~0.1 deg). */
export function sun(date) {
  const d = (+date - 946728000000) / 86400000; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * DEG;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const e = (23.439 - 0.00000036 * d) * DEG;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / DEG;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)) / DEG;
  const gmst = (18.697374558 + 24.06570982441908 * d) * 15; // degrees
  let subLon = (ra - gmst) % 360;
  if (subLon > 180) subLon -= 360;
  if (subLon < -180) subLon += 360;
  return { dec, subLon };
}

/** Sun altitude above the horizon in degrees. */
export function sunAltitude(date, lat, lon, s = sun(date)) {
  const H = (lon - s.subLon) * DEG;
  const sa = Math.sin(lat * DEG) * Math.sin(s.dec * DEG) +
    Math.cos(lat * DEG) * Math.cos(s.dec * DEG) * Math.cos(H);
  return Math.asin(sa) / DEG;
}

/** 0 in daylight/civil twilight, 1 when the sun is >14 deg below the horizon. */
export function darkness(alt) {
  return clamp01((-alt - 4) / 10);
}

/** Magnetic longitude of the sun's meridian (defines magnetic local time). */
export function sunMagLon(date) {
  const s = sun(date);
  return toMagnetic(s.dec, s.subLon).mlon;
}

/** Magnetic local time in hours (0 = magnetic midnight). */
export function mlt(date, lat, lon) {
  const d = toMagnetic(lat, lon).mlon - sunMagLon(date);
  return (((12 + d / 15) % 24) + 24) % 24;
}

// ------------------------------------------------------------- space weather

/** Overall activity level implied by Kp, 0..1. */
export function kpActivity(kp) {
  return 0.08 + 0.92 * (1 - Math.exp(-(((Math.max(0, kp) + 0.5) / 4) ** 2)));
}

/** Approximate magnetic latitude of the oval's equatorward edge at midnight. */
export function ovalBoundary(kp) {
  return 66.5 - 2 * kp;
}

/** Kp value for time t from a sorted [{t, kp}] list (3-hour blocks). */
export function kpAt(kpSeries, t) {
  if (!kpSeries.length) return 2;
  let v = kpSeries[0].kp;
  for (const r of kpSeries) {
    if (r.t <= +t) v = r.kp; else break;
  }
  return v;
}

/** Newell et al. (2007) solar wind - magnetosphere coupling, in "Newell units". */
export function newellCoupling(speed, by, bz) {
  const bt = Math.hypot(by, bz);
  const theta = Math.atan2(by, bz);
  return Math.pow(speed, 4 / 3) * Math.pow(bt, 2 / 3) * Math.pow(Math.abs(Math.sin(theta / 2)), 8 / 3);
}

/** Plain-language rating of the L1 solar wind's ability to drive aurora. */
export function couplingLabel(c) {
  if (c < 2000) return 'Weak';
  if (c < 5000) return 'Moderate';
  if (c < 10000) return 'Strong';
  return 'Very strong';
}

/** Minutes for solar wind to travel from L1 (~1.5 million km) to Earth. */
export function l1TransitMinutes(speedKmS) {
  return 1.5e6 / Math.max(200, speedKmS) / 60;
}

// --------------------------------------------------------- OVATION handling

/** Packs OVATION's [lon, lat, value] triples into a fast lookup grid. */
export function ovationGrid(coordinates) {
  const g = new Float32Array(360 * 181);
  for (const [lon, lat, v] of coordinates) g[(lon % 360) * 181 + (lat + 90)] = v;
  return g;
}

/** Bilinear sample of the OVATION grid (0..100). */
export function sampleOvation(grid, lat, lon) {
  lat = Math.max(-90, Math.min(90, lat));
  lon = ((lon % 360) + 360) % 360;
  const i0 = Math.floor(lon), j0 = Math.min(179, Math.floor(lat + 90));
  const fx = lon - i0, fy = lat + 90 - j0;
  const i1 = (i0 + 1) % 360;
  const a = grid[i0 * 181 + j0], b = grid[i1 * 181 + j0];
  const c = grid[i0 * 181 + j0 + 1], d = grid[i1 * 181 + j0 + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * Rough correction from dipole to corrected geomagnetic (CGM) latitude. The
 * dipole is worst over the North Atlantic, where it puts Iceland ~3.5 deg too
 * far poleward; elsewhere the error is about a degree, which we ignore.
 */
export function cgmLatitude(lat, lon) {
  const m = toMagnetic(lat, lon);
  if (lat < 0) return m.mlat;
  const c = Math.sin(lat * DEG) * Math.sin(64 * DEG) +
    Math.cos(lat * DEG) * Math.cos(64 * DEG) * Math.cos((lon + 20) * DEG);
  const dist = Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
  return m.mlat - 3.5 * Math.exp(-0.5 * (dist / 15) ** 2);
}

/**
 * Climatological auroral oval for a given Kp (after Feldstein / Zhang & Paxton).
 * Returns 0..1, the relative chance of aurora overhead at |CGM lat| and MLT.
 */
export function ovalProfile(absMlat, mltHours, kp) {
  const f = (1 - Math.cos((2 * Math.PI * mltHours) / 24)) / 2; // 0 midnight, 1 noon
  const eq = 66.5 - 1.75 * kp + (75 - 1.5 * kp - (66.5 - 1.75 * kp)) * f;
  const po = 71 - 0.6 * kp + (79 - 0.7 * kp - (71 - 0.6 * kp)) * f;
  let s = 1;
  if (absMlat < eq) s = Math.exp(-0.5 * ((eq - absMlat) / 1.5) ** 2);
  else if (absMlat > po) s = Math.exp(-0.5 * ((absMlat - po) / 2.5) ** 2);
  // Brightest and most frequent around magnetic midnight, weakest at noon.
  return s * (0.3 + 0.7 * (1 - f));
}

/**
 * Builds a forecaster from the latest OVATION nowcast and the Kp forecast.
 *
 * - First ~2 hours: OVATION, which is driven by real-time L1 solar wind. It is
 *   carried forward assuming the oval stays fixed relative to the sun while
 *   the Earth rotates underneath it.
 * - Later: a climatological oval sized by NOAA's 3-day Kp forecast, scaled so
 *   that it matches OVATION's overall level at the nowcast time.
 */
export function makeAuroraModel({ grid, ovationTime, kpSeries }) {
  const t0 = +ovationTime;
  const kp0 = kpAt(kpSeries, t0);
  const sunLon0 = sunMagLon(t0);
  const cache = new Map();

  function context(t) {
    const key = Math.round(+t / 600000); // 10-minute buckets
    let c = cache.get(key);
    if (!c) {
      const sunLon = sunMagLon(t);
      const kp = kpAt(kpSeries, t);
      c = {
        kp,
        sunLon,
        dLon: sunLon0 - sunLon,
        hours: (+t - t0) / 3600000,
        amp: 100 * kpActivity(kp),
      };
      cache.set(key, c);
    }
    return c;
  }

  function climatology(lat, lon, c) {
    const a = Math.abs(cgmLatitude(lat, lon));
    const m = toMagnetic(lat, lon);
    const mltH = ((((12 + (m.mlon - c.sunLon) / 15) % 24) + 24) % 24);
    return c.amp * ovalProfile(a, mltH, c.kp);
  }

  // Scale the climatology to OVATION's level right now (night side, north).
  let num = 0, den = 0;
  const c0 = context(t0);
  for (let lat = 50; lat <= 85; lat += 1) {
    for (let lon = -180; lon < 180; lon += 3) {
      num += sampleOvation(grid, lat, lon);
      den += climatology(lat, lon, c0);
    }
  }
  const calib = Math.min(1.5, Math.max(0.5, den > 0 ? num / den : 1));

  function persistence(lat, lon, c) {
    if (Math.abs(c.dLon) < 1e-6) return sampleOvation(grid, lat, lon);
    const m = toMagnetic(lat, lon);
    const g = fromMagnetic(m.mlat, m.mlon + c.dLon);
    return sampleOvation(grid, g.lat, g.lon);
  }

  /** Probability (0..100) of aurora overhead at (lat, lon) at time t. */
  function overhead(lat, lon, t) {
    const c = context(t);
    const w = c.hours <= 0 ? 1 : Math.exp(-c.hours / 1.5);
    const clim = w > 0.98 ? 0 : calib * climatology(lat, lon, c);
    const pers = w < 0.02 ? 0 : persistence(lat, lon, c);
    return Math.min(100, w * pers + (1 - w) * clim);
  }

  /**
   * Probability (0..100) of seeing aurora from (lat, lon): overhead, or low on the
   * poleward horizon from an oval up to ~6 deg of latitude away.
   */
  function visible(lat, lon, t) {
    let best = overhead(lat, lon, t);
    const dir = lat >= 0 ? 1 : -1;
    for (let k = 1; k <= 6; k++) {
      const v = overhead(lat + dir * k, lon, t) * 0.65 * Math.exp(-(k - 1) / 2.5);
      if (v > best) best = v;
    }
    return best;
  }

  return { kp0, calib, context, overhead, visible };
}

// --------------------------------------------------------- weather & scores

/**
 * Fraction of sky effectively blocked by cloud, 0..1. Low and mid cloud block
 * aurora; thin high cirrus only dims it.
 */
export function cloudBlock({ total, low, mid, high }) {
  if (low == null) return clamp01((total ?? 0) / 100);
  return clamp01(Math.max(low, 0.9 * (mid ?? 0), 0.5 * (high ?? 0)) / 100);
}

/** Combined chance (0..100) of actually seeing aurora. */
export function viewingScore(auroraPct, dark, block) {
  return auroraPct * dark * (1 - block);
}

export function scoreLabel(s) {
  if (s < 5) return 'Unlikely';
  if (s < 15) return 'Low';
  if (s < 30) return 'Possible';
  if (s < 50) return 'Good';
  return 'Excellent';
}
