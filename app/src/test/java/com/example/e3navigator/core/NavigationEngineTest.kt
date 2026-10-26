package com.example.e3navigator.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Simulated walks along a test version of the E3 route.
 * These run on the JVM (no phone needed): Android Studio → right-click the test folder → Run Tests.
 */
class NavigationEngineTest {

    private val route = Route(
        id = "TEST",
        name = "Test route",
        segments = listOf(
            Segment(
                "S1", "Cheers", "Junction A", 20.0, EndAction.TURN_RIGHT,
                startInstruction = "Walk straight ahead.",
                landmarks = listOf(Landmark("L1", "E3-05-10", 15.0)),
            ),
            Segment(
                "S2", "Junction A", "E3-06-02", 12.0, EndAction.ARRIVE,
                startInstruction = "Walk straight to E3-06-02.",
                arrivalMessage = "You have arrived at E3-06-02.",
                landmarks = listOf(
                    Landmark("L2", "E3-06-01", 5.0, announce = "Passing E3-06-01."),
                    Landmark("L3", "E3-06-02", 12.0, confirmsArrival = true),
                ),
            ),
            Segment(
                "S3", "E3-06-02", "Toilet", 15.0, EndAction.ARRIVE,
                startInstruction = "Continue straight to the toilet.",
                arrivalMessage = "You have arrived at the toilet.",
                landmarks = listOf(Landmark("L4", "TOILET", 15.0, confirmsArrival = true)),
            ),
            Segment(
                "S4", "Toilet", "E3-06-02", 15.0, EndAction.ARRIVE,
                startInstruction = "Turn around and walk straight back.",
                startTurn = TurnDir.AROUND,
                landmarks = listOf(Landmark("L5", "E3-06-02", 15.0, confirmsArrival = true)),
            ),
        ),
    )

    private class Harness(route: Route, config: NavConfig = NavConfig()) {
        val outputs = ArrayList<NavOutput>()
        var t = 0L
        val engine = NavigationEngine(route, config) { outputs += it }

        fun start() = engine.start(t)
        fun steps(n: Int) = repeat(n) { t += 550; engine.onStep(t) }
        fun stepsOf(n: Int, len: Double) = repeat(n) { t += 550; engine.onStep(t, len) }
        fun walkTo(metres: Double) {
            while (engine.snapshot().positionM + engine.config.stepLengthM <= metres + 1e-9) steps(1)
        }
        fun turn(dir: TurnDir, angle: Double) { t += 1000; engine.onTurn(TurnEvent(dir, angle, t)) }
        fun see(text: String, frames: Int = 2, heightFraction: Double = 0.0) = repeat(frames) {
            t += 300; engine.onText(listOf(TextObservation(text, heightFraction)), t)
        }
        fun speech() = outputs.filterIsInstance<NavOutput.Speak>().map { it.text }
        fun logs() = outputs.filterIsInstance<NavOutput.Log>().map { it.event }
        fun said(fragment: String) = speech().any { it.contains(fragment, ignoreCase = true) }
        fun snap() = engine.snapshot()
    }

    @Test
    fun completeRouteHappyPath() {
        val h = Harness(route)
        h.start()
        assertTrue(h.said("Navigation started"))

        // Segment 1: 20 m then right turn
        h.walkTo(20.2)
        // 20 m from the start with no sign: uncertainty ±2.5 m, so the cues are deliberately vague
        assertTrue(h.said("right turn is coming up soon"))
        assertTrue(h.said("You should be at the right turn. Stop"))
        h.turn(TurnDir.RIGHT, 88.0)
        assertEquals(0, h.snap().segmentIndex) // waits for confirming steps
        h.steps(3)
        assertEquals(1, h.snap().segmentIndex)
        assertTrue(h.said("Good. Now walk straight ahead"))

        // Segment 2: sees E3-06-01 then E3-06-02 plate ~2.5 m before the door
        h.walkTo(2.5)
        h.see("E3-06-01") // plate at 5 m, read from ~2.5 m away
        assertTrue(h.said("Passing E3-06-01"))
        h.walkTo(9.5)
        h.see("E3-06-02")
        h.walkTo(12.0)
        assertEquals(NavState.AWAITING_CONTINUE, h.snap().state)
        assertTrue(h.said("You have arrived at E3-06-02"))

        // Segment 3: to toilet
        h.engine.continueAfterArrival()
        assertTrue(h.said("Continue straight to the toilet"))
        h.walkTo(12.5)
        h.see("TOILET")
        h.walkTo(15.0)
        assertEquals(NavState.AWAITING_CONTINUE, h.snap().state)

        // Segment 4: turn around and return
        h.engine.continueAfterArrival()
        assertTrue(h.snap().awaitingStartTurn)
        h.turn(TurnDir.AROUND, 178.0)
        assertFalse(h.snap().awaitingStartTurn)
        h.walkTo(12.5)
        h.see("E3-06-02")
        h.walkTo(15.0)
        assertEquals(NavState.FINISHED, h.snap().state)
        assertTrue(h.said("Navigation complete"))
        assertFalse(h.logs().contains("lost"))
    }

    @Test
    fun rotationMidCorridorDoesNotAdvanceRoute() {
        val h = Harness(route)
        h.start()
        h.steps(10) // 6.5 m, far from the 20 m junction
        h.turn(TurnDir.RIGHT, 85.0)
        assertEquals(0, h.snap().segmentIndex)
        assertTrue(h.snap().offCourse)
        assertTrue(h.said("turned off the corridor"))

        val before = h.snap().positionM
        h.steps(3) // distance keeps counting even while the warning is active
        assertEquals(before + 3 * 0.65, h.snap().positionM, 1e-9)

        h.turn(TurnDir.LEFT, -83.0)
        assertFalse(h.snap().offCourse)
        assertTrue(h.said("Back on route"))

        h.walkTo(20.0)
        h.turn(TurnDir.RIGHT, 92.0)
        h.steps(3)
        assertEquals(1, h.snap().segmentIndex)
    }

    @Test
    fun twistedPhoneOffCourseWarningClearsItself() {
        val h = Harness(route)
        h.start()
        h.steps(5)
        h.turn(TurnDir.RIGHT, 75.0) // phone twists on its mount, user keeps walking straight
        assertTrue(h.snap().offCourse)
        h.steps(6)
        assertFalse(h.snap().offCourse)
        assertEquals(11 * 0.65, h.snap().positionM, 1e-9)
        // and the real junction turn still works afterwards
        h.walkTo(20.2)
        h.turn(TurnDir.RIGHT, 90.0)
        h.steps(3)
        assertEquals(1, h.snap().segmentIndex)
    }

    @Test
    fun wrongTurnAtJunctionIsCorrected() {
        val h = Harness(route)
        h.start()
        h.walkTo(20.0)
        h.turn(TurnDir.LEFT, -90.0)
        assertTrue(h.said("Wrong way"))
        h.turn(TurnDir.RIGHT, 90.0) // back to corridor heading: net 0, must NOT count as the right turn
        h.steps(3)
        assertEquals(0, h.snap().segmentIndex)
        h.turn(TurnDir.RIGHT, 90.0)
        h.steps(3)
        assertEquals(1, h.snap().segmentIndex)
    }

    @Test
    fun turnThatIsUndoneBeforeConfirmationIsCancelled() {
        val h = Harness(route)
        h.start()
        h.walkTo(19.0)
        h.turn(TurnDir.RIGHT, 80.0)
        assertTrue(h.snap().turnPending)
        h.steps(1)
        h.turn(TurnDir.LEFT, -80.0)
        assertFalse(h.snap().turnPending)
        h.steps(3)
        assertEquals(0, h.snap().segmentIndex)
    }

    @Test
    fun landmarkFusesWithDeadReckoning() {
        val h = Harness(route)
        h.start()
        h.steps(18) // 11.7 m, sigma 1.67
        val sigmaBefore = h.snap().sigmaM
        h.see("E3-05-10") // plate at 15 m read from 2.5 m => observation 12.5 m
        val snap = h.snap()
        assertTrue(snap.positionM > 11.7 && snap.positionM < 12.5)
        assertTrue(snap.sigmaM < sigmaBefore)
        assertTrue(snap.sigmaM < 1.0)
    }

    @Test
    fun singleOcrFrameIsNotEnough() {
        val h = Harness(route)
        h.start()
        h.steps(18)
        h.see("E3-05-10", frames = 1)
        assertFalse(h.logs().contains("landmark_confirmed"))
    }

    @Test
    fun duplicateTextInOneFrameCountsOnce() {
        val h = Harness(route)
        h.start()
        h.steps(18)
        // ML Kit can return the same plate as a line and as a block in the same frame
        h.engine.onText(listOf(TextObservation("E3-05-10"), TextObservation("Room E3-05-10")), 99_000)
        assertFalse(h.logs().contains("landmark_confirmed"))
    }

    @Test
    fun excessiveUncertaintyStopsGuidanceThenLandmarkRecovers() {
        val h = Harness(route, NavConfig(driftFraction = 0.2))
        h.start()
        h.steps(22) // 14.3 m: sigma = 0.5 + 0.2 * 14.3 = 3.36 > 3
        assertEquals(NavState.LOST, h.snap().state)
        assertTrue(h.said("Location uncertain"))

        // Steps while lost give no directions, only periodic reminders
        val spokenBefore = h.speech().size
        h.steps(8)
        assertEquals(spokenBefore + 1, h.speech().size)

        h.see("E3-05-10")
        assertEquals(NavState.TRACKING, h.snap().state)
        assertTrue(h.said("Location confirmed"))
        assertEquals(12.5, h.snap().positionM, 1e-9)
    }

    @Test
    fun confidenceDegradesWithDriftAndRecoversAtSign() {
        val h = Harness(route, NavConfig(driftFraction = 0.2))
        h.start()
        assertEquals(Confidence.HIGH, h.snap().confidence)
        h.steps(12) // 7.8 m: sigma = 0.5 + 1.56 = 2.06 > 2.0
        assertEquals(Confidence.MEDIUM, h.snap().confidence)
        h.steps(10) // sigma > 3: lost
        assertEquals(Confidence.LOW, h.snap().confidence)
        h.see("E3-05-10")
        assertEquals(Confidence.HIGH, h.snap().confidence)
        assertEquals(3, h.logs().count { it == "confidence" })
    }

    @Test
    fun walkingPastTurnRaisesAlert() {
        val h = Harness(route)
        h.start()
        h.steps(40) // 26 m on a 20 m segment, no turn
        assertEquals(NavState.LOST, h.snap().state)
        assertTrue(h.said("passed the right turn"))
    }

    @Test
    fun missedTurnIsInferredFromNextLandmark() {
        val h = Harness(route)
        h.start()
        h.walkTo(20.0)
        // No turn event (gyro missed it), but the camera reads a plate from segment 2
        h.see("E3-06-01")
        assertEquals(1, h.snap().segmentIndex)
        assertEquals(2.5, h.snap().positionM, 1e-9)
        assertTrue(h.logs().contains("turn_inferred_from_landmark"))
    }

    @Test
    fun landmarkFromFarAheadIsIgnoredWhileTracking() {
        val h = Harness(route)
        h.start()
        h.steps(5)
        h.see("TOILET") // segment 3 landmark, not plausible now
        assertEquals(0, h.snap().segmentIndex)
        assertTrue(h.logs().contains("landmark_out_of_sequence"))
    }

    @Test
    fun noArrivalByStepsAloneWhenUncertain() {
        val h = Harness(route)
        h.start()
        h.walkTo(20.0)
        h.turn(TurnDir.RIGHT, 90.0)
        h.steps(3)
        h.walkTo(12.0) // no camera confirmation; sigma > 1 m
        assertEquals(NavState.TRACKING, h.snap().state)
        h.steps(1)
        assertTrue(h.said("should be just ahead"))
        h.steps(10)
        assertEquals(NavState.LOST, h.snap().state)
        assertTrue(h.said("walked past E3-06-02"))
    }

    // ---- Behaviour added after surveying the real E3 route ----

    private val e3Like = Route(
        id = "E3LIKE", name = "door plates in recesses",
        segments = listOf(
            Segment(
                "A", "Cheers", "E3-06-02", 15.0, EndAction.ARRIVE,
                arrivalSide = TurnDir.LEFT,
                landmarks = listOf(Landmark("D1", "E3-06-02", 15.0, confirmsArrival = true, sightingDistanceM = 0.0)),
            ),
            Segment(
                "B", "E3-06-02", "corridor end", 50.0, EndAction.TURN_LEFT, startTurn = TurnDir.RIGHT, maxSigmaM = 7.0,
                landmarks = listOf(
                    Landmark("X1", "EXIT", 20.0, sightingDistanceM = 6.0),
                    Landmark("X2", "EXIT", 50.0, sightingDistanceM = 6.0),
                ),
            ),
            Segment("C", "corridor end", "the toilet", 16.0, EndAction.ARRIVE, arrivalSide = TurnDir.LEFT),
        ),
    )

    @Test
    fun turningToFaceDestinationDoorIsNotOffCourse() {
        val h = Harness(e3Like)
        h.start()
        h.walkTo(15.0)
        assertTrue(h.said("on your left"))
        assertTrue(h.said("turn left to face the door"))
        h.turn(TurnDir.LEFT, -85.0)
        assertFalse(h.snap().offCourse)
        assertFalse(h.said("turned off the corridor"))
        h.see("E3-06-02") // read at close range once facing the door
        assertEquals(NavState.AWAITING_CONTINUE, h.snap().state)
    }

    @Test
    fun longFeaturelessCorridorUsesSegmentUncertaintyLimit() {
        val h = Harness(e3Like)
        h.start()
        h.walkTo(15.0); h.turn(TurnDir.LEFT, -90.0); h.see("E3-06-02")
        h.engine.continueAfterArrival()
        h.turn(TurnDir.RIGHT, 90.0) // back along the corridor
        h.walkTo(40.0)              // 40 m with no sign: sigma ~5 m, above the global 3 m limit
        assertEquals(NavState.TRACKING, h.snap().state)
        assertTrue(h.snap().sigmaM > 3.0)
    }

    @Test
    fun repeatedSignTextMatchesNearestInstance() {
        val h = Harness(e3Like)
        h.start()
        h.walkTo(15.0); h.turn(TurnDir.LEFT, -90.0); h.see("E3-06-02")
        h.engine.continueAfterArrival()
        h.turn(TurnDir.RIGHT, 90.0)
        h.walkTo(42.0)
        h.see("EXIT") // must be X2 (end sign, read from 6 m => 44 m), not X1 at 20 m
        assertEquals(44.0, h.snap().positionM, 1.0)
    }

    @Test
    fun destinationWithoutTextSignArrivesByStepsAlone() {
        val h = Harness(e3Like)
        h.start()
        h.walkTo(15.0); h.turn(TurnDir.LEFT, -90.0); h.see("E3-06-02")
        h.engine.continueAfterArrival()
        h.turn(TurnDir.RIGHT, 90.0)
        h.walkTo(50.2)
        h.turn(TurnDir.LEFT, -90.0)
        h.steps(3)
        assertEquals(2, h.snap().segmentIndex)
        h.walkTo(16.0) // toilet door has only a pictogram
        assertEquals(NavState.FINISHED, h.snap().state)
    }

    // ---- Wording and adaptive steps ----

    @Test
    fun preciseCuesOnlyWhenConfident() {
        val h = Harness(e3Like)
        h.start()
        h.walkTo(15.0); h.turn(TurnDir.LEFT, -90.0); h.see("E3-06-02")
        h.engine.continueAfterArrival()
        h.turn(TurnDir.RIGHT, 90.0)
        h.walkTo(43.0)
        h.see("EXIT")             // fix: ±1 m
        h.walkTo(50.0)
        // The vague cue came first (±5 m); the EXIT sign fix then allows the exact ones
        assertTrue(h.said("left turn is coming up soon"))
        assertTrue(h.said("In about"))
        assertTrue(h.said("Stop. Turn left now"))
    }

    @Test
    fun progressUpdatesOnLongCorridor() {
        val h = Harness(e3Like)
        h.start()
        h.walkTo(15.0); h.turn(TurnDir.LEFT, -90.0); h.see("E3-06-02")
        h.engine.continueAfterArrival()
        h.turn(TurnDir.RIGHT, 90.0)
        h.walkTo(40.0)
        val updates = h.speech().filter { it.startsWith("Keep going straight") }
        assertTrue("expected at least 2 progress updates, got $updates", updates.size >= 2)
        assertTrue(updates.all { it.contains("to the left turn") })
    }

    @Test
    fun stopThenTurnConfirmsImmediately() {
        val h = Harness(route)
        h.start()
        h.walkTo(20.2)
        h.turn(TurnDir.RIGHT, 90.0)
        assertTrue(h.said("Good. Now walk straight ahead"))
        assertEquals(0, h.snap().segmentIndex) // still needs a few steps to commit
        h.steps(3)
        assertEquals(1, h.snap().segmentIndex)
    }

    @Test
    fun shortCrowdStepsCountShort() {
        val h = Harness(route)
        h.start()
        h.stepsOf(10, 0.40)
        assertEquals(4.0, h.snap().positionM, 1e-9)
    }

    @Test
    fun plateSizeGivesRangeEstimate() {
        // calib 0.15: text box at 10% of image height => 1.5 m away
        val h = Harness(route, NavConfig(plateSizeCalib = 0.15))
        h.start()
        h.walkTo(20.0)
        h.turn(TurnDir.RIGHT, 90.0)
        h.steps(3)
        h.walkTo(10.0)
        h.see("E3-06-02", heightFraction = 0.10)
        h.walkTo(11.7)
        assertEquals(NavState.AWAITING_CONTINUE, h.snap().state)
    }
}
