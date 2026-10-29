import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/model.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}±${tol}, got ${a}`);

test('magnetic coordinates round-trip', () => {
  for (const [lat, lon] of [[64.15, -21.94], [69.6, 18.9], [-45, 170], [10, 100]]) {
    const m = M.toMagnetic(lat, lon);
    const g = M.fromMagnetic(m.mlat, m.mlon);
    near(g.lat, lat, 1e-9);
    near(g.lon, lon, 1e-9);
  }
});

test('geomagnetic pole maps to 90', () => {
  near(M.toMagnetic(M.POLE.lat, M.POLE.lon).mlat, 90, 1e-9);
});

test('Reykjavik CGM latitude is about 65', () => {
  near(M.cgmLatitude(64.15, -21.94), 65, 1);
});

test('sun is high at local noon on the June solstice and below horizon at midnight', () => {
  const noon = Date.UTC(2026, 5, 21, 12, 0);
  near(M.sunAltitude(noon, 51.48, 0), 90 - 51.48 + 23.44, 0.5, 'Greenwich noon altitude');
  assert.ok(M.sunAltitude(Date.UTC(2026, 11, 21, 0, 0), 64.15, -21.94) < -40);
});

test('darkness ramps through twilight', () => {
  assert.equal(M.darkness(5), 0);
  assert.equal(M.darkness(-20), 1);
  near(M.darkness(-9), 0.5, 1e-9);
});

test('magnetic midnight in Iceland is around 00-01 UT', () => {
  const t = Date.UTC(2026, 10, 1, 0, 40);
  const h = M.mlt(t, 64.15, -21.94);
  assert.ok(h < 2 || h > 23, `MLT ${h}`);
});

test('kpAt picks the 3-hour block containing t', () => {
  const s = [{ t: 0, kp: 1 }, { t: 3 * 3600e3, kp: 4 }, { t: 6 * 3600e3, kp: 2 }];
  assert.equal(M.kpAt(s, 1), 1);
  assert.equal(M.kpAt(s, 4 * 3600e3), 4);
  assert.equal(M.kpAt(s, 99 * 3600e3), 2);
});

test('oval moves equatorward with Kp', () => {
  // At magnetic midnight, 60 deg CGM is outside the quiet oval but inside a storm oval.
  assert.ok(M.ovalProfile(60, 0, 1) < 0.05);
  assert.ok(M.ovalProfile(60, 0, 6) > 0.9);
  // Midnight is brighter than noon at the same relative position.
  assert.ok(M.ovalProfile(66, 0, 3) > M.ovalProfile(77, 12, 3));
});

test('southward Bz couples much more strongly than northward', () => {
  const south = M.newellCoupling(450, 0, -8);
  const north = M.newellCoupling(450, 0, 8);
  assert.ok(south > 5000, `south ${south}`);
  assert.ok(north < 1, `north ${north}`);
});

test('OVATION grid sampling and model blending', () => {
  const coords = [];
  for (let lon = 0; lon < 360; lon++) {
    for (let lat = -90; lat <= 90; lat++) coords.push([lon, lat, lat >= 62 && lat <= 70 ? 40 : 0]);
  }
  const grid = M.ovationGrid(coords);
  near(M.sampleOvation(grid, 66, -20), 40, 1e-6);
  near(M.sampleOvation(grid, 40, 100), 0, 1e-6);

  const t0 = Date.UTC(2026, 10, 1, 0, 0);
  const kpSeries = [{ t: t0 - 6 * 3600e3, kp: 2 }, { t: t0 + 12 * 3600e3, kp: 6 }];
  const m = M.makeAuroraModel({ grid, ovationTime: t0, kpSeries });
  near(m.overhead(66, -20, t0), 40, 1e-6, 'nowcast is OVATION');
  // A day later, with Kp 6 forecast, aurora at 58N in Iceland's longitude around midnight.
  assert.ok(m.visible(58, -20, t0 + 24 * 3600e3) > m.visible(58, -20, t0 + 6 * 3600e3));
});

test('cloud blocking weights layers', () => {
  assert.equal(M.cloudBlock({ total: 100, low: 0, mid: 0, high: 100 }), 0.5);
  assert.equal(M.cloudBlock({ total: 80, low: 80, mid: 0, high: 0 }), 0.8);
  assert.equal(M.cloudBlock({ total: 30 }), 0.3);
});

test('viewing score and labels', () => {
  assert.equal(M.viewingScore(60, 1, 0.5), 30);
  assert.equal(M.scoreLabel(M.viewingScore(60, 0, 0)), 'Unlikely');
  assert.equal(M.scoreLabel(55), 'Excellent');
});
