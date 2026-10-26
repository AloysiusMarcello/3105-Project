package com.example.e3navigator.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.pow

class StepLengthTest {
    @Test
    fun calibrationReproducesMeasuredDistance() {
        val amps = List(15) { 2.0 + (it % 3) * 0.5 } // varied bounces
        val k = StepLengthModel.calibrateK(10.0, amps)!!
        val model = StepLengthModel(fixedM = 10.0 / 15, k = k)
        val total = amps.sumOf { model.length(it) }
        assertEquals(10.0, total, 0.3)
    }

    @Test
    fun smallerBounceMeansShorterStep() {
        val model = StepLengthModel(fixedM = 0.65, k = 0.65 / 2.5.pow(0.25))
        assertTrue(model.length(0.8) < model.length(2.5))
        assertEquals(0.65, model.length(2.5), 1e-9)
    }

    @Test
    fun lengthsAreClampedAroundCalibratedAverage() {
        val model = StepLengthModel(fixedM = 0.65, k = 0.65 / 2.5.pow(0.25))
        assertEquals(0.65 * 0.5, model.length(0.0001), 1e-9)
        assertEquals(0.65 * 1.4, model.length(500.0), 1e-9)
    }

    @Test
    fun fallsBackToFixedLength() {
        val off = StepLengthModel(fixedM = 0.7, k = 0.5, adaptive = false)
        assertEquals(0.7, off.length(3.0), 1e-9)
        val uncalibrated = StepLengthModel(fixedM = 0.7, k = 0.0)
        assertEquals(0.7, uncalibrated.length(3.0), 1e-9)
        assertEquals(0.7, StepLengthModel(0.7, 0.5).length(null), 1e-9)
    }

    @Test
    fun calibrationNeedsEnoughSteps() {
        assertNull(StepLengthModel.calibrateK(10.0, listOf(2.0, 2.0)))
        assertNull(StepLengthModel.calibrateK(10.0, List(10) { null }))
    }

    @Test
    fun trackerMeasuresPeakToTrough() {
        val t = StepAmplitudeTracker()
        assertNull(t.take())
        listOf(0.1, 1.8, -0.6, 0.4).forEach { t.onSample(it) }
        assertEquals(2.4, t.take()!!, 1e-9)
        assertNull(t.take())
    }
}
