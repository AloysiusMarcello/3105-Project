package com.example.e3navigator.core

import kotlin.math.abs

data class TurnEvent(
    val direction: TurnDir,
    /** Signed rotation in degrees: positive = clockwise (right), negative = anticlockwise (left). */
    val angleDeg: Double,
    val timestampMs: Long,
)

/**
 * Detects sustained changes in walking heading.
 *
 * Input is the heading of the camera direction projected onto the horizontal plane
 * (degrees, clockwise positive), computed by the app from the game rotation vector, so it
 * works even though a chest-mounted phone is tilted.
 *
 * A turn is reported only if the heading stays more than [thresholdDeg] away from the
 * reference heading for [holdMs]. Brief body rotations (e.g. dodging another student) that
 * return within the hold time are ignored. The reference slowly follows the heading while no
 * turn is in progress, so gyro drift and gentle corridor curvature do not accumulate.
 *
 * Note the detector only reports rotations. Whether a rotation is the route's junction turn
 * is decided by [NavigationEngine], using the route position.
 */
class TurnDetector(
    private val thresholdDeg: Double = 60.0,
    private val holdMs: Long = 700,
    private val aroundDeg: Double = 135.0,
    /** Time constant for the reference to follow slow heading changes. */
    private val referenceTauMs: Double = 5000.0,
) {
    private var reference: Double? = null
    private var lastTs = -1L
    private var candidateSince: Long? = null

    /** Feed a heading sample; returns a TurnEvent when a sustained turn completes. */
    fun onHeading(timestampMs: Long, headingDeg: Double): TurnEvent? {
        val ref = reference
        if (ref == null) {
            reference = normalise(headingDeg)
            lastTs = timestampMs
            return null
        }
        val dt = (timestampMs - lastTs).coerceAtLeast(0)
        lastTs = timestampMs
        val delta = angleDiff(headingDeg, ref)

        if (abs(delta) < thresholdDeg) {
            candidateSince = null
            // Follow slow drift only while no turn is in progress.
            val alpha = dt / (referenceTauMs + dt)
            reference = normalise(ref + alpha * delta)
            return null
        }

        val since = candidateSince ?: timestampMs.also { candidateSince = it }
        if (timestampMs - since >= holdMs) {
            candidateSince = null
            reference = normalise(headingDeg)
            val dir = when {
                abs(delta) >= aroundDeg -> TurnDir.AROUND
                delta > 0 -> TurnDir.RIGHT
                else -> TurnDir.LEFT
            }
            return TurnEvent(dir, delta, timestampMs)
        }
        return null
    }

    /** Signed angle from the reference to the latest heading, for display. */
    fun deltaFromReference(headingDeg: Double): Double = reference?.let { angleDiff(headingDeg, it) } ?: 0.0

    fun reset() {
        reference = null
        candidateSince = null
        lastTs = -1L
    }

    companion object {
        /** Smallest signed difference a - b in (-180, 180]. */
        fun angleDiff(a: Double, b: Double): Double {
            var d = (a - b) % 360.0
            if (d > 180.0) d -= 360.0
            if (d <= -180.0) d += 360.0
            return d
        }

        fun normalise(a: Double): Double {
            val r = a % 360.0
            return if (r < 0) r + 360.0 else r
        }
    }
}
