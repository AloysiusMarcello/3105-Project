// Port of DetectorsTest.kt, StepLengthTest.kt and GuidanceTest.kt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EndAction, TurnDir, landmark, makeRoute, parseRoute, segment } from '../js/core/route.js';
import { LandmarkConfirmer, matchesLandmark, matchesText } from '../js/core/landmark.js';
import {
  AccelStepDetector, GRAVITY, StepAmplitudeTracker, StepLengthModel, TurnDetector, angleDiff,
} from '../js/core/detectors.js';
import { Maneuver, RouteGeometry, buildGuidance } from '../js/core/guidance.js';
import { NavState } from '../js/core/engine.js';
import { readFileSync } from 'node:fs';

const near = (actual, expected, tol) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected} ± ${tol}, got ${actual}`);

// ---------------------------------------------------------------- LandmarkMatcher

test('matches plain and spaced text', () => {
  assert.ok(matchesText('E3-06-02', 'E3-06-02'));
  assert.ok(matchesText('e3 06 02', 'E3-06-02'));
  assert.ok(matchesText('Tutorial Room E3-06-02', 'E3-06-02'));
});

test('folds common OCR confusions', () => {
  assert.ok(matchesText('E3-O6-O2', 'E3-06-02'));
  assert.ok(matchesText('E3-06-0Z', 'E3-06-02'));
  assert.ok(matchesText('E3-D6-O2', 'E3-06-02'));
  assert.ok(matchesText('E3–06–02', 'E3-06-02')); // en-dashes
  assert.ok(matchesText('E3-0G-0Z', 'E3-06-02'));
});

test('a word after the code does not block the match', () => {
  // S, T, B, ... fold to digits, but a separate word is not part of the room number.
  assert.ok(matchesText('E3-06-02 SEMINAR', 'E3-06-02'));
  assert.ok(matchesText('E3-06-02 TUTORIAL ROOM', 'E3-06-02'));
  assert.ok(matchesText('LAB E3-06-02', 'E3-06-02'));
  // Attached, or a real digit even after a space, still rejects.
  assert.ok(!matchesText('E3-06-02S', 'E3-06-02'));
  assert.ok(!matchesText('E3-06-02 1', 'E3-06-02'));
});

test('rejects neighbouring rooms and longer numbers', () => {
  assert.ok(!matchesText('E3-06-03', 'E3-06-02'));
  assert.ok(!matchesText('E3-06-021', 'E3-06-02'));
  assert.ok(!matchesText('E3-06-12', 'E3-06-02'));
});

test('aliases match', () => {
  const lm = landmark('L', 'E3-06-02', 0, { aliases: ['06-02'] });
  assert.ok(matchesLandmark('ROOM 06-02', lm));
  // A short alias must not match inside a different room's code.
  assert.ok(!matchesLandmark('E4-06-02', lm));
});

test('confirmer needs repeated hits inside the window', () => {
  const c = new LandmarkConfirmer(2, 1500);
  assert.ok(!c.hit('A', 0));
  assert.ok(!c.hit('A', 3000)); // too far apart
  assert.ok(c.hit('A', 3500));
  assert.ok(!c.hit('A', 3600)); // history cleared after confirmation
});

// ---------------------------------------------------------------- TurnDetector

/** Rotate from `from` to `to` degrees over durationMs, then hold for holdMs; 50 Hz. */
function feed(d, startMs, from, to, durationMs, holdMs) {
  const events = [];
  let t = startMs;
  while (t <= startMs + durationMs) {
    const f = (t - startMs) / durationMs;
    const ev = d.onHeading(t, from + (to - from) * f);
    if (ev) events.push(ev);
    t += 20;
  }
  const end = t + holdMs;
  while (t <= end) {
    const ev = d.onHeading(t, to);
    if (ev) events.push(ev);
    t += 20;
  }
  return events;
}

test('detects a right turn', () => {
  const d = new TurnDetector();
  feed(d, 0, 10, 10, 1000, 0);
  const ev = feed(d, 1000, 10, 100, 1000, 1500);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].direction, TurnDir.RIGHT);
  near(ev[0].angleDeg, 90, 8);
});

test('detects a left turn across north', () => {
  const d = new TurnDetector();
  feed(d, 0, 20, 20, 1000, 0);
  const ev = feed(d, 1000, 20, -70, 1000, 1500);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].direction, TurnDir.LEFT);
});

test('detects a turn around', () => {
  const d = new TurnDetector();
  feed(d, 0, 0, 0, 1000, 0);
  const ev = feed(d, 1000, 0, 180, 1500, 1500);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].direction, TurnDir.AROUND);
});

test('ignores a brief dodge', () => {
  const d = new TurnDetector();
  feed(d, 0, 0, 0, 1000, 0);
  const out = [...feed(d, 1000, 0, 70, 300, 300), ...feed(d, 1700, 70, 0, 300, 1500)];
  assert.equal(out.length, 0, 'brief rotation should not be a turn');
});

test('ignores slow drift', () => {
  const d = new TurnDetector();
  // 40 degrees of drift over 60 s
  assert.equal(feed(d, 0, 0, 40, 60_000, 1000).length, 0);
});

test('angleDiff wraps', () => {
  near(angleDiff(10, 350), 20, 1e-9);
  near(angleDiff(350, 10), -20, 1e-9);
});

// ---------------------------------------------------------------- AccelStepDetector

/** Seeded Gaussian noise (mulberry32 + Box-Muller), so the walk is reproducible. */
function gaussian(seed) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

function walk(det, seconds, cadenceHz, amplitude, noise) {
  const rnd = gaussian(42);
  let steps = 0;
  for (let t = 0; t < seconds * 1000; t += 20) { // 50 Hz
    const vertical = amplitude * Math.sin((2 * Math.PI * cadenceHz * t) / 1000) + noise * rnd();
    if (det.onSample(t, 0.3, GRAVITY + vertical, 0.2)) steps++;
  }
  return steps;
}

test('counts normal walking', () => near(walk(new AccelStepDetector(), 10, 1.8, 2.5, 0.3), 18, 1));
test('counts slow walking', () => near(walk(new AccelStepDetector(), 10, 1.2, 1.8, 0.3), 12, 1));
test('no steps when standing still', () => assert.equal(walk(new AccelStepDetector(), 10, 1.8, 0, 0.15), 0));

test('reset clears state', () => {
  const d = new AccelStepDetector();
  d.onSample(0, 0, 12, 0);
  d.reset();
  near(d.currentFiltered, 0, 1e-9);
});

// ---------------------------------------------------------------- StepLengthModel

test('calibration reproduces the measured distance', () => {
  const amps = Array.from({ length: 15 }, (_, i) => 2.0 + (i % 3) * 0.5); // varied bounces
  const k = StepLengthModel.calibrateK(10, amps);
  const model = new StepLengthModel(10 / 15, k);
  near(amps.reduce((acc, a) => acc + model.length(a), 0), 10, 0.3);
});

test('smaller bounce means a shorter step', () => {
  const model = new StepLengthModel(0.65, 0.65 / 2.5 ** 0.25);
  assert.ok(model.length(0.8) < model.length(2.5));
  near(model.length(2.5), 0.65, 1e-9);
});

test('lengths are clamped around the calibrated average', () => {
  const model = new StepLengthModel(0.65, 0.65 / 2.5 ** 0.25);
  near(model.length(0.0001), 0.65 * 0.5, 1e-9);
  near(model.length(500), 0.65 * 1.4, 1e-9);
});

test('falls back to the fixed length', () => {
  near(new StepLengthModel(0.7, 0.5, false).length(3), 0.7, 1e-9);
  near(new StepLengthModel(0.7, 0).length(3), 0.7, 1e-9);
  near(new StepLengthModel(0.7, 0.5).length(null), 0.7, 1e-9);
});

test('calibration needs enough steps', () => {
  assert.equal(StepLengthModel.calibrateK(10, [2, 2]), null);
  assert.equal(StepLengthModel.calibrateK(10, Array(10).fill(null)), null);
});

test('tracker measures peak to trough', () => {
  const t = new StepAmplitudeTracker();
  assert.equal(t.take(), null);
  [0.1, 1.8, -0.6, 0.4].forEach((v) => t.onSample(v));
  near(t.take(), 2.4, 1e-9);
  assert.equal(t.take(), null);
});

// ---------------------------------------------------------------- Guidance

const gRoute = makeRoute('R', 'test', [
  segment('S1', 'Cheers', 'E3-06-02', 18, EndAction.ARRIVE, { arrivalSide: TurnDir.LEFT }),
  segment('S2', 'E3-06-02', 'corridor end', 55, EndAction.TURN_LEFT, { startTurn: TurnDir.RIGHT }),
  segment('S3', 'corridor end', 'the toilet', 16, EndAction.ARRIVE, { arrivalSide: TurnDir.LEFT }),
  segment('S4', 'the toilet', 'main corridor', 16, EndAction.TURN_RIGHT, { startTurn: TurnDir.AROUND }),
  segment('S5', 'main corridor', 'E3-06-02', 47, EndAction.ARRIVE, { arrivalSide: TurnDir.RIGHT }),
]);

const snap = (state, seg, s, sigma = 1, startTurn = false) => ({
  state, segmentIndex: seg, segmentId: gRoute.segments[seg].id, segmentFrom: gRoute.segments[seg].from,
  segmentTo: gRoute.segments[seg].to, positionM: s, segmentLengthM: gRoute.segments[seg].lengthM, sigmaM: sigma,
  totalSteps: 0, netTurnDeg: 0, turnPending: false, offCourse: false, awaitingStartTurn: startTurn, lastLandmark: null,
});

test('turn card shows distance and then', () => {
  const g = buildGuidance(gRoute, snap(NavState.TRACKING, 1, 40));
  assert.equal(g.maneuver, Maneuver.TURN_LEFT);
  near(g.distanceM, 15, 1e-9);
  assert.equal(g.then, Maneuver.ARRIVE);
  assert.equal(g.destination, 'the toilet');
  near(g.remainingToDestinationM, 15 + 16, 1e-9);
});

test('at the door, asks to face it', () => {
  assert.equal(buildGuidance(gRoute, snap(NavState.TRACKING, 0, 17.5)).maneuver, Maneuver.FACE_LEFT);
});

test('lost is a warning', () => {
  const g = buildGuidance(gRoute, snap(NavState.LOST, 1, 20));
  assert.equal(g.maneuver, Maneuver.LOST);
  assert.ok(g.warning);
});

test('start turn shown before walking', () => {
  assert.equal(buildGuidance(gRoute, snap(NavState.TRACKING, 3, 0, 1, true)).maneuver, Maneuver.TURN_AROUND);
});

test('geometry follows turns', () => {
  const geo = new RouteGeometry(gRoute);
  // S1+S2 go north 73 m, left turn => S3 heads west, around => S4 east, right => S5 south
  near(geo.headingAt(0), 0, 1e-9);
  near(geo.headingAt(1), 0, 1e-9); // start turn RIGHT just undoes facing the door
  near(geo.headingAt(2), 270, 1e-9);
  near(geo.headingAt(3), 90, 1e-9);
  near(geo.headingAt(4), 180, 1e-9);
  const end = geo.pointAt(4, 47);
  near(end.x, 0, 1e-6);
  near(end.y, 73 - 47, 1e-6);
});

// ---------------------------------------------------------------- Route file

test('the shipped route file parses', () => {
  const r = parseRoute(readFileSync(new URL('../routes/e3_route.json', import.meta.url), 'utf8'));
  assert.equal(r.segments.length, 5);
  assert.equal(r.segments[1].lengthM, 82);
  assert.equal(r.segments[1].maxSigmaM, 10);
  assert.equal(r.segments[0].landmarks[0].sightingDistanceM, 0);
});

test('a bad route file gives a readable error', () => {
  assert.throws(() => parseRoute({ routeId: 'X', segments: [{ id: 'S1', from: 'a', to: 'b', lengthM: 5, endAction: 'JUMP' }] }),
    /unknown endAction JUMP/);
});
