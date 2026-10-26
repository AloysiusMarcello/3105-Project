package com.example.e3navigator.core

/**
 * Every tunable number in the navigation logic lives here, so the team can adjust and
 * report them (Section 5 / 9.2 of the report) without touching the algorithms.
 */
data class NavConfig(
    // ---- Dead reckoning ----
    /** Calibrated step length. Overwritten by the in-app calibration. */
    val stepLengthM: Double = 0.65,
    /** Position uncertainty grows by this fraction of the distance walked since the last fix. */
    val driftFraction: Double = 0.10,
    /** Uncertainty at the known starting point. */
    val startSigmaM: Double = 0.5,
    /** Above this uncertainty the system stops giving directions (fail-safe, F9). */
    val maxSigmaM: Double = 3.0,

    // ---- Landmarks (camera) ----
    /** Measurement uncertainty of a confirmed sign sighting. */
    val landmarkSigmaM: Double = 1.0,
    /** Assumed distance from user to plate when it is read (used when plateSizeCalib == 0). */
    val sightingDistanceM: Double = 2.5,
    /**
     * Optional size-based range estimate: distance = plateSizeCalib / (text box height / image height).
     * Calibrate in survey mode by reading a plate from a measured distance. 0 = disabled.
     */
    val plateSizeCalib: Double = 0.0,
    val minSightingDistanceM: Double = 0.5,
    val maxSightingDistanceM: Double = 6.0,
    /** A landmark is confirmed after this many OCR hits ... */
    val landmarkMinHits: Int = 2,
    /** ... within this time window. */
    val landmarkWindowMs: Long = 1500,
    /** After a fix from a landmark, ignore further fixes from the same landmark for this long. */
    val landmarkCooldownMs: Long = 2000,

    // ---- Turns ----
    /** A detected turn is only accepted within this distance (+ current uncertainty) of the junction. */
    val turnWindowM: Double = 4.0,
    /** Steps that must follow an accepted turn before the route advances to the next segment. */
    val turnConfirmSteps: Int = 3,
    /** Uncertainty after a confirmed junction turn (the junction itself is a position fix). */
    val turnFixSigmaM: Double = 1.0,
    /** Tolerance when comparing net rotation to the expected 90/180 degrees. */
    val turnMatchToleranceDeg: Double = 45.0,
    /** Net rotation that counts as "user has turned off the corridor". */
    val offCourseDeg: Double = 60.0,
    /** Clear an "off the corridor" warning after this many steps without a turn back (phone twisted, not the user). */
    val offCourseTimeoutSteps: Int = 6,
    /** If the user walks this many steps without making a required start turn, assume it was already made. */
    val startTurnGraceSteps: Int = 4,

    // ---- Guidance timing (report §5: announce 2–3 m before a change of direction) ----
    val turnAnnounceM: Double = 2.5,
    val turnNowM: Double = 0.5,
    /** Alert when the user is this far past a turn/destination (report §5: 2 m boundary). */
    val overshootM: Double = 2.0,
    /** Arrival is declared within this distance of the waypoint (report §5: 0.5–1.0 m). */
    val arrivalToleranceM: Double = 1.0,
    /** Arrival by dead reckoning alone requires uncertainty at or below this. */
    val arrivalMaxSigmaM: Double = 1.0,
    /** Exact distances ("in about 2 metres") only when uncertainty is at most this; otherwise "coming up soon". */
    val preciseCueMaxSigmaM: Double = 2.0,
    /** "Keep going straight, about N metres to …" every this many metres on long stretches. */
    val progressIntervalM: Double = 15.0,
    /** While localisation is lost, repeat the warning every N steps. */
    val lostReminderSteps: Int = 8,
)
