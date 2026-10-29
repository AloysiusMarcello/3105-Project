/**
 * Route model for a predefined indoor route (port of RouteModel.kt + RouteLoader.parse).
 *
 * A route is a sequence of straight corridor segments. Each segment ends with an action
 * (turn, continue, or arrive at a waypoint) and may contain visual landmarks (room plates,
 * signs) at known distances from the segment start.
 *
 * All distances are in metres, measured along the walking line.
 */

export const EndAction = Object.freeze({
  TURN_LEFT: 'TURN_LEFT',
  TURN_RIGHT: 'TURN_RIGHT',
  CONTINUE: 'CONTINUE',
  ARRIVE: 'ARRIVE',
});

export const TurnDir = Object.freeze({ LEFT: 'LEFT', RIGHT: 'RIGHT', AROUND: 'AROUND' });

/**
 * @typedef {object} Landmark
 * @property {string} id                 unique within the route, e.g. "L2"
 * @property {string} text               text printed on the plate/sign, e.g. "E3-06-02"
 * @property {number} positionM          distance from segment start to the point beside the plate
 * @property {string|null} announce      spoken when first confirmed on this pass; null = silent correction
 * @property {boolean} confirmsArrival   reading it confirms arrival at the segment's end waypoint
 * @property {string[]} aliases          other spellings that should also match
 * @property {number|null} sightingDistanceM  how far BEFORE the sign the user is when it is read
 *   (overrides the global setting): ~4–6 m for a ceiling EXIT sign, 0 for a door plate read facing the door
 */

/**
 * @typedef {object} Segment
 * @property {string} id
 * @property {string} from
 * @property {string} to
 * @property {number} lengthM
 * @property {string} endAction          one of EndAction
 * @property {string|null} startInstruction  spoken when the segment begins
 * @property {string|null} startTurn     a turn to make before walking it (e.g. AROUND for the return leg)
 * @property {string|null} arrivalMessage spoken on arrival when endAction == ARRIVE
 * @property {string|null} arrivalSide   LEFT/RIGHT: side of the destination door
 * @property {boolean} continueAutomatically  ARRIVE only: a waypoint on the way, so announce it and
 *                                       carry on with the next segment instead of waiting for the button
 * @property {number|null} maxSigmaM     uncertainty allowed before guidance stops (overrides global)
 * @property {Landmark[]} landmarks
 */

/** Builds a validated segment, filling defaults. */
export function segment(id, from, to, lengthM, endAction, opts = {}) {
  return {
    id, from, to, lengthM, endAction,
    startInstruction: opts.startInstruction ?? null,
    startTurn: opts.startTurn ?? null,
    arrivalMessage: opts.arrivalMessage ?? null,
    arrivalSide: opts.arrivalSide ?? null,
    continueAutomatically: opts.continueAutomatically ?? false,
    maxSigmaM: opts.maxSigmaM ?? null,
    landmarks: opts.landmarks ?? [],
  };
}

export function landmark(id, text, positionM, opts = {}) {
  return {
    id, text, positionM,
    announce: opts.announce ?? null,
    confirmsArrival: opts.confirmsArrival ?? false,
    aliases: opts.aliases ?? [],
    sightingDistanceM: opts.sightingDistanceM ?? null,
  };
}

export function hasArrivalLandmark(seg) {
  return seg.landmarks.some((l) => l.confirmsArrival);
}

export function expectedEndTurn(seg) {
  if (seg.endAction === EndAction.TURN_LEFT) return TurnDir.LEFT;
  if (seg.endAction === EndAction.TURN_RIGHT) return TurnDir.RIGHT;
  return null;
}

/** Creates a route and checks it, throwing a readable error for a bad route file. */
export function makeRoute(id, name, segments) {
  if (!segments.length) throw new Error('Route must have at least one segment');
  const ids = segments.flatMap((s) => s.landmarks.map((l) => l.id));
  if (ids.length !== new Set(ids).size) throw new Error('Landmark ids must be unique across the route');
  for (const seg of segments) {
    if (!(seg.lengthM > 0)) throw new Error(`Segment ${seg.id} must have positive length`);
    if (!Object.values(EndAction).includes(seg.endAction)) throw new Error(`Segment ${seg.id}: unknown endAction ${seg.endAction}`);
    for (const k of ['startTurn', 'arrivalSide']) {
      if (seg[k] != null && !Object.values(TurnDir).includes(seg[k])) throw new Error(`Segment ${seg.id}: unknown ${k} ${seg[k]}`);
    }
    for (const lm of seg.landmarks) {
      if (!(lm.positionM >= 0 && lm.positionM <= seg.lengthM + 1.0)) {
        throw new Error(`Landmark ${lm.id} position ${lm.positionM} is outside segment ${seg.id} (0..${seg.lengthM})`);
      }
    }
  }
  return { id, name, segments, totalLengthM: segments.reduce((a, s) => a + s.lengthM, 0) };
}

/** Parses the route JSON format used by the Android app (fields starting with _ are ignored). */
export function parseRoute(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  const req = (obj, k, where) => {
    if (obj[k] == null) throw new Error(`${where}: missing "${k}"`);
    return obj[k];
  };
  const segments = req(o, 'segments', 'route').map((s, i) => {
    const where = `segment ${s.id ?? i + 1}`;
    return segment(
      String(req(s, 'id', where)), String(req(s, 'from', where)), String(req(s, 'to', where)),
      Number(req(s, 'lengthM', where)), String(req(s, 'endAction', where)),
      {
        startInstruction: s.startInstruction ?? null,
        startTurn: s.startTurn ?? null,
        arrivalMessage: s.arrivalMessage ?? null,
        arrivalSide: s.arrivalSide ?? null,
        continueAutomatically: !!s.continueAutomatically,
        maxSigmaM: s.maxSigmaM ?? null,
        landmarks: (s.landmarks ?? []).map((l) => landmark(
          String(req(l, 'id', where)), String(req(l, 'text', where)), Number(req(l, 'positionM', where)),
          {
            announce: l.announce ?? null,
            confirmsArrival: !!l.confirmsArrival,
            aliases: l.aliases ?? [],
            sightingDistanceM: l.sightingDistanceM ?? null,
          },
        )),
      },
    );
  });
  const id = String(req(o, 'routeId', 'route'));
  return makeRoute(id, o.name ?? id, segments);
}

export function turnWord(dir) {
  return dir === TurnDir.LEFT ? 'left' : dir === TurnDir.RIGHT ? 'right' : 'around';
}
