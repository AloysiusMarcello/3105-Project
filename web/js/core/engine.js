import { EndAction, TurnDir, expectedEndTurn, hasArrivalLandmark, turnWord } from './route.js';
import { LandmarkConfirmer, matchesLandmark } from './landmark.js';

export const NavState = Object.freeze({
  IDLE: 'IDLE', TRACKING: 'TRACKING', AWAITING_CONTINUE: 'AWAITING_CONTINUE', LOST: 'LOST', FINISHED: 'FINISHED',
});

/**
 * How much the engine may claim about position (report §7, safe localisation failure).
 *  HIGH   σ ≤ preciseCueMaxSigmaM: exact distances ("In about 2 metres, turn left", "Stop. Turn left now.")
 *  MEDIUM above that: approximate cues only ("coming up soon", "turn when your cane finds the opening")
 *  LOW    σ above the segment limit (state LOST): no directions, ask the user to stop until a sign is read
 */
export const Confidence = Object.freeze({ HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' });

export const HapticKind = Object.freeze({
  TURN_SOON: 'TURN_SOON', TURN_NOW: 'TURN_NOW', CONFIRM: 'CONFIRM', WARNING: 'WARNING', ARRIVED: 'ARRIVED',
});

export const CONTINUE_PROMPT = 'Press the button when you are ready to continue.';
export const LOST_MESSAGE = 'Location uncertain. Please stop and face along the corridor so I can find a room sign.';

const fmt = (x) => x.toFixed(2);
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const roundHalfUp = (x) => Math.floor(x + 0.5); // Kotlin roundToInt
function metres(x) {
  const m = Math.max(1, roundHalfUp(x));
  return m === 1 ? '1 metre' : `${m} metres`;
}

/**
 * Hybrid visual-inertial route tracker (report Concept C, functions F3–F9). Port of NavigationEngine.kt.
 *
 * Position is one-dimensional: the current route segment plus the distance walked along it.
 *  - Steps move the estimate forward and grow its uncertainty (dead reckoning, F3).
 *  - Confirmed landmarks correct the estimate with a 1-D Kalman update (F4).
 *  - A turn is accepted only near the expected junction, in the expected direction, and
 *    after further steps confirm it (route-constrained turn detection).
 *  - When uncertainty exceeds the limit, directions stop until a landmark is seen again (F9).
 *
 * The engine never touches browser APIs; everything it wants done goes to `out` as
 * {type:'speak', text, urgent} | {type:'haptic', kind} | {type:'log', event, detail}.
 * Time is passed in explicitly so the engine can be tested with simulated walks.
 */
export class NavigationEngine {
  constructor(route, config, out) {
    this.route = route;
    this.config = config;
    this.out = out;

    this.state = NavState.IDLE;
    this.segIndex = 0;
    this.s = 0;
    this.sigmaFix = 0;
    this.distSinceFix = 0;
    this.totalSteps = 0;
    this.netTurn = 0;
    /** @type {{sigmaAtTurn:number, steps:number, distM:number}|null} */
    this.pending = null;
    this.offCourse = false;
    this.offCourseSteps = 0;
    this.awaitingStartTurn = false;
    this.startTurnSteps = 0;
    this.startTurnDist = 0;
    this.lastProgressS = 0;
    this.lostSteps = 0;
    this.carrySigma = 0;

    // Per-segment announcement flags
    this.announcedSoon = false;
    this.announcedNow = false;
    this.announcedNear = false;
    /** The "coming up" cue was given vaguely; a later sign fix may upgrade it to an exact distance. */
    this.approachCueWasVague = false;
    this.arrivalLandmarkSeen = false;

    this.announcedLandmarks = new Set();
    this.lastFixAt = new Map();
    this.confirmer = new LandmarkConfirmer(config.landmarkMinHits, config.landmarkWindowMs);
    this.lastLandmark = null;
    this.loggedConfidence = Confidence.HIGH;
  }

  get segment() {
    return this.route.segments[this.segIndex];
  }

  /** Current 1-sigma position uncertainty in metres. */
  get sigma() {
    return this.sigmaFix + this.config.driftFraction * this.distSinceFix;
  }

  get confidence() {
    if (this.state === NavState.LOST) return Confidence.LOW;
    if (this.sigma <= this.config.preciseCueMaxSigmaM) return Confidence.HIGH;
    return Confidence.MEDIUM;
  }

  /** Logs every change of confidence level, so the CSV shows where on the route each level applied. */
  noteConfidence() {
    const c = this.confidence;
    if (c === this.loggedConfidence) return;
    this.log('confidence', `${this.loggedConfidence}->${c} sigma=${fmt(this.sigma)} s=${fmt(this.s)}`);
    this.loggedConfidence = c;
  }

  // ------------------------------------------------------------------ control

  start(nowMs) {
    this.confirmer = new LandmarkConfirmer(this.config.landmarkMinHits, this.config.landmarkWindowMs);
    this.announcedLandmarks.clear();
    this.lastFixAt.clear();
    this.lastLandmark = null;
    this.totalSteps = 0;
    this.state = NavState.TRACKING;
    this.log('nav_start', `route=${this.route.id} t=${Math.round(nowMs)} stepLength=${this.config.stepLengthM}`);
    this.speak('Navigation started.');
    this.beginSegment(0, 0, this.config.startSigmaM, 0, true);
    this.loggedConfidence = this.confidence;
  }

  stop() {
    this.state = NavState.IDLE;
    this.pending = null;
    this.log('nav_stop');
  }

  /** User confirms they are ready to continue after arriving at a waypoint. */
  continueAfterArrival() {
    if (this.state !== NavState.AWAITING_CONTINUE) return;
    this.state = NavState.TRACKING;
    this.beginSegment(this.segIndex + 1, 0, this.carrySigma, 0, true);
  }

  /** Spoken status on demand (e.g. a "repeat" button). */
  repeatInstruction() {
    switch (this.state) {
      case NavState.IDLE: this.speak('Navigation is not running.'); break;
      case NavState.TRACKING: this.speak(this.guidanceSummary()); break;
      case NavState.AWAITING_CONTINUE: this.speak(`You are at ${this.segment.to}. ${CONTINUE_PROMPT}`); break;
      case NavState.LOST: this.speak(LOST_MESSAGE); break;
      case NavState.FINISHED: this.speak(`Navigation complete. You are at ${this.segment.to}.`); break;
    }
  }

  // ------------------------------------------------------------------ inputs

  /**
   * One detected step. `stepLengthM` is the per-step length from the adaptive step model;
   * null = use the calibrated average.
   */
  onStep(nowMs, stepLengthM = null) {
    this.step(stepLengthM);
    this.noteConfidence();
  }

  step(stepLengthM) {
    const c = this.config;
    this.totalSteps++;
    if (this.state === NavState.LOST) {
      this.lostSteps++;
      if (c.lostReminderSteps > 0 && this.lostSteps % c.lostReminderSteps === 0) {
        this.speak(LOST_MESSAGE, true);
      }
      return;
    }
    if (this.state !== NavState.TRACKING) return;
    const stepLen = stepLengthM ?? c.stepLengthM;

    if (this.awaitingStartTurn) {
      this.startTurnSteps++;
      this.startTurnDist += stepLen;
      if (this.startTurnSteps < c.startTurnGraceSteps) return;
      // User walked off without a detected start turn: assume it was made before "continue".
      this.awaitingStartTurn = false;
      this.log('start_turn_assumed', `steps=${this.startTurnSteps}`);
      this.s += this.startTurnDist;
      this.distSinceFix += this.startTurnDist;
      this.checkProgress();
      return;
    }

    const p = this.pending;
    if (p) {
      p.steps++;
      p.distM += stepLen;
      this.distSinceFix += stepLen;
      if (p.steps >= c.turnConfirmSteps) this.commitTurn(p);
      return;
    }

    this.distSinceFix += stepLen;
    // Always count the distance. A rotation away from the corridor is usually the phone twisting
    // on its mount or a dodge; if he really left the corridor, the uncertainty and overshoot checks catch it.
    this.s += stepLen;
    if (this.offCourse && ++this.offCourseSteps >= c.offCourseTimeoutSteps) {
      this.offCourse = false;
      this.netTurn = 0;
      this.log('off_course_timeout', `steps=${this.offCourseSteps} (assuming the phone twisted, not the user)`);
    }

    // Route-specific checks first, so "you passed the turn" wins over the generic message.
    if (!this.offCourse) this.checkProgress();
    if (this.state === NavState.TRACKING && this.sigma > (this.segment.maxSigmaM ?? c.maxSigmaM)) {
      this.goLost('uncertainty', LOST_MESSAGE);
    }
  }

  /** @param {{direction:string, angleDeg:number, timestampMs:number}} ev */
  onTurn(ev) {
    const c = this.config;
    this.log('turn_event', `dir=${ev.direction} angle=${fmt(ev.angleDeg)} s=${fmt(this.s)} sigma=${fmt(this.sigma)} state=${this.state}`);
    if (this.state !== NavState.TRACKING) return;
    this.netTurn += ev.angleDeg;
    const seg = this.segment;

    if (this.awaitingStartTurn) {
      if (seg.startTurn != null && this.matchesTurn(this.netTurn, seg.startTurn)) {
        this.awaitingStartTurn = false;
        this.netTurn = 0;
        this.log('start_turn_done', `dir=${seg.startTurn}`);
        this.haptic(HapticKind.CONFIRM);
        this.speak('Good. Walk straight ahead.');
      }
      return;
    }

    const expected = expectedEndTurn(seg);
    const nearEnd = Math.abs(seg.lengthM - this.s) <= c.turnWindowM + this.sigma;
    if (expected != null && nearEnd) {
      if (this.matchesTurn(this.netTurn, expected)) {
        if (this.pending == null) {
          this.pending = { sigmaAtTurn: this.sigma, steps: 0, distM: 0 };
          this.offCourse = false;
          this.log('turn_accepted', `net=${fmt(this.netTurn)} s=${fmt(this.s)}`);
          this.haptic(HapticKind.CONFIRM);
          this.speak('Good. Now walk straight ahead.');
        }
      } else {
        if (this.pending != null) {
          this.pending = null;
          this.log('turn_cancelled', `net=${fmt(this.netTurn)}`);
        }
        if (Math.abs(this.netTurn) >= c.offCourseDeg) {
          this.log('wrong_turn', `net=${fmt(this.netTurn)} expected=${expected}`);
          this.haptic(HapticKind.WARNING);
          this.speak(`Wrong way. Turn back, then turn ${turnWord(expected)}.`, true);
        }
      }
      return;
    }

    // Turning to face the destination door (plates sit on doors in side recesses) is expected.
    if (seg.endAction === EndAction.ARRIVE && nearEnd) {
      this.log('turn_at_waypoint', `net=${fmt(this.netTurn)} s=${fmt(this.s)}`);
      return;
    }

    // Not at a junction where a turn is expected.
    if (Math.abs(this.netTurn) >= c.offCourseDeg) {
      if (!this.offCourse) {
        this.offCourse = true;
        this.offCourseSteps = 0;
        this.log('off_course', `net=${fmt(this.netTurn)} s=${fmt(this.s)} (rotation away from junction)`);
        this.haptic(HapticKind.WARNING);
        this.speak('You may have turned off the corridor. Turn back to continue.', true);
      }
    } else if (this.offCourse) {
      this.offCourse = false;
      this.log('back_on_route', `net=${fmt(this.netTurn)}`);
      this.haptic(HapticKind.CONFIRM);
      this.speak('Back on route.');
    } else {
      this.log('turn_ignored', `net=${fmt(this.netTurn)} s=${fmt(this.s)}`);
    }
  }

  /**
   * OCR results from one camera frame.
   * @param {{text:string, heightFraction?:number}[]} observations
   */
  onText(observations, nowMs) {
    if (this.state !== NavState.TRACKING && this.state !== NavState.LOST) return;
    const countedThisFrame = new Set(); // one hit per landmark per frame, however many text boxes match
    for (const obs of observations) {
      const candidates = [];
      this.route.segments.forEach((seg, i) => {
        for (const lm of seg.landmarks) if (matchesLandmark(obs.text, lm)) candidates.push([i, lm]);
      });
      if (!candidates.length) continue;
      const chosen = this.chooseCandidate(candidates);
      if (!chosen) {
        this.log('landmark_out_of_sequence', `text=${obs.text}`);
        continue;
      }
      if (countedThisFrame.has(chosen[1].id)) continue;
      countedThisFrame.add(chosen[1].id);
      if (this.confirmer.hit(chosen[1].id, nowMs)) {
        this.handleLandmark(chosen[0], chosen[1], obs.heightFraction ?? 0, nowMs);
      }
    }
    this.noteConfidence();
  }

  // ------------------------------------------------------------------ internals

  chooseCandidate(cands) {
    const priority = (segI) => {
      if (segI === this.segIndex) return 0;
      if (segI === this.segIndex + 1) return 1;
      if (this.state === NavState.LOST) return 2 + Math.abs(segI - this.segIndex) + (segI < this.segIndex ? 1 : 0);
      return null;
    };
    // Same priority (e.g. two EXIT signs on one segment): take the one nearest the current estimate.
    const gap = ([segI, lm]) => (segI === this.segIndex
      ? Math.abs(lm.positionM - (lm.sightingDistanceM ?? this.config.sightingDistanceM) - this.s)
      : lm.positionM);
    let best = null;
    for (const c of cands) {
      const p = priority(c[0]);
      if (p == null) continue;
      const g = gap(c);
      if (!best || p < best.p || (p === best.p && g < best.g)) best = { p, g, c };
    }
    return best ? best.c : null;
  }

  handleLandmark(segI, lm, heightFraction, nowMs) {
    const c = this.config;
    const last = this.lastFixAt.get(lm.id);
    if (last != null && nowMs - last < c.landmarkCooldownMs) return;
    this.lastFixAt.set(lm.id, nowMs);

    const d = this.sightingDistance(lm, heightFraction);
    const sObs = Math.max(0, lm.positionM - d);
    this.lastLandmark = lm.text;
    this.log('landmark_confirmed', `id=${lm.id} text=${lm.text} seg=${this.route.segments[segI].id} sObs=${fmt(sObs)} s=${fmt(this.s)} sigma=${fmt(this.sigma)} range=${fmt(d)} state=${this.state}`);

    if (this.state === NavState.LOST) {
      if (segI !== this.segIndex) {
        this.beginSegment(segI, sObs, c.landmarkSigmaM, 0, false);
      } else {
        this.s = sObs;
        this.sigmaFix = c.landmarkSigmaM;
        this.distSinceFix = 0;
        this.netTurn = 0;
        this.pending = null;
        this.offCourse = false;
        this.awaitingStartTurn = false;
      }
      this.state = NavState.TRACKING;
      this.lostSteps = 0;
      if (lm.confirmsArrival) this.arrivalLandmarkSeen = true;
      this.announcedLandmarks.add(lm.id);
      this.log('relocalised', `seg=${this.segment.id} s=${fmt(this.s)}`);
      this.haptic(HapticKind.CONFIRM);
      this.speak(`Location confirmed, ${lm.announce ?? lm.text}. ${this.guidanceSummary()}`);
      this.checkProgress();
      return;
    }

    // TRACKING
    if (segI === this.segIndex) {
      if (this.pending != null) {
        this.log('landmark_ignored', 'turn pending');
        return;
      }
      this.fuse(sObs);
    } else if (segI === this.segIndex + 1) {
      const seg = this.segment;
      const turn = expectedEndTurn(seg);
      const nearEnd = this.s >= seg.lengthM - c.turnWindowM - this.sigma;
      const canAdvance = this.pending != null || seg.endAction === EndAction.CONTINUE || (turn != null && nearEnd);
      if (!canAdvance) {
        this.log('landmark_out_of_sequence', `id=${lm.id}`);
        return;
      }
      if (this.pending == null && turn != null) this.log('turn_inferred_from_landmark', `id=${lm.id}`);
      const hadTurn = this.pending != null || turn != null;
      this.beginSegment(segI, sObs, c.landmarkSigmaM, 0, false);
      if (hadTurn) this.speak('You have turned.');
      const instr = this.route.segments[segI].startInstruction;
      if (instr) this.speak(instr);
    } else {
      this.log('landmark_out_of_sequence', `id=${lm.id}`);
      return;
    }

    if (lm.confirmsArrival) this.arrivalLandmarkSeen = true;
    if (lm.announce != null && !this.announcedLandmarks.has(lm.id)) {
      this.announcedLandmarks.add(lm.id);
      this.speak(lm.announce);
    }
    this.checkProgress();
  }

  /** 1-D Kalman update of the along-segment position with a landmark observation. */
  fuse(sObs) {
    const c = this.config;
    const priorVar = this.sigma * this.sigma;
    const obsVar = c.landmarkSigmaM * c.landmarkSigmaM;
    const innovation = sObs - this.s;
    if (Math.abs(innovation) > 3.0 * Math.sqrt(priorVar + obsVar)) {
      // The camera reading is far more trustworthy than a badly drifted step count.
      this.log('large_correction', `from=${fmt(this.s)} to=${fmt(sObs)}`);
      this.s = sObs;
      this.sigmaFix = c.landmarkSigmaM;
    } else {
      const k = priorVar / (priorVar + obsVar);
      this.s += k * innovation;
      this.sigmaFix = Math.sqrt((1 - k) * priorVar);
    }
    this.distSinceFix = 0;
    this.log('position_fix', `s=${fmt(this.s)} sigma=${fmt(this.sigma)}`);
    if (this.approachCueWasVague && this.sigma <= c.preciseCueMaxSigmaM) {
      // Now we know better: allow the exact "in about N metres" cue.
      this.approachCueWasVague = false;
      this.announcedSoon = false;
      this.announcedNear = false;
    }
  }

  checkProgress() {
    if (this.state !== NavState.TRACKING || this.pending != null || this.awaitingStartTurn || this.offCourse) return;
    const c = this.config;
    const seg = this.segment;
    const remaining = seg.lengthM - this.s;
    // Exact distances only when the estimate is good; otherwise vaguer wording, given earlier.
    const precise = this.sigma <= c.preciseCueMaxSigmaM;
    const announceAt = c.turnAnnounceM + (precise ? 0 : this.sigma);
    this.progressCue(seg, remaining, precise);

    switch (seg.endAction) {
      case EndAction.TURN_LEFT:
      case EndAction.TURN_RIGHT: {
        const w = turnWord(expectedEndTurn(seg));
        if (!this.announcedSoon && remaining <= announceAt && remaining > c.turnNowM) {
          this.announcedSoon = true;
          this.haptic(HapticKind.TURN_SOON);
          this.approachCueWasVague = !precise;
          this.speak(precise ? `In about ${metres(remaining)}, turn ${w}.` : `The ${w} turn is coming up soon. Slow down.`);
          this.log('cue_turn_soon', `remaining=${fmt(remaining)}`);
        }
        if (!this.announcedNow && remaining <= c.turnNowM) {
          this.announcedNow = true;
          this.announcedSoon = true;
          this.haptic(HapticKind.TURN_NOW);
          this.speak(
            precise ? `Stop. Turn ${w} now.`
              : `You should be at the ${w} turn. Stop, and turn ${w} when your cane finds the opening.`,
            true,
          );
          this.log('cue_turn_now', `remaining=${fmt(remaining)}`);
        }
        if (-remaining > c.overshootM + this.sigma) {
          this.goLost('overshoot_turn', `You may have passed the ${w} turn. Please stop.`);
        }
        break;
      }
      case EndAction.CONTINUE: {
        if (remaining <= 0) {
          if (this.segIndex === this.route.segments.length - 1) this.finish();
          else this.beginSegment(this.segIndex + 1, -remaining, this.sigmaFix, this.distSinceFix, true);
        }
        break;
      }
      case EndAction.ARRIVE: {
        const side = seg.arrivalSide != null ? ` on your ${turnWord(seg.arrivalSide)}` : '';
        if (!this.announcedNear && remaining <= announceAt && remaining > c.arrivalToleranceM) {
          this.announcedNear = true;
          this.approachCueWasVague = !precise;
          this.speak(cap(precise ? `${seg.to} is about ${metres(remaining)} ahead${side}.`
            : `${seg.to} is coming up soon${side}. Slow down.`));
          this.log('cue_approaching', `remaining=${fmt(remaining)}`);
        }
        // Destinations with no readable sign (e.g. a pictogram-only toilet door) arrive by steps alone.
        if (remaining <= c.arrivalToleranceM &&
          (this.sigma <= c.arrivalMaxSigmaM || this.arrivalLandmarkSeen || !hasArrivalLandmark(seg))) {
          this.arrive();
          return;
        }
        if (!this.announcedNow && remaining <= c.arrivalToleranceM) {
          this.announcedNow = true;
          const prompt = seg.arrivalSide != null
            ? `${seg.to} should be here${side}. Stop and turn ${turnWord(seg.arrivalSide)} to face the door so I can read the sign.`
            : `${seg.to} should be just ahead. Slow down while I look for the sign.`;
          this.speak(cap(prompt));
          this.log('cue_looking_for_waypoint', `sigma=${fmt(this.sigma)}`);
        }
        if (-remaining > c.overshootM + this.sigma) {
          this.goLost('overshoot_waypoint', `You may have walked past ${seg.to}. Please stop.`);
        }
        break;
      }
    }
  }

  /** "Still on track" update every progressIntervalM on long stretches. */
  progressCue(seg, remaining, precise) {
    const c = this.config;
    if (this.s - this.lastProgressS < c.progressIntervalM) return;
    this.lastProgressS = this.s;
    if (remaining <= c.turnAnnounceM + 5.0 + (precise ? 0 : this.sigma)) return;
    let target;
    if (seg.endAction === EndAction.ARRIVE) target = seg.to;
    else if (seg.endAction === EndAction.CONTINUE) target = 'the end of this section';
    else target = `the ${turnWord(expectedEndTurn(seg))} turn`;
    const dist = precise ? metres(remaining) : `${Math.max(5, roundHalfUp(remaining / 5.0) * 5)} metres`;
    this.speak(`Keep going straight. About ${dist} to ${target}.`);
    this.log('cue_progress', `remaining=${fmt(remaining)} sigma=${fmt(this.sigma)}`);
  }

  commitTurn(p) {
    const sStart = p.distM;
    this.log('turn_committed', `steps_after=${p.steps}`);
    this.haptic(HapticKind.CONFIRM);
    this.beginSegment(this.segIndex + 1, sStart, Math.min(p.sigmaAtTurn, this.config.turnFixSigmaM), sStart, true);
  }

  arrive() {
    const seg = this.segment;
    this.carrySigma = Math.min(this.sigma, this.config.landmarkSigmaM);
    this.haptic(HapticKind.ARRIVED);
    this.log('arrived', `waypoint=${seg.to} s=${fmt(this.s)} sigma=${fmt(this.sigma)} landmark=${this.arrivalLandmarkSeen}`);
    const message = seg.arrivalMessage ?? `You have arrived at ${seg.to}.`;
    if (this.segIndex === this.route.segments.length - 1) {
      this.finish(message);
    } else if (seg.continueAutomatically) {
      // A waypoint on the way rather than a stop: announce it and carry straight on, no button press.
      this.log('auto_continue', `waypoint=${seg.to}`);
      this.speak(message);
      this.beginSegment(this.segIndex + 1, 0, this.carrySigma, 0, true);
    } else {
      this.state = NavState.AWAITING_CONTINUE;
      this.speak(`${message} ${CONTINUE_PROMPT}`);
    }
  }

  finish(message = null) {
    this.state = NavState.FINISHED;
    this.log('finished');
    this.speak([message, 'Navigation complete.'].filter(Boolean).join(' '));
  }

  goLost(reason, message) {
    this.state = NavState.LOST;
    this.pending = null;
    this.lostSteps = 0;
    this.log('lost', `reason=${reason} s=${fmt(this.s)} sigma=${fmt(this.sigma)}`);
    this.haptic(HapticKind.WARNING);
    this.speak(message, true);
  }

  beginSegment(i, sStart, sigmaFixNew, distSince, speakInstruction) {
    this.segIndex = i;
    this.s = sStart;
    this.sigmaFix = sigmaFixNew;
    this.distSinceFix = distSince;
    this.netTurn = 0;
    this.pending = null;
    this.offCourse = false;
    this.announcedSoon = false;
    this.announcedNow = false;
    this.announcedNear = false;
    this.approachCueWasVague = false;
    this.arrivalLandmarkSeen = false;
    const seg = this.segment;
    this.awaitingStartTurn = seg.startTurn != null;
    this.startTurnSteps = 0;
    this.startTurnDist = 0;
    this.lastProgressS = sStart;
    this.log('segment_start', `seg=${seg.id} ${seg.from}->${seg.to} s=${fmt(this.s)} sigma=${fmt(this.sigma)}`);
    if (speakInstruction && seg.startInstruction) this.speak(seg.startInstruction);
  }

  guidanceSummary() {
    const seg = this.segment;
    const remaining = seg.lengthM - this.s;
    const turn = expectedEndTurn(seg);
    if (this.awaitingStartTurn && seg.startTurn != null) return `Turn ${turnWord(seg.startTurn)}, then walk straight.`;
    if (turn != null && remaining > 0.5) return `Walk straight. Turn ${turnWord(turn)} in about ${metres(remaining)}.`;
    if (turn != null) return `Turn ${turnWord(turn)} now.`;
    if (seg.endAction === EndAction.ARRIVE && remaining > 0.5) return `Walk straight. ${seg.to} in about ${metres(remaining)}.`;
    if (seg.endAction === EndAction.ARRIVE) return `${seg.to} should be just ahead.`;
    return 'Walk straight.';
  }

  matchesTurn(net, dir) {
    const tol = this.config.turnMatchToleranceDeg;
    if (dir === TurnDir.LEFT) return Math.abs(net + 90) <= tol;
    if (dir === TurnDir.RIGHT) return Math.abs(net - 90) <= tol;
    return Math.abs(Math.abs(net) - 180) <= tol;
  }

  sightingDistance(lm, heightFraction) {
    const c = this.config;
    if (lm.sightingDistanceM != null) return lm.sightingDistanceM;
    if (c.plateSizeCalib > 0 && heightFraction > 0) {
      return Math.min(c.maxSightingDistanceM, Math.max(c.minSightingDistanceM, c.plateSizeCalib / heightFraction));
    }
    return c.sightingDistanceM;
  }

  snapshot() {
    const seg = this.segment;
    return {
      state: this.state,
      segmentIndex: this.segIndex,
      segmentId: seg.id,
      segmentFrom: seg.from,
      segmentTo: seg.to,
      positionM: this.s,
      segmentLengthM: seg.lengthM,
      sigmaM: this.sigma,
      totalSteps: this.totalSteps,
      netTurnDeg: this.netTurn,
      turnPending: this.pending != null,
      offCourse: this.offCourse,
      awaitingStartTurn: this.awaitingStartTurn,
      lastLandmark: this.lastLandmark,
      confidence: this.confidence,
    };
  }

  speak(text, urgent = false) { this.out({ type: 'speak', text, urgent }); }
  haptic(kind) { this.out({ type: 'haptic', kind }); }
  log(event, detail = '') { this.out({ type: 'log', event, detail }); }
}
