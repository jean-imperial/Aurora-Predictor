import * as M from './model.js';
import * as D from './data.js';

const HOUR = 3600000;
const HORIZON_H = 72;
const SPACE_REFRESH_MS = 5 * 60000;
let forecastMaxHour = HORIZON_H; // last forecast hour the Kp forecast reaches
const APP_VERSION = '1.4.0'; // shown under Data sources so you can tell which build a device is running

const PRESETS = [
  { name: 'Reykjavík – Grótta', lat: 64.1645, lon: -22.0226 },
  { name: 'Þingvellir', lat: 64.2559, lon: -21.1299 },
  { name: 'Kirkjufell', lat: 64.9417, lon: -23.3053 },
  { name: 'Vík', lat: 63.4186, lon: -19.006 },
  { name: 'Jökulsárlón', lat: 64.0484, lon: -16.1806 },
  { name: 'Akureyri', lat: 65.6835, lon: -18.0878 },
];

const COLORS = {
  viewing: [255, 206, 84],
  aurora: [61, 220, 132],
  dark: [122, 162, 255],
  clear: [226, 232, 240],
};

const state = {
  layer: 'viewing',
  hour: 0,
  t0: roundHour(Date.now()),
  model: null,
  kp: [],
  ovation: null,
  wind: null,
  clouds: null,
  cloudsLoading: false,
  fieldCache: new Map(),
  live: null, // { frames: [{ t, sat, radar }], idx, loaded, radar, radarPending }
  point: null,
  weatherCache: new Map(),
  sources: {},
};

function roundHour(t) {
  return Math.floor(t / HOUR) * HOUR;
}

function selectedTime() {
  if (state.layer === 'live' && state.live) return state.live.frames[state.live.idx].t;
  return state.hour === 0 ? Date.now() : state.t0 + state.hour * HOUR;
}

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind}`;
  el.hidden = !msg;
}

// ------------------------------------------------------------------- map

const map = L.map('map', { zoomControl: false, worldCopyJump: true, minZoom: 2 })
  .setView([64.8, -19], 5);
L.control.zoom({ position: 'bottomright' }).addTo(map);
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
L.tileLayer(`${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
  maxZoom: 16,
  attribution: 'Map © Esri, HERE, Garmin, © OpenStreetMap contributors · Space weather: <a href="https://www.swpc.noaa.gov/">NOAA SWPC</a> · Weather: <a href="https://www.ecmwf.int/">ECMWF</a> via <a href="https://open-meteo.com/">Open-Meteo</a>',
}).addTo(map);
// Place names go above the forecast colours so they stay readable.
map.createPane('labels').style.zIndex = 450;
map.getPane('labels').style.pointerEvents = 'none';
L.tileLayer(`${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16, pane: 'labels' }).addTo(map);
// Live satellite cloud sits above the aurora colours, radar above that.
map.createPane('satellite').style.zIndex = 410;
map.createPane('radar').style.zIndex = 420;

/** A canvas layer that colours every pixel from a (lat, lon) -> [r,g,b,a] function. */
const FieldLayer = L.GridLayer.extend({
  options: { step: 4, tileSize: 256, updateWhenZooming: false, opacity: 1 },
  setPainter(fn) {
    this._painter = fn;
    this.redraw();
  },
  createTile(coords) {
    const size = this.getTileSize();
    const tile = document.createElement('canvas');
    tile.width = size.x;
    tile.height = size.y;
    if (!this._painter) return tile;
    const step = this.options.step;
    const w = Math.ceil(size.x / step), h = Math.ceil(size.y / step);
    const small = document.createElement('canvas');
    small.width = w;
    small.height = h;
    const sctx = small.getContext('2d');
    const img = sctx.createImageData(w, h);
    const origin = coords.scaleBy(size);
    const painter = this._painter;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ll = map.unproject(origin.add([x * step + step / 2, y * step + step / 2]), coords.z);
        const c = painter(ll.lat, L.Util.wrapNum(ll.lng, [-180, 180], true));
        if (!c) continue;
        const k = (y * w + x) * 4;
        img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = c[3];
      }
    }
    sctx.putImageData(img, 0, 0);
    const ctx = tile.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(small, 0, 0, size.x, size.y);
    return tile;
  },
});

// Infrared grey levels (bright = cold) -> cloud opacity. Warm sea and ground go
// see-through; cold cloud tops go white. Tuned by eye against Meteosat imagery.
const CLOUD_ALPHA = Uint8Array.from({ length: 256 }, (_, g) => {
  const x = Math.max(0, Math.min(1, (g - 80) / 70));
  return Math.round(Math.pow(x, 0.8) * 0.85 * 255);
});

const field = new FieldLayer({ pane: 'overlayPane' }).addTo(map);
let cloudBox = null;
let marker = null;

// ------------------------------------------------- aurora field per hour

/**
 * Visible-aurora probability on a 1-degree global grid for time t.
 * Computing the grid once per hour keeps map redraws fast.
 */
function auroraField(t) {
  const key = Math.round(t / 600000);
  if (state.fieldCache.has(key)) return state.fieldCache.get(key);
  const m = state.model;
  const W = 361, H = 181;
  const over = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const lat = j - 90;
    if (Math.abs(lat) < 30) continue;
    for (let i = 0; i < W; i++) over[j * W + i] = m.overhead(lat, i - 180, t);
  }
  // Add aurora seen low on the poleward horizon, as in model.visible().
  const vis = new Float32Array(over);
  for (let j = 0; j < H; j++) {
    const lat = j - 90, dir = lat >= 0 ? 1 : -1;
    for (let i = 0; i < W; i++) {
      let best = over[j * W + i];
      for (let k = 1; k <= 6; k++) {
        const jj = j + dir * k;
        if (jj < 0 || jj >= H) break;
        const v = over[jj * W + i] * 0.65 * Math.exp(-(k - 1) / 2.5);
        if (v > best) best = v;
      }
      vis[j * W + i] = best;
    }
  }
  const sample = (lat, lon) => {
    const x = lon + 180, y = lat + 90;
    const i0 = Math.max(0, Math.min(W - 2, Math.floor(x)));
    const j0 = Math.max(0, Math.min(H - 2, Math.floor(y)));
    const fx = x - i0, fy = y - j0;
    const a = vis[j0 * W + i0], b = vis[j0 * W + i0 + 1];
    const c = vis[(j0 + 1) * W + i0], d = vis[(j0 + 1) * W + i0 + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
  if (state.fieldCache.size > 80) state.fieldCache.clear();
  state.fieldCache.set(key, sample);
  return sample;
}

// ------------------------------------------------------------ cloud grid

function cloudAt(lat, lon, t) {
  const g = state.clouds;
  if (!g) return null;
  const { south, north, west, east } = g.bounds;
  if (lat < south || lat > north || lon < west || lon > east) return null;
  const ti = Math.max(0, Math.min(g.times.length - 1, Math.round((t - g.times[0]) / HOUR)));
  const fx = ((lon - west) / (east - west)) * (g.n - 1);
  const fy = ((lat - south) / (north - south)) * (g.n - 1);
  const i0 = Math.min(g.n - 2, Math.floor(fx)), j0 = Math.min(g.n - 2, Math.floor(fy));
  const ax = fx - i0, ay = fy - j0;
  const at = (arr, i, j) => arr[j * g.n + i]?.[ti] ?? 0;
  const bil = (arr) =>
    (at(arr, i0, j0) * (1 - ax) + at(arr, i0 + 1, j0) * ax) * (1 - ay) +
    (at(arr, i0, j0 + 1) * (1 - ax) + at(arr, i0 + 1, j0 + 1) * ax) * ay;
  return { total: bil(g.total), low: bil(g.low), mid: bil(g.mid), high: bil(g.high) };
}

let cloudTimer = null;
function scheduleCloudLoad() {
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(loadCloudsForView, 700);
}

async function loadCloudsForView() {
  const b = map.getBounds();
  const view = {
    south: Math.max(-85, b.getSouth()), north: Math.min(85, b.getNorth()),
    west: b.getWest(), east: b.getEast(),
  };
  if (view.east - view.west > 70 || view.north - view.south > 30) {
    if (!state.clouds) setStatus('Zoom in to load the ECMWF cloud forecast');
    return;
  }
  const n = 12; // 144 points; Open-Meteo allows ~600 locations a minute
  const g = state.clouds;
  if (g) {
    const gb = g.bounds;
    const covers = gb.south <= view.south && gb.north >= view.north && gb.west <= view.west && gb.east >= view.east;
    const spacing = (gb.north - gb.south) / (g.n - 1);
    if (covers && spacing <= (2.5 * (view.north - view.south)) / (n - 1)) return;
  }
  const padLat = (view.north - view.south) * 0.15, padLon = (view.east - view.west) * 0.15;
  const bounds = {
    south: Math.max(-85, view.south - padLat), north: Math.min(85, view.north + padLat),
    west: view.west - padLon, east: view.east + padLon,
  };
  state.cloudsLoading = true;
  setStatus('Loading ECMWF cloud forecast…');
  try {
    state.clouds = await track('ecmwf', D.fetchCloudGrid(bounds, n), (g) => `${g.model}, cloud map ${g.n}×${g.n} points`);
    setStatus('');
    drawCloudBox();
    repaint();
  } catch (e) {
    console.error(e);
    setStatus(`Cloud forecast unavailable: ${explainError(e)}. Pan or zoom to retry.`, 'error');
  } finally {
    state.cloudsLoading = false;
  }
}

function drawCloudBox() {
  if (cloudBox) cloudBox.remove();
  const g = state.clouds;
  if (!g) return;
  const { south, north, west, east } = g.bounds;
  cloudBox = L.rectangle([[south, west], [north, east]], {
    color: '#94a3b8', weight: 1, dashArray: '4 6', fill: false, interactive: false,
  }).addTo(map);
}

// ------------------------------------------------- live satellite + radar

const LIVE_STEP = 10 * 60000;
const LIVE_MAX_AGE = 5 * 60000;

/** Finds which satellite and radar frames exist for the last ~2 hours. */
async function loadLiveFrames() {
  const [sat, radar] = await Promise.allSettled([
    track('satellite', D.fetchSatelliteLatest(), (t) => `latest image ${minutesAgo(t)}`),
    track('radar', D.fetchRadarFrames(), (f) => `${f.length} frames, latest ${minutesAgo(f.at(-1).t)}`),
  ]);
  const satLatest = sat.status === 'fulfilled' ? sat.value : null;
  const radarFrames = radar.status === 'fulfilled' ? radar.value : null;
  if (!satLatest && !radarFrames) throw new Error('neither satellite nor radar loaded. See Data sources');
  // Frames follow the radar times; the satellite image runs ~20-30 min behind,
  // so the newest radar frames reuse the newest satellite image.
  const frames = radarFrames
    ? radarFrames.map((f) => ({ t: f.t, radar: f.url, sat: satLatest && Math.min(f.t, satLatest) }))
    : Array.from({ length: 13 }, (_, i) => {
      const t = satLatest - (12 - i) * LIVE_STEP;
      return { t, radar: null, sat: t };
    });
  return { frames, loaded: Date.now(), partial: !satLatest ? 'satellite' : !radarFrames ? 'radar' : null };
}

let liveLoading = null;
async function openLive() {
  if (state.live && Date.now() - state.live.loaded < LIVE_MAX_AGE) {
    showLiveFrame(state.live.idx);
    refreshSatelliteView();
    return;
  }
  if (liveLoading) return liveLoading;
  setStatus('Loading live satellite and radar…');
  liveLoading = loadLiveFrames()
    .then((lv) => {
      const old = state.live;
      const atLatest = !old || old.idx === old.frames.length - 1;
      state.live = { ...lv, idx: atLatest ? lv.frames.length - 1 : Math.min(old.idx, lv.frames.length - 1), radar: old?.radar, radarPending: old?.radarPending };
      setStatus(lv.partial ? `Live ${lv.partial} unavailable right now, showing the rest. See Data sources.` : '', lv.partial ? 'error' : '');
      if (state.layer !== 'live') return;
      for (const [t, im] of sat.images) {
        if (state.live.frames.some((f) => f.sat === t)) continue;
        if (im.url && im.url !== sat.shownUrl) URL.revokeObjectURL(im.url);
        sat.images.delete(t);
      }
      setSlider();
      showLiveFrame(state.live.idx);
      loadSatellite();
    })
    .catch((e) => {
      console.error(e);
      if (state.layer === 'live') setStatus(`Live view unavailable: ${explainError(e)}.`, 'error');
    })
    .finally(() => { liveLoading = null; });
  return liveLoading;
}

/** Shows live frame i: radar tiles plus the satellite picture for that time. */
function showLiveFrame(i) {
  const lv = state.live;
  lv.idx = i;
  const f = lv.frames[i];
  if (f.sat) {
    if (!sat.box) sat.box = satelliteBox();
    satImage(f.sat);
  }
  drawSatellite();
  showRadar(f.radar);
  repaint();
}

/**
 * Swaps the radar frame. The new tiles load underneath the old ones, which are
 * removed once they're in, so stepping through frames doesn't flash.
 */
function showRadar(url) {
  const lv = state.live;
  if (lv.radarPending && lv.radarPending.frameUrl !== url) { lv.radarPending.remove(); lv.radarPending = null; }
  if ((lv.radarPending ?? lv.radar)?.frameUrl === url && url) return; // already showing or loading it
  if (!url) { lv.radar?.remove(); lv.radar = null; return; }
  const next = L.tileLayer(`${url}/256/{z}/{x}/{y}/2/1_1.png`, {
    pane: 'radar', maxNativeZoom: 7, opacity: 0.85,
    attribution: 'Radar: <a href="https://www.rainviewer.com/">RainViewer</a>',
  });
  next.frameUrl = url;
  lv.radarPending = next;
  next.once('load', () => {
    if (lv.radarPending !== next) return;
    lv.radar?.remove();
    lv.radar = next;
    lv.radarPending = null;
  });
  next.addTo(map);
}

// Satellite pictures: one image per frame covering the view plus a margin, cached
// by time until the map moves outside it. One big picture rather than tiles,
// because EUMETSAT takes about as long to draw a tile as a whole view.
const sat = { box: null, images: new Map(), overlay: null, shownUrl: null };

function satelliteBox() {
  const z = map.getZoom();
  const pb = map.getPixelBounds();
  const size = pb.getSize();
  const pad = size.multiplyBy(0.3);
  const nw = map.unproject(pb.min.subtract(pad), z), se = map.unproject(pb.max.add(pad), z);
  const south = Math.max(-80, se.lat), north = Math.min(80, nw.lat);
  const west = Math.max(-180, nw.lng), east = Math.min(180, se.lng);
  const sw = L.CRS.EPSG3857.project(L.latLng(south, west)), ne = L.CRS.EPSG3857.project(L.latLng(north, east));
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.min(1400, Math.round((size.x + 2 * pad.x) * scale));
  const height = Math.min(1400, Math.round((width * (ne.y - sw.y)) / (ne.x - sw.x)));
  return { bounds: L.latLngBounds([south, west], [north, east]), bbox: [sw.x, sw.y, ne.x, ne.y], width, height, zoom: z };
}

/** Recolours an infrared picture into a white, see-through cloud image and returns its URL. */
async function cloudImageURL(bitmap) {
  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const px = ctx.getImageData(0, 0, c.width, c.height);
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] ? CLOUD_ALPHA[d[i]] : 0;
    d[i] = 236; d[i + 1] = 241; d[i + 2] = 248; d[i + 3] = a;
  }
  ctx.putImageData(px, 0, 0);
  return URL.createObjectURL(await new Promise((resolve) => c.toBlob(resolve)));
}

/** The picture for time t: starts loading it if needed. */
function satImage(t) {
  let im = sat.images.get(t);
  if (im) return im;
  const box = sat.box;
  im = { status: 'loading', bounds: box.bounds };
  im.promise = D.fetchSatelliteImage({ ...box, time: t })
    .then(cloudImageURL)
    .then((url) => {
      im.url = url;
      im.status = 'ok';
    })
    .catch((e) => {
      console.error('Satellite picture failed', e);
      im.status = 'error';
      im.error = e;
      if (sat.images.get(t) === im) sat.images.delete(t); // asked for again on the next slider move or pan
      if (state.live?.frames[state.live.idx].sat === t && state.layer === 'live') {
        setStatus(`Satellite picture failed: ${explainError(e)}. Move the slider or map to retry.`, 'error');
      }
    })
    .finally(() => drawSatellite());
  sat.images.set(t, im);
  return im;
}

/** Loads the current frame's picture, then the rest (newest first) so playback is smooth. */
async function loadSatellite() {
  const lv = state.live;
  const box = sat.box;
  const current = lv.frames[lv.idx].sat;
  if (current) await satImage(current).promise;
  const queue = [...new Set(lv.frames.map((f) => f.sat).filter(Boolean))].reverse();
  const worker = async () => {
    while (queue.length && sat.box === box && state.layer === 'live') {
      const t = queue.shift();
      if (!sat.images.has(t)) await satImage(t).promise;
    }
  };
  await Promise.all([worker(), worker()]); // two at a time, to go easy on EUMETSAT
}

function drawSatellite() {
  if (state.layer !== 'live' || !state.live) return;
  const f = state.live.frames[state.live.idx];
  const im = f.sat && sat.images.get(f.sat);
  if (!f.sat) {
    sat.overlay?.remove();
    sat.overlay = sat.shownUrl = null;
  } else if (im?.status === 'ok') {
    if (!sat.overlay) {
      sat.overlay = L.imageOverlay(im.url, im.bounds, {
        pane: 'satellite', attribution: 'Satellite: <a href="https://view.eumetsat.int/">EUMETSAT</a>',
      }).addTo(map);
    } else if (sat.shownUrl !== im.url) {
      sat.overlay.setUrl(im.url).setBounds(im.bounds);
      // A picture from before the last pan is no longer cached, so free it.
      if (![...sat.images.values()].some((x) => x.url === sat.shownUrl)) URL.revokeObjectURL(sat.shownUrl);
    }
    sat.shownUrl = im.url;
  }
  updateTimeLabel();
}

/** After a pan or zoom, fetches new pictures if the view has left the old ones. */
function refreshSatelliteView() {
  if (state.layer !== 'live' || !state.live || !sat.box) return;
  const box = sat.box;
  if (box.bounds.contains(map.getBounds()) && Math.abs(map.getZoom() - box.zoom) < 1) return;
  for (const im of sat.images.values()) if (im.url && im.url !== sat.shownUrl) URL.revokeObjectURL(im.url);
  sat.images = new Map();
  sat.box = satelliteBox();
  loadSatellite();
}

let satTimer = null;
map.on('moveend', () => {
  clearTimeout(satTimer);
  satTimer = setTimeout(refreshSatelliteView, 600);
});

function closeLive() {
  const lv = state.live;
  if (!lv) return;
  for (const layer of [lv.radar, lv.radarPending, sat.overlay]) layer?.remove();
  lv.radar = lv.radarPending = sat.overlay = sat.shownUrl = null;
}

/** The time slider steps through forecast hours, or through live frames on the Live layer. */
function setSlider() {
  const el = $('time');
  if (state.layer === 'live' && state.live) {
    el.max = String(state.live.frames.length - 1);
    el.value = String(state.live.idx);
    el.setAttribute('aria-label', 'Observation time');
  } else {
    el.max = String(forecastMaxHour);
    el.value = String(state.hour);
    el.setAttribute('aria-label', 'Forecast hour');
  }
}

// --------------------------------------------------------------- painting

const ramp = (rgb, v, full, max = 0.7) => {
  const a = Math.min(max, Math.pow(Math.max(0, v) / full, 0.7)); // lift faint values
  return a < 0.02 ? null : [rgb[0], rgb[1], rgb[2], Math.round(a * 255)];
};

function repaint() {
  updateTimeLabel();
  renderLegend();
  if (!state.model) return;
  const t = selectedTime();
  const s = M.sun(t);
  const aur = auroraField(t);
  const painters = {
    aurora: (lat, lon) => {
      const v = aur(lat, lon);
      const c = ramp(COLORS.aurora, v, 80);
      if (!c) return null;
      // Dim where it's daylight - the aurora is there, but you can't see it.
      if (M.darkness(M.sunAltitude(t, lat, lon, s)) < 0.5) c[3] = Math.round(c[3] * 0.35);
      return c;
    },
    clouds: (lat, lon) => {
      const c = cloudAt(lat, lon, t);
      if (!c) return null;
      const v = M.cloudBlock(c) * 100;
      return v < 5 ? null : [226, 232, 240, Math.round(Math.min(0.8, v / 110) * 255)];
    },
    live: (lat, lon) => {
      // Aurora at the frame's time, under the observed cloud.
      const c = ramp(COLORS.aurora, aur(lat, lon), 80);
      if (c && M.darkness(M.sunAltitude(t, lat, lon, s)) < 0.5) c[3] = Math.round(c[3] * 0.35);
      return c;
    },
    viewing: (lat, lon) => {
      const dark = M.darkness(M.sunAltitude(t, lat, lon, s));
      if (dark <= 0) return null;
      const c = cloudAt(lat, lon, t);
      const v = aur(lat, lon) * dark * (c ? 1 - M.cloudBlock(c) : 1);
      const col = ramp(COLORS.viewing, v, 50);
      if (col && !c) col[3] = Math.round(col[3] * 0.4); // clouds unknown here
      return col;
    },
  };
  field.setPainter(painters[state.layer]);
}

// RainViewer's "Universal Blue" scheme, light drizzle to heavy showers.
const RADAR_GRADIENT = 'linear-gradient(90deg, #9ad8f0, #2a9fd6, #0b5fa5, #f5e04a, #f08a24, #e0301e)';

function renderLegend() {
  $('legend').classList.toggle('live', state.layer === 'live');
  if (state.layer === 'live') {
    $('legend').innerHTML = `
      <div class="legend-title">Live cloud and rain</div>
      <div class="legend-bar" style="background:linear-gradient(90deg, rgba(${COLORS.clear},0), rgba(${COLORS.clear},.9))"></div>
      <div class="legend-scale"><span>clear</span><span>cloud</span></div>
      <div class="legend-bar" style="background:${RADAR_GRADIENT}"></div>
      <div class="legend-scale"><span>light</span><span>heavy</span></div>
      <div class="legend-note">satellite IR + radar, aurora in green</div>`;
    return;
  }
  const items = {
    viewing: ['Viewing chance', COLORS.viewing, '0', '50%+', 'aurora × darkness × clear sky'],
    aurora: ['Aurora probability', COLORS.aurora, '0', '80%+', 'faded where it is daylight'],
    clouds: ['ECMWF cloud', COLORS.clear, '0', '100%', 'low + mid weighted, cirrus half'],
  }[state.layer];
  const [title, c, lo, hi, note] = items;
  $('legend').innerHTML = `
    <div class="legend-title">${title}</div>
    <div class="legend-bar" style="background:linear-gradient(90deg, rgba(${c},0), rgba(${c},.9))"></div>
    <div class="legend-scale"><span>${lo}</span><span>${hi}</span></div>
    <div class="legend-note">${note}</div>`;
}

const fmtTime = (t, tz, opts = {}) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz, ...opts }).format(t);

function updateTimeLabel() {
  if (state.layer === 'live') {
    const f = state.live?.frames[state.live.idx];
    const hm = (x) => fmtTime(x, undefined, { weekday: undefined });
    const im = f?.sat && sat.images.get(f.sat);
    // Phones only have room for the frame time; the satellite time shows on wider screens.
    $('timeLabel').textContent = !f ? 'Live · loading…'
      : isMobile() || !f.radar || !f.sat ? `Live ${hm(f.t)}`
        : `Radar ${hm(f.t)} · satellite ${hm(f.sat)}`;
    $('timeKp').textContent = !f ? ''
      : f.sat && im?.status !== 'ok' ? (isMobile() ? ' · loading…' : ' · loading satellite…')
        : ` · ${minutesAgo(f.t).replace(' old', ' ago')}`;
    return;
  }
  const t = selectedTime();
  const now = isMobile() ? fmtTime(t, undefined, { weekday: undefined }) : fmtTime(t); // phones: save width
  const ahead = isMobile() ? '' : ` (+${state.hour} h)`;
  $('timeLabel').textContent = state.hour === 0 ? `Now · ${now}` : `${fmtTime(t)}${ahead}`;
  $('timeKp').textContent = state.kp.length ? ` · Kp ${M.kpAt(state.kp, t).toFixed(1)}` : '';
}

// ------------------------------------------------------- space weather UI

function sparkline(series, { zero = false, w = 220, h = 44 } = {}) {
  if (series.length < 2) return '';
  const xs = series.map((p) => p.t), ys = series.map((p) => p.v);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (zero) { y0 = Math.min(y0, -1); y1 = Math.max(y1, 1); }
  const sx = (x) => ((x - x0) / (x1 - x0 || 1)) * (w - 4) + 2;
  const sy = (y) => h - 2 - ((y - y0) / (y1 - y0 || 1)) * (h - 4);
  const pts = series.map((p) => `${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ');
  const zl = zero ? `<line x1="0" x2="${w}" y1="${sy(0)}" y2="${sy(0)}" class="spark-zero"/>` : '';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${zl}<polyline points="${pts}"/></svg>`;
}

function renderSpaceWeather() {
  const w = state.wind;
  const kpNow = state.kp.length ? M.kpAt(state.kp, Date.now()) : null;
  if (!w) return;
  const coupling = M.newellCoupling(w.speed ?? 400, w.by ?? 0, w.bz ?? 0);
  const label = M.couplingLabel(coupling);
  const eta = M.l1TransitMinutes(w.speed ?? 400);
  const age = Math.round((Date.now() - Math.max(w.magTime ?? 0, w.windTime ?? 0)) / 60000);
  const level = { Weak: 0, Moderate: 1, Strong: 2, 'Very strong': 3 }[label];
  $('swDot').dataset.level = level;
  $('swSummary').innerHTML = `<span class="sw-prefix">Solar wind: </span><b>${label}</b> · Bz ${fmt(w.bz, 1)} nT · Kp ${kpNow?.toFixed(1) ?? '–'}`;
  const ovAge = state.ovation ? Math.round((Date.now() - state.ovation.observed) / 60000) : null;
  $('swData').innerHTML = `
    <div class="sw-grid">
      <div><div class="k">Bz (north–south field)</div><div class="v ${w.bz < 0 ? 'south' : ''}">${fmt(w.bz, 1)} <small>nT</small></div></div>
      <div><div class="k">Speed</div><div class="v">${fmt(w.speed, 0)} <small>km/s</small></div></div>
      <div><div class="k">Density</div><div class="v">${fmt(w.density, 1)} <small>p/cm³</small></div></div>
      <div><div class="k">Bt</div><div class="v">${fmt(w.bt, 1)} <small>nT</small></div></div>
    </div>
    <div class="k">Bz, last 6 h <span class="muted">(below the line = southward = good for aurora)</span></div>
    ${sparkline(w.bzSeries, { zero: true })}
    <div class="k">Speed, last 6 h</div>
    ${sparkline(w.speedSeries)}
    <p class="small">Measured by <b>${w.spacecraft}</b> at L1, ${age} min ago.${w.staleActive
      ? ` NOAA's operational spacecraft (${w.staleActive}) has a gap in its data, so a fresher one is used.` : ''} Solar wind at this speed takes
    about <b>${Math.round(eta)} min</b> to reach Earth. NOAA OVATION nowcast is from ${ovAge ?? '–'} min ago.</p>`;
}

const fmt = (v, d) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));

// ------------------------------------------------------ data source status

const SOURCES = {
  wind: 'L1 solar wind (NOAA real-time)',
  ovation: 'OVATION aurora nowcast (NOAA)',
  kp: 'Kp 3-day forecast (NOAA)',
  ecmwf: 'ECMWF weather (Open-Meteo)',
  satellite: 'Meteosat infrared cloud (EUMETSAT)',
  radar: 'Precipitation radar (RainViewer)',
};

// Sources that only load on demand, and what to say until they do.
const ON_DEMAND = {
  ecmwf: 'loads when you zoom in or tap a spot',
  satellite: 'loads when you open Live',
  radar: 'loads when you open Live',
};

const minutesAgo = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 120 ? `${m} min old` : `${Math.round(m / 60)} h old`;
};

function explainError(e) {
  if (e?.name === 'AbortError') return 'timed out with no reply (server slow or unreachable)';
  if (e instanceof TypeError && /fetch|network|load/i.test(e.message)) {
    return navigator.onLine === false
      ? 'device is offline'
      : 'request blocked or no connection (check Wi-Fi, VPN, proxy or ad-blocker)';
  }
  return (e?.message ?? String(e)).replace(/[.\s]+$/, ''); // callers add their own punctuation
}

/** Runs a fetch while recording its progress, timing and outcome for the status list. */
async function track(key, promise, describe) {
  const started = performance.now();
  state.sources[key] = { status: 'loading', detail: 'loading…' };
  renderSources();
  const slow = setTimeout(() => {
    if (state.sources[key]?.status !== 'loading') return;
    state.sources[key].detail = 'still waiting after 8 s…';
    renderSources();
  }, 8000);
  try {
    const v = await promise;
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    state.sources[key] = { status: 'ok', detail: `${describe ? describe(v) + ' · ' : ''}loaded in ${secs} s`, at: Date.now() };
    return v;
  } catch (e) {
    console.error(`${SOURCES[key]} failed`, e);
    state.sources[key] = { status: 'error', detail: explainError(e) };
    if (!ON_DEMAND[key]) setSpaceCardOpen(true); // show what went wrong
    throw e;
  } finally {
    clearTimeout(slow);
    renderSources();
  }
}

function renderSources() {
  const icon = { loading: '⏳', ok: '✓', error: '✕' };
  $('swSources').innerHTML = Object.entries(SOURCES).map(([key, name]) => {
    const s = state.sources[key] ?? { status: 'idle', detail: ON_DEMAND[key] ?? 'waiting' };
    return `<li class="src-${s.status}"><span class="src-icon" aria-hidden="true">${icon[s.status] ?? '·'}</span>
      <span><b>${name}</b><br><span class="small">${s.detail}</span></span></li>`;
  }).join('');

  const dpr = Math.round(window.devicePixelRatio * 10) / 10;
  $('swEnv').textContent = `App ${APP_VERSION} · ${isMobile() ? 'phone' : 'desktop'} layout · ` +
    `screen ${window.innerWidth}×${window.innerHeight} px at ${dpr}× pixel density`;

  if (state.wind) return; // the summary line shows live values once we have them
  const w = state.sources.wind;
  if (w?.status === 'error') {
    $('swDot').dataset.level = 'error';
    $('swSummary').innerHTML = `<span class="error">L1 solar wind failed: ${w.detail}</span>`;
  } else {
    const ready = ['wind', 'ovation', 'kp'].filter((k) => state.sources[k]?.status === 'ok').length;
    $('swSummary').textContent = `Loading space weather… ${ready} of 3 sources ready`;
  }
}

let loadingSpace = false;
async function loadSpaceWeather() {
  if (loadingSpace) return;
  loadingSpace = true;
  // Solar wind and the aurora model load independently so one slow feed can't block the other.
  const wind = track('wind', D.fetchSolarWind(), (w) => `${w.spacecraft}, data ${minutesAgo(Math.max(w.magTime ?? 0, w.windTime ?? 0))}`)
    .then((w) => {
      const first = !state.wind;
      state.wind = w;
      renderSpaceWeather();
      // The card starts open to show loading progress, and folds away once data is in.
      if (first) setSpaceCardOpen(false);
    })
    .catch(() => {
      if (state.wind) renderSpaceWeather(); // keep showing the last good values
    });
  const aurora = Promise.all([
    track('ovation', D.fetchOvation(), (o) => `nowcast ${minutesAgo(o.observed)}`),
    track('kp', D.fetchKp(), (k) => `${k.length} values, to ${fmtTime(k.at(-1).t)}`),
  ])
    .then(([ov, kp]) => {
      state.ovation = ov;
      state.kp = kp;
      state.model = M.makeAuroraModel({ grid: M.ovationGrid(ov.coordinates), ovationTime: ov.forecast, kpSeries: kp });
      state.fieldCache.clear();
      state.t0 = roundHour(Date.now());
      const lastKp = kp.at(-1)?.t ?? state.t0;
      forecastMaxHour = Math.max(1, Math.min(HORIZON_H, Math.floor((lastKp + 3 * HOUR - state.t0) / HOUR)));
      state.hour = Math.min(state.hour, forecastMaxHour);
      setSlider();
      if (state.wind) renderSpaceWeather();
      repaint();
      if (state.point) renderPoint();
    })
    .catch(() => {
      setStatus(state.model
        ? 'NOAA aurora update failed, showing the previous forecast. See Data sources.'
        : 'Aurora forecast unavailable: NOAA data did not load. See Data sources.', 'error');
    });
  await Promise.all([wind, aurora]);
  loadingSpace = false;
}

// ----------------------------------------------------------- point panel

async function selectPoint(lat, lon, name, zoom) {
  lon = L.Util.wrapNum(lon, [-180, 180], true);
  state.point = { lat, lon, name, weather: null };
  if (marker) marker.setLatLng([lat, lon]);
  else marker = L.circleMarker([lat, lon], { radius: 8, color: '#fff', weight: 2, fillColor: '#ffce54', fillOpacity: 1 }).addTo(map);
  const wasHidden = $('panel').hidden;
  $('panel').hidden = false;
  document.body.classList.add('has-panel');
  if (isMobile() && wasHidden) setSheet('peek');
  focusMap(lat, lon, zoom);
  $('placeName').textContent = name ?? 'Selected spot';
  $('placeCoords').textContent = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
  $('panelBody').innerHTML = '<p class="muted">Loading ECMWF forecast…</p>';
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  try {
    let wx = state.weatherCache.get(key);
    if (!wx || Date.now() - wx.fetched > 30 * 60000) {
      wx = { ...(await track('ecmwf', D.fetchPointWeather(lat, lon), (w) => `${w.model}, forecast for selected spot`)), fetched: Date.now() };
      state.weatherCache.set(key, wx);
    }
    if (state.point?.lat !== lat || state.point?.lon !== lon) return;
    state.point.weather = wx;
    renderPoint();
  } catch (e) {
    console.error(e);
    $('panelBody').innerHTML = `<p class="error">Could not load the ECMWF forecast (${explainError(e)}). Tap the spot again in a minute.</p>`;
  }
}

function pointHours() {
  const p = state.point;
  if (!p?.weather || !state.model) return [];
  const now = Date.now();
  const end = state.t0 + forecastMaxHour * HOUR;
  return p.weather.hours
    .filter((h) => h.t >= roundHour(now) && h.t <= end)
    .map((h) => {
      const t = h.t === roundHour(now) ? now : h.t;
      const aurora = state.model.visible(p.lat, p.lon, t);
      const dark = M.darkness(M.sunAltitude(t, p.lat, p.lon));
      const block = M.cloudBlock(h);
      return { ...h, aurora, dark, block, kp: M.kpAt(state.kp, t), score: M.viewingScore(aurora, dark, block) };
    });
}

function renderPoint() {
  const p = state.point;
  if (!p?.weather) return;
  const tz = p.weather.timezone;
  const hours = pointHours();
  if (!hours.length) return;
  const now = hours[0];
  const nights = bestPerNight(hours, tz);
  const nowLabel = M.scoreLabel(now.score);
  $('panelBody').innerHTML = `
    <div class="now-card">
      <div class="now-score"><div class="big">${Math.round(now.score)}<small>%</small></div><div class="lbl">${nowLabel} right now</div></div>
      <ul class="now-facts">
        <li><span>Aurora activity</span><b>${Math.round(now.aurora)}%</b></li>
        <li><span>Darkness</span><b>${darkWord(now.dark)}</b></li>
        <li><span>Cloud (effective)</span><b>${Math.round(now.block * 100)}%</b></li>
        <li><span>Feels like</span><b>${fmt(now.feels, 0)}°C · ${fmt(now.wind, 0)} km/h</b></li>
      </ul>
    </div>
    <h2>Best time each night</h2>
    <ol class="nights">${nights.map((n) => `
      <li><span class="night-day">${n.label}</span>
        <span class="night-time">${n.best ? fmtTime(n.best.t, tz, { weekday: undefined }) : '–'}</span>
        <span class="pill" data-l="${n.best ? M.scoreLabel(n.best.score) : 'Unlikely'}">${n.best ? `${M.scoreLabel(n.best.score)} · ${Math.round(n.best.score)}%` : 'No dark clear hours'}</span>
        ${n.best ? `<span class="muted night-why">Kp ${n.best.kp.toFixed(1)} · cloud ${Math.round(n.best.block * 100)}% · ${fmt(n.best.temp, 0)}°C</span>` : ''}
      </li>`).join('')}</ol>
    <h2>Hour by hour <span class="muted">(${tzLabel(tz)})</span></h2>
    ${stripChart(hours, tz)}
    <div class="tip" id="tip" hidden></div>
    <details class="about">
      <summary>How this is worked out</summary>
      <p><b>Viewing chance</b> = aurora probability × darkness × clear sky.</p>
      <p><b>Aurora</b>: for the next ~2 hours, NOAA's OVATION model, driven by solar wind measured at L1. After that,
      an auroral oval sized by NOAA's 3-day Kp forecast. Includes aurora low on the northern horizon.</p>
      <p><b>Cloud</b>: ECMWF IFS (${p.weather.model === 'ecmwf_ifs' ? '9 km' : '25 km'}) via Open-Meteo. Low and mid
      cloud count fully, thin high cloud counts half.</p>
      <p>Kp forecasts more than a day ahead are rough, and solar wind gusts can't be predicted more than about an hour ahead.
      Go out if the sky is clear and dark, and check again often.</p>
    </details>`;
  wireStrip(hours, tz);
}

function darkWord(d) {
  if (d >= 0.99) return 'Dark';
  if (d > 0) return 'Twilight';
  return 'Daylight';
}

function tzLabel(tz) {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(Date.now()).find((x) => x.type === 'timeZoneName')?.value ?? tz;
  } catch {
    return tz;
  }
}

/** Groups hours into nights (noon to noon, local time) and picks the best hour of each. */
function bestPerNight(hours, tz) {
  const dayKey = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(t - 12 * HOUR);
  const groups = new Map();
  for (const h of hours) {
    const k = dayKey(h.t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  }
  return [...groups.entries()].map(([evening, g]) => {
    const dark = g.filter((h) => h.dark > 0);
    const best = dark.reduce((a, b) => (!a || b.score > a.score ? b : a), null);
    const label = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
      .format(Date.parse(`${evening}T12:00:00Z`));
    return { label: `Night of ${label}`, best };
  });
}

const ROWS = [
  ['score', 'Viewing', COLORS.viewing, 50],
  ['aurora', 'Aurora', COLORS.aurora, 50],
  ['dark', 'Dark', COLORS.dark, 1],
  ['clear', 'Clear', COLORS.clear, 1],
];

// Wider, taller cells on phones so a fingertip can pick out an hour.
const stripDims = () => (isMobile() ? { cw: 12, rh: 26, lw: 66 } : { cw: 7, rh: 18, lw: 54 });

function stripChart(hours, tz) {
  const { cw, rh, lw } = stripDims();
  const gap = 2, top = 18;
  const W = lw + hours.length * cw, Hh = top + ROWS.length * (rh + gap);
  let cells = '';
  ROWS.forEach(([key, , rgb, full], r) => {
    hours.forEach((h, i) => {
      const v = key === 'clear' ? 1 - h.block : h[key];
      const a = Math.max(0.06, Math.min(1, v / full));
      cells += `<rect x="${lw + i * cw}" y="${top + r * (rh + gap)}" width="${cw - 1}" height="${rh}" rx="1.5" fill="rgb(${rgb})" fill-opacity="${a.toFixed(2)}"/>`;
    });
  });
  const labels = ROWS.map(([, name], r) =>
    `<text x="0" y="${top + r * (rh + gap) + rh / 2 + 4}" class="strip-label">${name}</text>`).join('');
  let ticks = '';
  hours.forEach((h, i) => {
    const hr = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(h.t));
    if (hr === 0) {
      const d = new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short' }).format(h.t);
      ticks += `<line x1="${lw + i * cw - 0.5}" x2="${lw + i * cw - 0.5}" y1="2" y2="${Hh}" class="strip-midnight"/><text x="${lw + i * cw + 2}" y="10" class="strip-tick">${d}</text>`;
    } else if (hr === 12) {
      ticks += `<text x="${lw + i * cw + 2}" y="10" class="strip-tick muted">12:00</text>`;
    }
  });
  return `<div class="strip-wrap"><svg class="strip" id="strip" viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" role="img" aria-label="Hourly viewing chance, aurora, darkness and clear sky">${ticks}${labels}${cells}<rect id="stripHover" class="strip-hover" x="0" y="${top - 2}" width="${cw + 1}" height="${Hh - top + 2}" rx="2" visibility="hidden"/></svg></div>`;
}

function wireStrip(hours, tz) {
  const svg = $('strip'), tip = $('tip'), hl = $('stripHover');
  const { cw, lw } = stripDims();
  const show = (evt) => {
    const pt = svg.getBoundingClientRect();
    const x = ((evt.clientX - pt.left) / pt.width) * svg.viewBox.baseVal.width;
    const i = Math.floor((x - lw) / cw);
    const h = hours[i];
    if (!h) { hide(); return; }
    hl.setAttribute('x', lw + i * cw - 1);
    hl.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.innerHTML = `<b>${fmtTime(h.t, tz)}</b> · ${M.scoreLabel(h.score)} ${Math.round(h.score)}%<br>
      Aurora ${Math.round(h.aurora)}% (Kp ${h.kp.toFixed(1)}) · ${darkWord(h.dark)}<br>
      Cloud ${Math.round(h.total)}% (low ${Math.round(h.low)} / mid ${Math.round(h.mid)} / high ${Math.round(h.high)})<br>
      ${fmt(h.temp, 0)}°C, feels ${fmt(h.feels, 0)}°C · wind ${fmt(h.wind, 0)} km/h${h.precip > 0 ? ` · ${h.precip} mm` : ''}`;
  };
  const hide = () => { tip.hidden = true; hl.setAttribute('visibility', 'hidden'); };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
}

// ------------------------------------------------------------- controls

document.querySelectorAll('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    const was = state.layer;
    state.layer = b.dataset.layer;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    if (was === 'live' && state.layer !== 'live') closeLive();
    setSlider();
    repaint();
    if (state.layer === 'live') openLive();
  }));

$('time').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  if (state.layer === 'live') {
    if (state.live) showLiveFrame(v);
    return;
  }
  state.hour = v;
  repaint();
});

let playTimer = null;
$('play').addEventListener('click', () => {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
    $('play').textContent = '▶';
    return;
  }
  $('play').textContent = '❚❚';
  playTimer = setInterval(() => {
    if (state.layer === 'live') {
      if (!state.live) return;
      const n = state.live.frames.length;
      showLiveFrame((state.live.idx + 1) % n);
      $('time').value = String(state.live.idx);
      return;
    }
    state.hour = (state.hour + 1) % (forecastMaxHour + 1);
    $('time').value = String(state.hour);
    repaint();
  }, 700);
});

function setSpaceCardOpen(open) {
  $('spacewxBody').hidden = !open;
  $('spacewxToggle').setAttribute('aria-expanded', String(open));
}

$('spacewxToggle').addEventListener('click', () => setSpaceCardOpen($('spacewxBody').hidden));

$('swRetry').addEventListener('click', () => {
  loadSpaceWeather();
  if (state.point) selectPoint(state.point.lat, state.point.lon, state.point.name);
});

function closePanel() {
  $('panel').hidden = true;
  document.body.classList.remove('has-panel', 'sheet-full');
  state.point = null;
  if (marker) { marker.remove(); marker = null; }
}

$('panelClose').addEventListener('click', closePanel);


map.on('click', (e) => selectPoint(e.latlng.lat, e.latlng.lng));
map.on('moveend', scheduleCloudLoad);

$('presets').innerHTML = PRESETS.map((p, i) => `<button class="chip" data-i="${i}">${p.name}</button>`).join('');
$('presets').addEventListener('click', (e) => {
  const p = PRESETS[e.target.dataset.i];
  if (!p) return;
  selectPoint(p.lat, p.lon, p.name, Math.max(map.getZoom(), 8));
});

$('locate').addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('Location is not available on this device', 'error');
  setStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setStatus('');
      const { latitude, longitude } = pos.coords;
      selectPoint(latitude, longitude, 'My location', Math.max(map.getZoom(), 9));
    },
    () => setStatus('Could not get your location (permission denied?)', 'error'),
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 },
  );
});

// ------------------------------------------------------------------ help

const help = $('help');
$('helpOpen').addEventListener('click', () => help.showModal());
$('helpClose').addEventListener('click', () => help.close());
help.addEventListener('click', (e) => { if (e.target === help) help.close(); }); // tap outside to close

// Show the guide once on a first visit.
try {
  if (!localStorage.getItem('helpSeen')) {
    help.showModal();
    localStorage.setItem('helpSeen', '1');
  }
} catch { /* storage blocked: just don't auto-open */ }

// --------------------------------------------------------- mobile layout

// "Mobile" means a narrow screen, not a phone user-agent: a narrow desktop window
// gets the phone layout too, and tablets keep the desktop one.
const mobileQuery = matchMedia('(max-width: 720px)');
function isMobile() {
  return mobileQuery.matches;
}

const SNAPS = ['peek', 'half', 'full'];
const sheet = { snap: 'peek', drag: null };

function snapHeights() {
  const vh = window.innerHeight;
  return { peek: Math.min(300, vh * 0.45), half: vh * 0.6, full: vh * 0.92 };
}

function setSheetHeight(h) {
  $('panel').style.height = `${h}px`;
  document.body.style.setProperty('--sheet-h', `${h}px`);
  document.body.classList.toggle('sheet-full', h > window.innerHeight * 0.75);
}

function setSheet(snap) {
  sheet.snap = snap;
  setSheetHeight(snapHeights()[snap]);
}

/**
 * Moves the map to a selected spot. On phones the spot goes in the middle of the
 * strip of map left visible above the sheet, and a tapped spot that is already
 * visible stays put.
 */
function focusMap(lat, lon, zoom) {
  if (!isMobile()) {
    if (zoom != null) map.setView([lat, lon], zoom);
    return;
  }
  const size = map.getSize();
  const top = 110; // top bar + solar wind pill
  const bottom = size.y - snapHeights()[sheet.snap] - 100; // sheet + time bar
  const target = top + Math.max(40, bottom - top) / 2;
  if (zoom == null) {
    const y = map.latLngToContainerPoint([lat, lon]).y;
    if (y > top + 20 && y < bottom - 20) return;
  }
  const z = zoom ?? map.getZoom();
  const centre = map.unproject(map.project([lat, lon], z).add([0, size.y / 2 - target]), z);
  map.setView(centre, z);
}

function applyLayout() {
  const mobile = isMobile();
  document.body.classList.toggle('mobile', mobile);
  if (mobile && !$('panel').hidden) {
    setSheet(sheet.snap);
  } else {
    $('panel').style.height = '';
    document.body.style.removeProperty('--sheet-h');
    document.body.classList.remove('sheet-full');
  }
  updateTimeLabel();
  renderSources();
  if (state.point?.weather) renderPoint(); // strip chart cell size depends on layout
}

const handle = $('panelHandle');
handle.addEventListener('pointerdown', (e) => {
  if (!isMobile() || e.target.closest('button')) return;
  sheet.drag = { y: e.clientY, h: $('panel').getBoundingClientRect().height, moved: false };
  $('panel').classList.add('dragging');
  handle.setPointerCapture(e.pointerId);
});
handle.addEventListener('pointermove', (e) => {
  const d = sheet.drag;
  if (!d) return;
  const dy = d.y - e.clientY;
  if (Math.abs(dy) > 6) d.moved = true;
  if (d.moved) setSheetHeight(Math.max(120, Math.min(window.innerHeight * 0.92, d.h + dy)));
});
const endDrag = () => {
  const d = sheet.drag;
  if (!d) return;
  sheet.drag = null;
  $('panel').classList.remove('dragging');
  if (!d.moved) {
    // A tap on the handle steps through peek -> half -> full -> peek.
    setSheet(SNAPS[(SNAPS.indexOf(sheet.snap) + 1) % SNAPS.length]);
    return;
  }
  const h = $('panel').getBoundingClientRect().height;
  const heights = snapHeights();
  if (h < heights.peek - 70) return closePanel(); // flicked down past peek
  const nearest = SNAPS.reduce((a, b) => (Math.abs(heights[b] - h) < Math.abs(heights[a] - h) ? b : a));
  setSheet(nearest);
};
handle.addEventListener('pointerup', endDrag);
handle.addEventListener('pointercancel', endDrag);

mobileQuery.addEventListener('change', applyLayout);
window.addEventListener('resize', () => {
  if (isMobile() && !$('panel').hidden && !sheet.drag) setSheet(sheet.snap);
});

// ------------------------------------------------------------------ boot

applyLayout();
renderLegend();
updateTimeLabel();
renderSources();
window.__auroraStarted = true; // tells the startup watchdog in index.html we're running
loadSpaceWeather().then(scheduleCloudLoad);
setInterval(() => {
  loadSpaceWeather();
  if (state.layer === 'live') openLive(); // picks up new frames once the current list is 5 min old
}, SPACE_REFRESH_MS);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker not registered', e));
}
