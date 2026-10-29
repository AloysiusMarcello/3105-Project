/**
 * Every tunable number in the navigation logic lives here, so the team can adjust and
 * report them (Section 5 / 9.2 of the report) without touching the algorithms.
 * (Port of NavConfig.kt; same names and defaults.)
 */
export const DEFAULT_CONFIG = Object.freeze({
  // ---- Dead reckoning ----
  /** Calibrated step length. Overwritten by the in-app calibration. */
  stepLengthM: 0.65,
  /** Position uncertainty grows by this fraction of the distance walked since the last fix. */
  driftFraction: 0.10,
  /** Uncertainty at the known starting point. */
  startSigmaM: 0.5,
  /** Above this uncertainty the system stops giving directions (fail-safe, F9). */
  maxSigmaM: 3.0,

  // ---- Landmarks (camera) ----
  /** Measurement uncertainty of a confirmed sign sighting. */
  landmarkSigmaM: 1.0,
  /** Assumed distance from user to plate when it is read (used when plateSizeCalib == 0). */
  sightingDistanceM: 2.5,
  /**
   * Optional size-based range estimate: distance = plateSizeCalib / (text box height / image height).
   * Calibrate in survey mode by reading a plate from a measured distance. 0 = disabled.
   */
  plateSizeCalib: 0.0,
  minSightingDistanceM: 0.5,
  maxSightingDistanceM: 6.0,
  /** A landmark is confirmed after this many OCR hits ... */
  landmarkMinHits: 2,
  /** ... within this time window. */
  landmarkWindowMs: 1500,
  /** After a fix from a landmark, ignore further fixes from the same landmark for this long. */
  landmarkCooldownMs: 2000,

  // ---- Turns ----
  /** A detected turn is only accepted within this distance (+ current uncertainty) of the junction. */
  turnWindowM: 4.0,
  /** Steps that must follow an accepted turn before the route advances to the next segment. */
  turnConfirmSteps: 3,
  /** Uncertainty after a confirmed junction turn (the junction itself is a position fix). */
  turnFixSigmaM: 1.0,
  /** Tolerance when comparing net rotation to the expected 90/180 degrees. */
  turnMatchToleranceDeg: 45.0,
  /** Net rotation that counts as "user has turned off the corridor". */
  offCourseDeg: 60.0,
  /** Clear an "off the corridor" warning after this many steps without a turn back (phone twisted, not the user). */
  offCourseTimeoutSteps: 6,
  /** If the user walks this many steps without making a required start turn, assume it was already made. */
  startTurnGraceSteps: 4,

  // ---- Guidance timing (report §5: announce 2–3 m before a change of direction) ----
  turnAnnounceM: 2.5,
  turnNowM: 0.5,
  /** Alert when the user is this far past a turn/destination (report §5: 2 m boundary). */
  overshootM: 2.0,
  /** Arrival is declared within this distance of the waypoint (report §5: 0.5–1.0 m). */
  arrivalToleranceM: 1.0,
  /** Arrival by dead reckoning alone requires uncertainty at or below this. */
  arrivalMaxSigmaM: 1.0,
  /** Exact distances ("in about 2 metres") only when uncertainty is at most this; otherwise "coming up soon". */
  preciseCueMaxSigmaM: 2.0,
  /** "Keep going straight, about N metres to …" every this many metres on long stretches. */
  progressIntervalM: 15.0,
  /** While localisation is lost, repeat the warning every N steps. */
  lostReminderSteps: 8,
});

export function makeConfig(overrides = {}) {
  return { ...DEFAULT_CONFIG, ...overrides };
}
