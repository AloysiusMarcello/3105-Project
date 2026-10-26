package com.example.e3navigator.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GuidanceTest {
    private val route = Route(
        "R", "test", listOf(
            Segment("S1", "Cheers", "E3-06-02", 18.0, EndAction.ARRIVE, arrivalSide = TurnDir.LEFT),
            Segment("S2", "E3-06-02", "corridor end", 55.0, EndAction.TURN_LEFT, startTurn = TurnDir.RIGHT),
            Segment("S3", "corridor end", "the toilet", 16.0, EndAction.ARRIVE, arrivalSide = TurnDir.LEFT),
            Segment("S4", "the toilet", "main corridor", 16.0, EndAction.TURN_RIGHT, startTurn = TurnDir.AROUND),
            Segment("S5", "main corridor", "E3-06-02", 47.0, EndAction.ARRIVE, arrivalSide = TurnDir.RIGHT),
        ),
    )

    private fun snap(state: NavState, seg: Int, s: Double, sigma: Double = 1.0, startTurn: Boolean = false) = NavSnapshot(
        state, seg, route.segments[seg].id, route.segments[seg].from, route.segments[seg].to, s,
        route.segments[seg].lengthM, sigma, 0, 0.0, false, false, startTurn, null,
    )

    @Test
    fun turnCardShowsDistanceAndThen() {
        val g = GuidanceBuilder.build(route, snap(NavState.TRACKING, 1, 40.0))
        assertEquals(Maneuver.TURN_LEFT, g.maneuver)
        assertEquals(15.0, g.distanceM!!, 1e-9)
        assertEquals(Maneuver.ARRIVE, g.then)
        assertEquals("the toilet", g.destination)
        assertEquals(15.0 + 16.0, g.remainingToDestinationM, 1e-9)
    }

    @Test
    fun atDoorAsksToFaceIt() {
        val g = GuidanceBuilder.build(route, snap(NavState.TRACKING, 0, 17.5))
        assertEquals(Maneuver.FACE_LEFT, g.maneuver)
    }

    @Test
    fun lostIsAWarning() {
        val g = GuidanceBuilder.build(route, snap(NavState.LOST, 1, 20.0))
        assertEquals(Maneuver.LOST, g.maneuver)
        assertTrue(g.warning)
    }

    @Test
    fun startTurnShownBeforeWalking() {
        val g = GuidanceBuilder.build(route, snap(NavState.TRACKING, 3, 0.0, startTurn = true))
        assertEquals(Maneuver.TURN_AROUND, g.maneuver)
    }

    @Test
    fun geometryFollowsTurns() {
        val geo = RouteGeometry(route)
        // S1+S2 go north 73 m, left turn => S3 heads west, around => S4 east, right => S5 south
        assertEquals(0.0, geo.headingAt(0), 1e-9)
        assertEquals(0.0, geo.headingAt(1), 1e-9) // start turn RIGHT just undoes facing the door
        assertEquals(270.0, geo.headingAt(2), 1e-9)
        assertEquals(90.0, geo.headingAt(3), 1e-9)
        assertEquals(180.0, geo.headingAt(4), 1e-9)
        val end = geo.pointAt(4, 47.0)
        assertEquals(0.0, end.x, 1e-6)
        assertEquals(73.0 - 47.0, end.y, 1e-6) // back at the E3-06-02 door, 18 m from Cheers... minus door gap
    }
}
