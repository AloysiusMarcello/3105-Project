package com.example.e3navigator.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StepFusionTest {
    private val HW = StepFusion.Source.HARDWARE
    private val ACC = StepFusion.Source.ACCEL

    @Test
    fun silentHardwareDetectorFallsBackToAccelerometer() {
        val f = StepFusion(preferHardware = true)
        var counted = 0
        var t = 0L
        repeat(20) { t += 550; if (f.onStep(ACC, t)) counted++ } // hardware never reports
        assertEquals(ACC, f.active)
        assertTrue("almost every step should count, got $counted", counted >= 18)
    }

    @Test
    fun workingHardwareDetectorIsKeptAndNotDoubleCounted() {
        val f = StepFusion(preferHardware = true)
        var counted = 0
        var t = 0L
        repeat(20) {
            t += 550
            if (f.onStep(HW, t)) counted++
            if (f.onStep(ACC, t + 30)) counted++
        }
        assertEquals(HW, f.active)
        assertEquals(20, counted)
    }

    @Test
    fun switchesBackIfAccelerometerGoesQuiet() {
        val f = StepFusion(preferHardware = false)
        var t = 0L
        repeat(10) { t += 550; f.onStep(HW, t) } // accel silent (e.g. odd mounting)
        assertEquals(HW, f.active)
        assertFalse(f.onStep(ACC, t + 10)) // accel resumes but hardware is fine: no flip-flop
        assertEquals(HW, f.active)
    }
}
