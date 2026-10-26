package com.example.e3navigator.core

import kotlin.math.pow

/**
 * Per-step length estimate (Weinberg model): L = K · (aMax − aMin)^¼
 *
 * The vertical bounce of each step grows with step length, so a short shuffling step in a
 * crowd produces a small bounce and counts as a short step, instead of every step counting as
 * the same calibrated length. K is calibrated by walking a measured distance.
 *
 * Reference: H. Weinberg, "Using the ADXL202 in pedometer and personal navigation applications",
 * Analog Devices AN-602, 2002.
 */
class StepLengthModel(
    /** Calibrated average step length; used when adaptive mode is off or no bounce data is available. */
    var fixedM: Double,
    /** Weinberg constant K; 0 = not calibrated. */
    var k: Double = 0.0,
    var adaptive: Boolean = true,
    /** Adaptive lengths are kept within these fractions of the calibrated average (rejects glitches). */
    private val minFraction: Double = 0.5,
    private val maxFraction: Double = 1.4,
) {
    val isAdaptiveActive: Boolean get() = adaptive && k > 0

    fun length(amplitude: Double?): Double {
        if (!isAdaptiveActive || amplitude == null || amplitude <= 0.0) return fixedM
        return (k * amplitude.pow(0.25)).coerceIn(fixedM * minFraction, fixedM * maxFraction)
    }

    companion object {
        /**
         * K from a calibration walk of [distanceM] metres with one bounce amplitude per detected step.
         * Steps with no amplitude are assumed average. Returns null if there is too little data.
         */
        fun calibrateK(distanceM: Double, amplitudes: List<Double?>): Double? {
            val valid = amplitudes.filterNotNull().filter { it > 0.0 }
            if (amplitudes.size < 5 || valid.size < amplitudes.size / 2) return null
            val meanRoot = valid.sumOf { it.pow(0.25) } / valid.size
            return distanceM / (meanRoot * amplitudes.size)
        }
    }
}

/** Tracks the peak-to-trough of the (filtered) acceleration between consecutive steps. */
class StepAmplitudeTracker {
    private var max = Double.NEGATIVE_INFINITY
    private var min = Double.POSITIVE_INFINITY

    fun onSample(value: Double) {
        if (value > max) max = value
        if (value < min) min = value
    }

    /** Amplitude since the last call, then resets. Null if no samples arrived. */
    fun take(): Double? {
        val a = if (max.isFinite() && min.isFinite()) max - min else null
        max = Double.NEGATIVE_INFINITY
        min = Double.POSITIVE_INFINITY
        return a
    }
}
