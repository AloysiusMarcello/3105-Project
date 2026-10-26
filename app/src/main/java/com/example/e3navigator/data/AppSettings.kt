package com.example.e3navigator.data

import android.content.Context
import com.example.e3navigator.core.NavConfig

/** User-tunable parameters, persisted on the phone. Everything else uses NavConfig defaults. */
class AppSettings(context: Context) {
    private val prefs = context.getSharedPreferences("e3nav", Context.MODE_PRIVATE)
    private val defaults = NavConfig()

    var stepLengthM: Double
        get() = prefs.getFloat("stepLengthM", defaults.stepLengthM.toFloat()).toDouble()
        set(v) = prefs.edit().putFloat("stepLengthM", v.toFloat()).apply()

    var sightingDistanceM: Double
        get() = prefs.getFloat("sightingDistanceM", defaults.sightingDistanceM.toFloat()).toDouble()
        set(v) = prefs.edit().putFloat("sightingDistanceM", v.toFloat()).apply()

    var plateSizeCalib: Double
        get() = prefs.getFloat("plateSizeCalib", defaults.plateSizeCalib.toFloat()).toDouble()
        set(v) = prefs.edit().putFloat("plateSizeCalib", v.toFloat()).apply()

    var maxSigmaM: Double
        get() = prefs.getFloat("maxSigmaM", defaults.maxSigmaM.toFloat()).toDouble()
        set(v) = prefs.edit().putFloat("maxSigmaM", v.toFloat()).apply()

    var driftFraction: Double
        get() = prefs.getFloat("driftFraction", defaults.driftFraction.toFloat()).toDouble()
        set(v) = prefs.edit().putFloat("driftFraction", v.toFloat()).apply()

    /** true = Android hardware step detector (if present), false = app's accelerometer detector. */
    var useHardwareStepDetector: Boolean
        get() = prefs.getBoolean("useHardwareStep", false)
        set(v) = prefs.edit().putBoolean("useHardwareStep", v).apply()

    /**
     * Minimum media volume (% of max) when navigation starts: raised only if the phone is quieter,
     * so a muted phone still speaks. 0 = leave as is. (Key renamed from the old 80% default.)
     */
    var guidanceVolumePct: Int
        get() = prefs.getInt("minGuidanceVolumePct", 30)
        set(v) = prefs.edit().putInt("minGuidanceVolumePct", v.coerceIn(0, 100)).apply()

    /** Weinberg constant for adaptive step length (set by the calibration walk). 0 = not calibrated. */
    var weinbergK: Double
        get() = prefs.getFloat("weinbergK", 0f).toDouble()
        set(v) = prefs.edit().putFloat("weinbergK", v.toFloat()).apply()

    /** Estimate each step's length from its bounce (shorter steps in crowds) instead of a fixed length. */
    var adaptiveSteps: Boolean
        get() = prefs.getBoolean("adaptiveSteps", true)
        set(v) = prefs.edit().putBoolean("adaptiveSteps", v).apply()

    /** Dim the screen while navigating (it faces the user's chest). Turn off for demos with sighted testers. */
    var dimWhileNavigating: Boolean
        get() = prefs.getBoolean("dimWhileNavigating", true)
        set(v) = prefs.edit().putBoolean("dimWhileNavigating", v).apply()

    var speechRate: Float
        get() = prefs.getFloat("speechRate", 1.0f)
        set(v) = prefs.edit().putFloat("speechRate", v).apply()

    fun toConfig(): NavConfig = defaults.copy(
        stepLengthM = stepLengthM,
        sightingDistanceM = sightingDistanceM,
        plateSizeCalib = plateSizeCalib,
        maxSigmaM = maxSigmaM,
        driftFraction = driftFraction,
    )
}
