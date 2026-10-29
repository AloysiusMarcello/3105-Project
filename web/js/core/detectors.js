import { TurnDir } from './route.js';

export const GRAVITY = 9.80665;

/**
 * Accelerometer-based step detector (port of StepDetector.kt). Browsers have no hardware step
 * detector, so this is the only step source in the web version.
 *
 * Method: magnitude of acceleration minus gravity -> low-pass filter -> peak detection with
 * hysteresis and a minimum interval between steps. All thresholds are tunable so the team
 * can report them.
 */
export class AccelStepDetector {
  constructor({
    /** Filtered acceleration (m/s^2 above gravity) that must be exceeded to start a step. */
    highThreshold = 1.0,
    /** Signal must fall below this before the next step can be counted. */
    lowThreshold = 0.2,
    /** Minimum time between steps (300 ms = 200 steps/min, faster than walking). */
    minIntervalMs = 300,
    /** Low-pass time constant. */
    filterTauMs = 60.0,
  } = {}) {
    Object.assign(this, { highThreshold, lowThreshold, minIntervalMs, filterTauMs });
    this.reset();
  }

  /** Feed one accelerometer sample (including gravity). Returns true if a step was detected. */
  onSample(timestampMs, ax, ay, az) {
    const magnitude = Math.sqrt(ax * ax + ay * ay + az * az) - GRAVITY;
    if (this.lastTimestampMs < 0) {
      this.lastTimestampMs = timestampMs;
      this.filtered = magnitude;
      return false;
    }
    const dt = Math.max(1, timestampMs - this.lastTimestampMs);
    this.lastTimestampMs = timestampMs;
    const alpha = dt / (this.filterTauMs + dt);
    this.filtered += alpha * (magnitude - this.filtered);

    if (!this.armed && this.filtered < this.lowThreshold) this.armed = true;
    if (this.armed && this.filtered > this.highThreshold && timestampMs - this.lastStepMs >= this.minIntervalMs) {
      this.armed = false;
      this.lastStepMs = timestampMs;
      return true;
    }
    return false;
  }

  get currentFiltered() {
    return this.filtered;
  }

  reset() {
    this.filtered = 0;
    this.lastTimestampMs = -1;
    this.armed = true;
    this.lastStepMs = -Infinity;
  }
}

/** Smallest signed difference a - b in (-180, 180]. */
export function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function normaliseDeg(a) {
  const r = a % 360;
  return r < 0 ? r + 360 : r;
}

/**
 * Detects sustained changes in walking heading (port of TurnDetector.kt).
 *
 * Input is the heading of the camera direction projected onto the horizontal plane
 * (degrees, clockwise positive), so it works even though a chest-mounted phone is tilted.
 *
 * A turn is reported only if the heading stays more than thresholdDeg away from the
 * reference heading for holdMs. Brief body rotations (e.g. dodging another student) that
 * return within the hold time are ignored. The reference slowly follows the heading while no
 * turn is in progress, so gyro drift and gentle corridor curvature do not accumulate.
 *
 * Whether a rotation is the route's junction turn is decided by NavigationEngine.
 */
export class TurnDetector {
  constructor({ thresholdDeg = 60, holdMs = 700, aroundDeg = 135, referenceTauMs = 5000 } = {}) {
    Object.assign(this, { thresholdDeg, holdMs, aroundDeg, referenceTauMs });
    this.reset();
  }

  /** Feed a heading sample; returns {direction, angleDeg, timestampMs} when a sustained turn completes. */
  onHeading(timestampMs, headingDeg) {
    const ref = this.reference;
    if (ref == null) {
      this.reference = normaliseDeg(headingDeg);
      this.lastTs = timestampMs;
      return null;
    }
    const dt = Math.max(0, timestampMs - this.lastTs);
    this.lastTs = timestampMs;
    const delta = angleDiff(headingDeg, ref);

    if (Math.abs(delta) < this.thresholdDeg) {
      this.candidateSince = null;
      // Follow slow drift only while no turn is in progress.
      const alpha = dt / (this.referenceTauMs + dt);
      this.reference = normaliseDeg(ref + alpha * delta);
      return null;
    }

    if (this.candidateSince == null) this.candidateSince = timestampMs;
    if (timestampMs - this.candidateSince >= this.holdMs) {
      this.candidateSince = null;
      this.reference = normaliseDeg(headingDeg);
      let direction;
      if (Math.abs(delta) >= this.aroundDeg) direction = TurnDir.AROUND;
      else direction = delta > 0 ? TurnDir.RIGHT : TurnDir.LEFT;
      return { direction, angleDeg: delta, timestampMs };
    }
    return null;
  }

  /** Signed angle from the reference to the latest heading, for display. */
  deltaFromReference(headingDeg) {
    return this.reference == null ? 0 : angleDiff(headingDeg, this.reference);
  }

  reset() {
    this.reference = null;
    this.candidateSince = null;
    this.lastTs = -1;
  }
}

/**
 * Per-step length estimate (Weinberg model): L = K · (aMax − aMin)^¼ (port of StepLength.kt).
 *
 * The vertical bounce of each step grows with step length, so a short shuffling step in a
 * crowd produces a small bounce and counts as a short step. K is calibrated by walking a
 * measured distance.
 *
 * Reference: H. Weinberg, "Using the ADXL202 in pedometer and personal navigation applications",
 * Analog Devices AN-602, 2002.
 */
export class StepLengthModel {
  constructor(fixedM, k = 0, adaptive = true, minFraction = 0.5, maxFraction = 1.4) {
    /** Calibrated average step length; used when adaptive mode is off or no bounce data is available. */
    this.fixedM = fixedM;
    /** Weinberg constant K; 0 = not calibrated. */
    this.k = k;
    this.adaptive = adaptive;
    /** Adaptive lengths are kept within these fractions of the calibrated average (rejects glitches). */
    this.minFraction = minFraction;
    this.maxFraction = maxFraction;
  }

  get isAdaptiveActive() {
    return this.adaptive && this.k > 0;
  }

  length(amplitude) {
    if (!this.isAdaptiveActive || amplitude == null || amplitude <= 0) return this.fixedM;
    const l = this.k * amplitude ** 0.25;
    return Math.min(this.fixedM * this.maxFraction, Math.max(this.fixedM * this.minFraction, l));
  }

  /**
   * K from a calibration walk of `distanceM` metres with one bounce amplitude per detected step.
   * Steps with no amplitude are assumed average. Returns null if there is too little data.
   */
  static calibrateK(distanceM, amplitudes) {
    const valid = amplitudes.filter((a) => a != null && a > 0);
    if (amplitudes.length < 5 || valid.length < Math.floor(amplitudes.length / 2)) return null;
    const meanRoot = valid.reduce((acc, a) => acc + a ** 0.25, 0) / valid.length;
    return distanceM / (meanRoot * amplitudes.length);
  }
}

/** Tracks the peak-to-trough of the (filtered) acceleration between consecutive steps. */
export class StepAmplitudeTracker {
  constructor() {
    this.max = -Infinity;
    this.min = Infinity;
  }

  onSample(value) {
    if (value > this.max) this.max = value;
    if (value < this.min) this.min = value;
  }

  /** Amplitude since the last call, then resets. Null if no samples arrived. */
  take() {
    const a = Number.isFinite(this.max) && Number.isFinite(this.min) ? this.max - this.min : null;
    this.max = -Infinity;
    this.min = Infinity;
    return a;
  }
}
