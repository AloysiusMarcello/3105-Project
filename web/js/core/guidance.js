import { EndAction, TurnDir, expectedEndTurn, turnWord } from './route.js';
import { NavState } from './engine.js';

/** What the instruction banner shows (Maps-style "turn card"). */
export const Maneuver = Object.freeze({
  STRAIGHT: 'STRAIGHT', TURN_LEFT: 'TURN_LEFT', TURN_RIGHT: 'TURN_RIGHT', TURN_AROUND: 'TURN_AROUND',
  ARRIVE: 'ARRIVE', FACE_LEFT: 'FACE_LEFT', FACE_RIGHT: 'FACE_RIGHT', LOST: 'LOST', DONE: 'DONE',
});

/**
 * @typedef {object} Guidance
 * @property {string} maneuver
 * @property {number|null} distanceM  distance to the manoeuvre; null when it applies now
 * @property {string} title
 * @property {string|null} subtitle
 * @property {string|null} then       the manoeuvre after this one, for the "Then …" chip
 * @property {string} destination     next waypoint the user is heading to
 * @property {number} remainingToDestinationM
 * @property {boolean} warning
 */
const g = (maneuver, distanceM, title, subtitle, then, destination, remainingToDestinationM, warning = false) =>
  ({ maneuver, distanceM, title, subtitle, then, destination, remainingToDestinationM, warning });

/** Builds the banner from the same engine state the voice uses (port of Guidance.kt). */
export function buildGuidance(route, snap, arrivalToleranceM = 1.0) {
  const i = snap.segmentIndex;
  const seg = route.segments[i];
  const remaining = Math.max(0, seg.lengthM - snap.positionM);
  const [dest, toDest] = nextDestination(route, i, remaining);

  switch (snap.state) {
    case NavState.IDLE: return g(Maneuver.STRAIGHT, null, 'Ready', route.name, null, dest, toDest);
    case NavState.FINISHED: return g(Maneuver.DONE, null, 'You have arrived', seg.to, null, seg.to, 0);
    case NavState.LOST:
      return g(Maneuver.LOST, null, 'Location uncertain', 'Stop and face along the corridor', null, dest, toDest, true);
    case NavState.AWAITING_CONTINUE: {
      const next = route.segments[i + 1];
      const [nDest, nDist] = next ? nextDestination(route, i + 1, next.lengthM) : [seg.to, 0];
      return g(Maneuver.ARRIVE, null, `Arrived at ${seg.to}`, 'Press the button to continue',
        next ? startManeuver(next) : null, nDest, nDist);
    }
    default: // TRACKING
      if (snap.awaitingStartTurn && seg.startTurn != null) {
        return g(turnManeuver(seg.startTurn), null, `Turn ${turnWord(seg.startTurn)}`, 'then walk straight',
          Maneuver.STRAIGHT, dest, toDest);
      }
      if (snap.offCourse) {
        return g(Maneuver.TURN_AROUND, null, 'Turn back', 'You may have left the corridor', null, dest, toDest, true);
      }
      if (snap.turnPending) return g(Maneuver.STRAIGHT, null, 'Keep walking', 'Confirming the turn…', null, dest, toDest);
      return trackingGuidance(route, i, seg, remaining, dest, toDest, arrivalToleranceM);
  }
}

function trackingGuidance(route, i, seg, remaining, dest, toDest, tol) {
  const next = route.segments[i + 1];
  switch (seg.endAction) {
    case EndAction.TURN_LEFT:
    case EndAction.TURN_RIGHT: {
      const dir = expectedEndTurn(seg);
      return g(turnManeuver(dir), remaining, `Turn ${turnWord(dir)}`, next ? next.to : seg.to,
        next ? endManeuver(next) : null, dest, toDest);
    }
    case EndAction.ARRIVE: {
      const side = seg.arrivalSide;
      if (remaining <= tol && side != null) {
        return g(side === TurnDir.LEFT ? Maneuver.FACE_LEFT : Maneuver.FACE_RIGHT, null,
          `Face the door on your ${turnWord(side)}`, seg.to, null, dest, toDest);
      }
      return g(Maneuver.ARRIVE, remaining, seg.to, side != null ? `on your ${turnWord(side)}` : null, null, dest, toDest);
    }
    default: // CONTINUE
      return g(Maneuver.STRAIGHT, remaining, 'Continue straight', seg.to, next ? endManeuver(next) : null, dest, toDest);
  }
}

/** First ARRIVE waypoint (one that stops, not one passed on the way) at or after segment `from`, and the walking distance to it. */
export function nextDestination(route, from, remainingInCurrent) {
  let dist = remainingInCurrent;
  const segs = route.segments;
  for (let k = from; k < segs.length; k++) {
    const s = segs[k];
    if (k > from) dist += s.lengthM;
    if ((s.endAction === EndAction.ARRIVE && !s.continueAutomatically) || k === segs.length - 1) return [s.to, dist];
  }
  return [segs[segs.length - 1].to, dist];
}

function turnManeuver(d) {
  if (d === TurnDir.LEFT) return Maneuver.TURN_LEFT;
  if (d === TurnDir.RIGHT) return Maneuver.TURN_RIGHT;
  return Maneuver.TURN_AROUND;
}

const startManeuver = (s) => (s.startTurn === TurnDir.AROUND ? Maneuver.TURN_AROUND : Maneuver.STRAIGHT);

function endManeuver(s) {
  switch (s.endAction) {
    case EndAction.TURN_LEFT: return Maneuver.TURN_LEFT;
    case EndAction.TURN_RIGHT: return Maneuver.TURN_RIGHT;
    case EndAction.ARRIVE: return Maneuver.ARRIVE;
    default: return Maneuver.STRAIGHT;
  }
}

const normDeg = (a) => ((a % 360) + 360) % 360;
const rad = (d) => (d * Math.PI) / 180;

/** Flat 2-D layout of the route for drawing a map. Metres; x = east, y = north; heading 0 = north, clockwise. */
export class RouteGeometry {
  constructor(route) {
    this.route = route;
    let x = 0;
    let y = 0;
    let h = 0;
    this.segments = route.segments.map((s) => {
      // Only a turn-around changes the walking line at a segment start. LEFT/RIGHT start turns
      // just undo "face the door" at a waypoint, so the corridor direction is unchanged.
      if (s.startTurn === TurnDir.AROUND) h += 180;
      const x1 = x + s.lengthM * Math.sin(rad(h));
      const y1 = y + s.lengthM * Math.cos(rad(h));
      const seg = { x0: x, y0: y, x1, y1, headingDeg: normDeg(h) };
      x = x1;
      y = y1;
      if (s.endAction === EndAction.TURN_LEFT) h -= 90;
      else if (s.endAction === EndAction.TURN_RIGHT) h += 90;
      return seg;
    });
  }

  pointAt(segIndex, s) {
    const i = Math.min(Math.max(segIndex, 0), this.segments.length - 1);
    const gs = this.segments[i];
    const f = Math.min(1.05, Math.max(0, s / this.route.segments[i].lengthM));
    return { x: gs.x0 + (gs.x1 - gs.x0) * f, y: gs.y0 + (gs.y1 - gs.y0) * f };
  }

  headingAt(segIndex) {
    return this.segments[Math.min(Math.max(segIndex, 0), this.segments.length - 1)].headingDeg;
  }
}
