package com.example.e3navigator.core

/**
 * Chooses which step detector to trust, automatically.
 *
 * Two detectors run side by side: Android's hardware step detector and the app's accelerometer
 * detector. Only one feeds navigation at a time (otherwise every step counts twice). On some
 * phones the hardware detector reports late or not at all (it can wait ~10 steps before the
 * first report and miss stop-start walking), so if the active detector goes quiet while the
 * other keeps reporting, we switch to the other one.
 */
class StepFusion(
    preferHardware: Boolean,
    private val windowMs: Long = 4000,
    /** Steps the other detector must report in the window, while the active one reports none, to switch. */
    private val switchAfter: Int = 3,
) {
    enum class Source { HARDWARE, ACCEL }

    var active: Source = if (preferHardware) Source.HARDWARE else Source.ACCEL
        private set

    private val hw = ArrayDeque<Long>()
    private val accel = ArrayDeque<Long>()

    /** Last switch, for logging: (from, to) or null. */
    var lastSwitch: Pair<Source, Source>? = null
        private set

    /** Feed one step event; returns true if it should count as a step for navigation. */
    fun onStep(source: Source, timeMs: Long): Boolean {
        lastSwitch = null
        val mine = if (source == Source.HARDWARE) hw else accel
        mine.addLast(timeMs)
        prune(timeMs)
        if (source == active) return true

        // The other detector reported. Is the active one silent while this one is clearly walking?
        val activeQueue = if (active == Source.HARDWARE) hw else accel
        if (activeQueue.isEmpty() && mine.size >= switchAfter) {
            lastSwitch = active to source
            active = source
            return true
        }
        return false
    }

    fun reset(preferHardware: Boolean) {
        active = if (preferHardware) Source.HARDWARE else Source.ACCEL
        hw.clear(); accel.clear(); lastSwitch = null
    }

    private fun prune(now: Long) {
        while (hw.isNotEmpty() && now - hw.first() > windowMs) hw.removeFirst()
        while (accel.isNotEmpty() && now - accel.first() > windowMs) accel.removeFirst()
    }
}
