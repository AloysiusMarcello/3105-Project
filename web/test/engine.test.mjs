// Simulated walks along a test version of the E3 route (port of NavigationEngineTest.kt).
// Run with: npm test   (no phone or browser needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EndAction, TurnDir, landmark, makeRoute, segment } from '../js/core/route.js';
import { makeConfig } from '../js/core/config.js';
import { Confidence, NavState, NavigationEngine } from '../js/core/engine.js';

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, msg ?? `expected ${expected} ± ${tol}, got ${actual}`);

const route = makeRoute('TEST', 'Test route', [
  segment('S1', 'Cheers', 'Junction A', 20.0, EndAction.TURN_RIGHT, {
    startInstruction: 'Walk straight ahead.',
    landmarks: [landmark('L1', 'E3-05-10', 15.0)],
  }),
  segment('S2', 'Junction A', 'E3-06-02', 12.0, EndAction.ARRIVE, {
    startInstruction: 'Walk straight to E3-06-02.',
    arrivalMessage: 'You have arrived at E3-06-02.',
    landmarks: [
      landmark('L2', 'E3-06-01', 5.0, { announce: 'Passing E3-06-01.' }),
      landmark('L3', 'E3-06-02', 12.0, { confirmsArrival: true }),
    ],
  }),
  segment('S3', 'E3-06-02', 'Toilet', 15.0, EndAction.ARRIVE, {
    startInstruction: 'Continue straight to the toilet.',
    arrivalMessage: 'You have arrived at the toilet.',
    landmarks: [landmark('L4', 'TOILET', 15.0, { confirmsArrival: true })],
  }),
  segment('S4', 'Toilet', 'E3-06-02', 15.0, EndAction.ARRIVE, {
    startInstruction: 'Turn around and walk straight back.',
    startTurn: TurnDir.AROUND,
    landmarks: [landmark('L5', 'E3-06-02', 15.0, { confirmsArrival: true })],
  }),
]);

class Harness {
  constructor(r, config = makeConfig()) {
    this.outputs = [];
    this.t = 0;
    this.engine = new NavigationEngine(r, config, (o) => this.outputs.push(o));
  }
  start() { this.engine.start(this.t); }
  steps(n) { for (let i = 0; i < n; i++) { this.t += 550; this.engine.onStep(this.t); } }
  stepsOf(n, len) { for (let i = 0; i < n; i++) { this.t += 550; this.engine.onStep(this.t, len); } }
  walkTo(metres) {
    while (this.engine.snapshot().positionM + this.engine.config.stepLengthM <= metres + 1e-9) this.steps(1);
  }
  turn(direction, angleDeg) { this.t += 1000; this.engine.onTurn({ direction, angleDeg, timestampMs: this.t }); }
  see(text, frames = 2, heightFraction = 0) {
    for (let i = 0; i < frames; i++) { this.t += 300; this.engine.onText([{ text, heightFraction }], this.t); }
  }
  speech() { return this.outputs.filter((o) => o.type === 'speak').map((o) => o.text); }
  logs() { return this.outputs.filter((o) => o.type === 'log').map((o) => o.event); }
  said(fragment) { return this.speech().some((s) => s.toLowerCase().includes(fragment.toLowerCase())); }
  snap() { return this.engine.snapshot(); }
}

test('complete route happy path', () => {
  const h = new Harness(route);
  h.start();
  assert.ok(h.said('Navigation started'));

  // Segment 1: 20 m then right turn
  h.walkTo(20.2);
  // 20 m from the start with no sign: uncertainty ±2.5 m, so the cues are deliberately vague
  assert.ok(h.said('right turn is coming up soon'));
  assert.ok(h.said('You should be at the right turn. Stop'));
  h.turn(TurnDir.RIGHT, 88.0);
  assert.equal(h.snap().segmentIndex, 0); // waits for confirming steps
  h.steps(3);
  assert.equal(h.snap().segmentIndex, 1);
  assert.ok(h.said('Good. Now walk straight ahead'));

  // Segment 2: sees E3-06-01 then E3-06-02 plate ~2.5 m before the door
  h.walkTo(2.5);
  h.see('E3-06-01'); // plate at 5 m, read from ~2.5 m away
  assert.ok(h.said('Passing E3-06-01'));
  h.walkTo(9.5);
  h.see('E3-06-02');
  h.walkTo(12.0);
  assert.equal(h.snap().state, NavState.AWAITING_CONTINUE);
  assert.ok(h.said('You have arrived at E3-06-02'));

  // Segment 3: to toilet
  h.engine.continueAfterArrival();
  assert.ok(h.said('Continue straight to the toilet'));
  h.walkTo(12.5);
  h.see('TOILET');
  h.walkTo(15.0);
  assert.equal(h.snap().state, NavState.AWAITING_CONTINUE);

  // Segment 4: turn around and return
  h.engine.continueAfterArrival();
  assert.ok(h.snap().awaitingStartTurn);
  h.turn(TurnDir.AROUND, 178.0);
  assert.ok(!h.snap().awaitingStartTurn);
  h.walkTo(12.5);
  h.see('E3-06-02');
  h.walkTo(15.0);
  assert.equal(h.snap().state, NavState.FINISHED);
  assert.ok(h.said('Navigation complete'));
  assert.ok(!h.logs().includes('lost'));
});

test('rotation mid-corridor does not advance route', () => {
  const h = new Harness(route);
  h.start();
  h.steps(10); // 6.5 m, far from the 20 m junction
  h.turn(TurnDir.RIGHT, 85.0);
  assert.equal(h.snap().segmentIndex, 0);
  assert.ok(h.snap().offCourse);
  assert.ok(h.said('turned off the corridor'));

  const before = h.snap().positionM;
  h.steps(3); // distance keeps counting even while the warning is active
  near(h.snap().positionM, before + 3 * 0.65, 1e-9);

  h.turn(TurnDir.LEFT, -83.0);
  assert.ok(!h.snap().offCourse);
  assert.ok(h.said('Back on route'));

  h.walkTo(20.0);
  h.turn(TurnDir.RIGHT, 92.0);
  h.steps(3);
  assert.equal(h.snap().segmentIndex, 1);
});

test('twisted phone off-course warning clears itself', () => {
  const h = new Harness(route);
  h.start();
  h.steps(5);
  h.turn(TurnDir.RIGHT, 75.0); // phone twists on its mount, user keeps walking straight
  assert.ok(h.snap().offCourse);
  h.steps(6);
  assert.ok(!h.snap().offCourse);
  near(h.snap().positionM, 11 * 0.65, 1e-9);
  // and the real junction turn still works afterwards
  h.walkTo(20.2);
  h.turn(TurnDir.RIGHT, 90.0);
  h.steps(3);
  assert.equal(h.snap().segmentIndex, 1);
});

test('wrong turn at junction is corrected', () => {
  const h = new Harness(route);
  h.start();
  h.walkTo(20.0);
  h.turn(TurnDir.LEFT, -90.0);
  assert.ok(h.said('Wrong way'));
  h.turn(TurnDir.RIGHT, 90.0); // back to corridor heading: net 0, must NOT count as the right turn
  h.steps(3);
  assert.equal(h.snap().segmentIndex, 0);
  h.turn(TurnDir.RIGHT, 90.0);
  h.steps(3);
  assert.equal(h.snap().segmentIndex, 1);
});

test('turn that is undone before confirmation is cancelled', () => {
  const h = new Harness(route);
  h.start();
  h.walkTo(19.0);
  h.turn(TurnDir.RIGHT, 80.0);
  assert.ok(h.snap().turnPending);
  h.steps(1);
  h.turn(TurnDir.LEFT, -80.0);
  assert.ok(!h.snap().turnPending);
  h.steps(3);
  assert.equal(h.snap().segmentIndex, 0);
});

test('landmark fuses with dead reckoning', () => {
  const h = new Harness(route);
  h.start();
  h.steps(18); // 11.7 m, sigma 1.67
  const sigmaBefore = h.snap().sigmaM;
  h.see('E3-05-10'); // plate at 15 m read from 2.5 m => observation 12.5 m
  const snap = h.snap();
  assert.ok(snap.positionM > 11.7 && snap.positionM < 12.5);
  assert.ok(snap.sigmaM < sigmaBefore);
  assert.ok(snap.sigmaM < 1.0);
});

test('single OCR frame is not enough', () => {
  const h = new Harness(route);
  h.start();
  h.steps(18);
  h.see('E3-05-10', 1);
  assert.ok(!h.logs().includes('landmark_confirmed'));
});

test('duplicate text in one frame counts once', () => {
  const h = new Harness(route);
  h.start();
  h.steps(18);
  // OCR can return the same plate as a line and as a block in the same frame
  h.engine.onText([{ text: 'E3-05-10' }, { text: 'Room E3-05-10' }], 99_000);
  assert.ok(!h.logs().includes('landmark_confirmed'));
});

test('excessive uncertainty stops guidance, then a landmark recovers', () => {
  const h = new Harness(route, makeConfig({ driftFraction: 0.2 }));
  h.start();
  h.steps(22); // 14.3 m: sigma = 0.5 + 0.2 * 14.3 = 3.36 > 3
  assert.equal(h.snap().state, NavState.LOST);
  assert.ok(h.said('Location uncertain'));

  // Steps while lost give no directions, only periodic reminders
  const spokenBefore = h.speech().length;
  h.steps(8);
  assert.equal(h.speech().length, spokenBefore + 1);

  h.see('E3-05-10');
  assert.equal(h.snap().state, NavState.TRACKING);
  assert.ok(h.said('Location confirmed'));
  near(h.snap().positionM, 12.5, 1e-9);
});

test('confidence degrades with drift and recovers at a sign', () => {
  const h = new Harness(route, makeConfig({ driftFraction: 0.2 }));
  h.start();
  assert.equal(h.snap().confidence, Confidence.HIGH);
  h.steps(12); // 7.8 m: sigma = 0.5 + 1.56 = 2.06 > 2.0
  assert.equal(h.snap().confidence, Confidence.MEDIUM);
  h.steps(10); // sigma > 3: lost
  assert.equal(h.snap().confidence, Confidence.LOW);
  h.see('E3-05-10');
  assert.equal(h.snap().confidence, Confidence.HIGH);
  assert.equal(h.logs().filter((e) => e === 'confidence').length, 3);
});

test('walking past the turn raises an alert', () => {
  const h = new Harness(route);
  h.start();
  h.steps(40); // 26 m on a 20 m segment, no turn
  assert.equal(h.snap().state, NavState.LOST);
  assert.ok(h.said('passed the right turn'));
});

test('missed turn is inferred from the next landmark', () => {
  const h = new Harness(route);
  h.start();
  h.walkTo(20.0);
  // No turn event (gyro missed it), but the camera reads a plate from segment 2
  h.see('E3-06-01');
  assert.equal(h.snap().segmentIndex, 1);
  near(h.snap().positionM, 2.5, 1e-9);
  assert.ok(h.logs().includes('turn_inferred_from_landmark'));
});

test('landmark from far ahead is ignored while tracking', () => {
  const h = new Harness(route);
  h.start();
  h.steps(5);
  h.see('TOILET'); // segment 3 landmark, not plausible now
  assert.equal(h.snap().segmentIndex, 0);
  assert.ok(h.logs().includes('landmark_out_of_sequence'));
});

test('no arrival by steps alone when uncertain', () => {
  const h = new Harness(route);
  h.start();
  h.walkTo(20.0);
  h.turn(TurnDir.RIGHT, 90.0);
  h.steps(3);
  h.walkTo(12.0); // no camera confirmation; sigma > 1 m
  assert.equal(h.snap().state, NavState.TRACKING);
  h.steps(1);
  assert.ok(h.said('should be just ahead'));
  h.steps(10);
  assert.equal(h.snap().state, NavState.LOST);
  assert.ok(h.said('walked past E3-06-02'));
});

// ---- Behaviour added after surveying the real E3 route ----

const e3Like = makeRoute('E3LIKE', 'door plates in recesses', [
  segment('A', 'Cheers', 'E3-06-02', 15.0, EndAction.ARRIVE, {
    arrivalSide: TurnDir.LEFT,
    landmarks: [landmark('D1', 'E3-06-02', 15.0, { confirmsArrival: true, sightingDistanceM: 0.0 })],
  }),
  segment('B', 'E3-06-02', 'corridor end', 50.0, EndAction.TURN_LEFT, {
    startTurn: TurnDir.RIGHT,
    maxSigmaM: 7.0,
    landmarks: [
      landmark('X1', 'EXIT', 20.0, { sightingDistanceM: 6.0 }),
      landmark('X2', 'EXIT', 50.0, { sightingDistanceM: 6.0 }),
    ],
  }),
  segment('C', 'corridor end', 'the toilet', 16.0, EndAction.ARRIVE, { arrivalSide: TurnDir.LEFT }),
]);

/** Walk to the first door, face it, read the plate, continue and turn back along the corridor. */
function throughFirstDoor(h) {
  h.walkTo(15.0); h.turn(TurnDir.LEFT, -90.0); h.see('E3-06-02');
  h.engine.continueAfterArrival();
  h.turn(TurnDir.RIGHT, 90.0);
}

test('turning to face the destination door is not off course', () => {
  const h = new Harness(e3Like);
  h.start();
  h.walkTo(15.0);
  assert.ok(h.said('on your left'));
  assert.ok(h.said('turn left to face the door'));
  h.turn(TurnDir.LEFT, -85.0);
  assert.ok(!h.snap().offCourse);
  assert.ok(!h.said('turned off the corridor'));
  h.see('E3-06-02'); // read at close range once facing the door
  assert.equal(h.snap().state, NavState.AWAITING_CONTINUE);
});

test('long featureless corridor uses the segment uncertainty limit', () => {
  const h = new Harness(e3Like);
  h.start();
  throughFirstDoor(h);
  h.walkTo(40.0); // 40 m with no sign: sigma ~5 m, above the global 3 m limit
  assert.equal(h.snap().state, NavState.TRACKING);
  assert.ok(h.snap().sigmaM > 3.0);
});

test('repeated sign text matches the nearest instance', () => {
  const h = new Harness(e3Like);
  h.start();
  throughFirstDoor(h);
  h.walkTo(42.0);
  h.see('EXIT'); // must be X2 (end sign, read from 6 m => 44 m), not X1 at 20 m
  near(h.snap().positionM, 44.0, 1.0);
});

test('destination without a text sign arrives by steps alone', () => {
  const h = new Harness(e3Like);
  h.start();
  throughFirstDoor(h);
  h.walkTo(50.2);
  h.turn(TurnDir.LEFT, -90.0);
  h.steps(3);
  assert.equal(h.snap().segmentIndex, 2);
  h.walkTo(16.0); // toilet door has only a pictogram
  assert.equal(h.snap().state, NavState.FINISHED);
});

// ---- Wording and adaptive steps ----

test('precise cues only when confident', () => {
  const h = new Harness(e3Like);
  h.start();
  throughFirstDoor(h);
  h.walkTo(43.0);
  h.see('EXIT'); // fix: ±1 m
  h.walkTo(50.0);
  // The vague cue came first (±5 m); the EXIT sign fix then allows the exact ones
  assert.ok(h.said('left turn is coming up soon'));
  assert.ok(h.said('In about'));
  assert.ok(h.said('Stop. Turn left now'));
});

test('progress updates on a long corridor', () => {
  const h = new Harness(e3Like);
  h.start();
  throughFirstDoor(h);
  h.walkTo(40.0);
  const updates = h.speech().filter((s) => s.startsWith('Keep going straight'));
  assert.ok(updates.length >= 2, `expected at least 2 progress updates, got ${JSON.stringify(updates)}`);
  assert.ok(updates.every((u) => u.includes('to the left turn')));
});

test('stop then turn confirms immediately', () => {
  const h = new Harness(route);
  h.start();
  h.walkTo(20.2);
  h.turn(TurnDir.RIGHT, 90.0);
  assert.ok(h.said('Good. Now walk straight ahead'));
  assert.equal(h.snap().segmentIndex, 0); // still needs a few steps to commit
  h.steps(3);
  assert.equal(h.snap().segmentIndex, 1);
});

test('short crowd steps count short', () => {
  const h = new Harness(route);
  h.start();
  h.stepsOf(10, 0.40);
  near(h.snap().positionM, 4.0, 1e-9);
});

test('plate size gives a range estimate', () => {
  // calib 0.15: text box at 10% of image height => 1.5 m away
  const h = new Harness(route, makeConfig({ plateSizeCalib: 0.15 }));
  h.start();
  h.walkTo(20.0);
  h.turn(TurnDir.RIGHT, 90.0);
  h.steps(3);
  h.walkTo(10.0);
  h.see('E3-06-02', 2, 0.10);
  h.walkTo(11.7);
  assert.equal(h.snap().state, NavState.AWAITING_CONTINUE);
});
