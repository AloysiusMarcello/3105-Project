package com.example.e3navigator.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

class LandmarkMatcherTest {
    @Test
    fun matchesPlainAndSpacedText() {
        assertTrue(LandmarkMatcher.matches("E3-06-02", "E3-06-02"))
        assertTrue(LandmarkMatcher.matches("e3 06 02", "E3-06-02"))
        assertTrue(LandmarkMatcher.matches("Tutorial Room E3-06-02", "E3-06-02"))
    }

    @Test
    fun foldsCommonOcrConfusions() {
        assertTrue(LandmarkMatcher.matches("E3-O6-O2", "E3-06-02"))
        assertTrue(LandmarkMatcher.matches("E3-06-0Z", "E3-06-02"))
        assertTrue(LandmarkMatcher.matches("E3-D6-O2", "E3-06-02"))
        assertTrue(LandmarkMatcher.matches("E3–06–02", "E3-06-02")) // en-dashes
        assertTrue(LandmarkMatcher.matches("E3-0G-0Z", "E3-06-02"))
    }

    @Test
    fun wordAfterCodeDoesNotBlockMatch() {
        // S, T, B, ... fold to digits, but a separate word is not part of the room number.
        assertTrue(LandmarkMatcher.matches("E3-06-02 SEMINAR", "E3-06-02"))
        assertTrue(LandmarkMatcher.matches("E3-06-02 TUTORIAL ROOM", "E3-06-02"))
        assertTrue(LandmarkMatcher.matches("LAB E3-06-02", "E3-06-02"))
        // Attached, or a real digit even after a space, still rejects.
        assertFalse(LandmarkMatcher.matches("E3-06-02S", "E3-06-02"))
        assertFalse(LandmarkMatcher.matches("E3-06-02 1", "E3-06-02"))
    }

    @Test
    fun rejectsNeighbouringRoomsAndLongerNumbers() {
        assertFalse(LandmarkMatcher.matches("E3-06-03", "E3-06-02"))
        assertFalse(LandmarkMatcher.matches("E3-06-021", "E3-06-02"))
        assertFalse(LandmarkMatcher.matches("E3-06-12", "E3-06-02"))
    }

    @Test
    fun aliasesMatch() {
        val lm = Landmark("L", "E3-06-02", 0.0, aliases = listOf("06-02"))
        assertTrue(LandmarkMatcher.matches("ROOM 06-02", lm))
        // A short alias must not match inside a different room's code.
        assertFalse(LandmarkMatcher.matches("E4-06-02", lm))
    }

    @Test
    fun confirmerNeedsRepeatedHitsInsideWindow() {
        val c = LandmarkConfirmer(minHits = 2, windowMs = 1500)
        assertFalse(c.hit("A", 0))
        assertFalse(c.hit("A", 3000)) // too far apart
        assertTrue(c.hit("A", 3500))
        assertFalse(c.hit("A", 3600)) // history cleared after confirmation
    }
}

class TurnDetectorTest {
    /** Rotate from [from] to [to] degrees over [durationMs], then hold for [holdMs]; 50 Hz. */
    private fun feed(d: TurnDetector, startMs: Long, from: Double, to: Double, durationMs: Long, holdMs: Long): List<TurnEvent> {
        val events = ArrayList<TurnEvent>()
        var t = startMs
        while (t <= startMs + durationMs) {
            val f = (t - startMs).toDouble() / durationMs
            d.onHeading(t, from + (to - from) * f)?.let { events += it }
            t += 20
        }
        val end = t + holdMs
        while (t <= end) {
            d.onHeading(t, to)?.let { events += it }
            t += 20
        }
        return events
    }

    @Test
    fun detectsRightTurn() {
        val d = TurnDetector()
        feed(d, 0, 10.0, 10.0, 1000, 0)
        val ev = feed(d, 1000, 10.0, 100.0, 1000, 1500)
        assertEquals(1, ev.size)
        assertEquals(TurnDir.RIGHT, ev[0].direction)
        assertEquals(90.0, ev[0].angleDeg, 8.0)
    }

    @Test
    fun detectsLeftTurnAcrossNorth() {
        val d = TurnDetector()
        feed(d, 0, 20.0, 20.0, 1000, 0)
        val ev = feed(d, 1000, 20.0, -70.0, 1000, 1500)
        assertEquals(1, ev.size)
        assertEquals(TurnDir.LEFT, ev[0].direction)
    }

    @Test
    fun detectsTurnAround() {
        val d = TurnDetector()
        feed(d, 0, 0.0, 0.0, 1000, 0)
        val ev = feed(d, 1000, 0.0, 180.0, 1500, 1500)
        assertEquals(1, ev.size)
        assertEquals(TurnDir.AROUND, ev[0].direction)
    }

    @Test
    fun ignoresBriefDodge() {
        val d = TurnDetector()
        feed(d, 0, 0.0, 0.0, 1000, 0)
        val out = feed(d, 1000, 0.0, 70.0, 300, 300) + feed(d, 1700, 70.0, 0.0, 300, 1500)
        assertTrue("brief rotation should not be a turn", out.isEmpty())
    }

    @Test
    fun ignoresSlowDrift() {
        val d = TurnDetector()
        // 40 degrees of drift over 60 s
        val out = feed(d, 0, 0.0, 40.0, 60_000, 1000)
        assertTrue(out.isEmpty())
    }

    @Test
    fun angleDiffWraps() {
        assertEquals(20.0, TurnDetector.angleDiff(10.0, 350.0), 1e-9)
        assertEquals(-20.0, TurnDetector.angleDiff(350.0, 10.0), 1e-9)
    }
}

class AccelStepDetectorTest {
    private fun walk(det: AccelStepDetector, seconds: Double, cadenceHz: Double, amplitude: Double, noise: Double): Int {
        val rnd = java.util.Random(42)
        var steps = 0
        var t = 0L
        while (t < seconds * 1000) {
            val vertical = amplitude * sin(2 * PI * cadenceHz * t / 1000.0) + noise * rnd.nextGaussian()
            if (det.onSample(t, 0.3, AccelStepDetector.GRAVITY + vertical, 0.2)) steps++
            t += 20 // 50 Hz
        }
        return steps
    }

    @Test
    fun countsNormalWalking() {
        val steps = walk(AccelStepDetector(), seconds = 10.0, cadenceHz = 1.8, amplitude = 2.5, noise = 0.3)
        assertEquals(18.0, steps.toDouble(), 1.0)
    }

    @Test
    fun countsSlowWalking() {
        val steps = walk(AccelStepDetector(), seconds = 10.0, cadenceHz = 1.2, amplitude = 1.8, noise = 0.3)
        assertEquals(12.0, steps.toDouble(), 1.0)
    }

    @Test
    fun noStepsWhenStandingStill() {
        val steps = walk(AccelStepDetector(), seconds = 10.0, cadenceHz = 1.8, amplitude = 0.0, noise = 0.15)
        assertEquals(0, steps)
    }

    @Test
    fun resetClearsState() {
        val d = AccelStepDetector()
        d.onSample(0, 0.0, 12.0, 0.0)
        d.reset()
        assertEquals(0.0, d.currentFiltered, 1e-9)
        assertNull(null as Any?)
        assertNotNull(d)
    }
}
