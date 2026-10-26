package com.example.e3navigator.core

import kotlin.math.sqrt

/**
 * Accelerometer-based step detector (fallback / alternative to Android's hardware
 * TYPE_STEP_DETECTOR, which is missing on some phones and adds latency on others).
 *
 * Method: magnitude of acceleration minus gravity -> low-pass filter -> peak detection with
 * hysteresis and a minimum interval between steps. All thresholds are tunable so the team
 * can report them.
 */
class AccelStepDetector(
    /** Filtered acceleration (m/s^2 above gravity) that must be exceeded to start a step. */
    private val highThreshold: Double = 1.0,
    /** Signal must fall below this before the next step can be counted. */
    private val lowThreshold: Double = 0.2,
    /** Minimum time between steps (300 ms = 200 steps/min, faster than walking). */
    private val minIntervalMs: Long = 300,
    /** Low-pass time constant. */
    private val filterTauMs: Double = 60.0,
) {
    private var filtered = 0.0
    private var lastTimestampMs = -1L
    private var armed = true
    private var lastStepMs = Long.MIN_VALUE / 2

    /** Feed one accelerometer sample (including gravity). Returns true if a step was detected. */
    fun onSample(timestampMs: Long, ax: Double, ay: Double, az: Double): Boolean {
        val magnitude = sqrt(ax * ax + ay * ay + az * az) - GRAVITY
        if (lastTimestampMs < 0) {
            lastTimestampMs = timestampMs
            filtered = magnitude
            return false
        }
        val dt = (timestampMs - lastTimestampMs).coerceAtLeast(1).toDouble()
        lastTimestampMs = timestampMs
        val alpha = dt / (filterTauMs + dt)
        filtered += alpha * (magnitude - filtered)

        if (!armed && filtered < lowThreshold) armed = true
        if (armed && filtered > highThreshold && timestampMs - lastStepMs >= minIntervalMs) {
            armed = false
            lastStepMs = timestampMs
            return true
        }
        return false
    }

    val currentFiltered: Double get() = filtered

    fun reset() {
        filtered = 0.0
        lastTimestampMs = -1L
        armed = true
        lastStepMs = Long.MIN_VALUE / 2
    }

    companion object {
        const val GRAVITY = 9.80665
    }
}
