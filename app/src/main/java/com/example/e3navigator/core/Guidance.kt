package com.example.e3navigator.core

import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

/** What the instruction banner shows (Maps-style "turn card"). */
enum class Maneuver { STRAIGHT, TURN_LEFT, TURN_RIGHT, TURN_AROUND, ARRIVE, FACE_LEFT, FACE_RIGHT, LOST, DONE }

data class Guidance(
    val maneuver: Maneuver,
    /** Distance to the manoeuvre in metres; null when it applies now. */
    val distanceM: Double?,
    val title: String,
    val subtitle: String?,
    /** The manoeuvre after this one, for the "Then …" chip. */
    val then: Maneuver?,
    /** Next waypoint the user is heading to (E3-06-02, the toilet, …). */
    val destination: String,
    /** Walking distance left to [destination]. */
    val remainingToDestinationM: Double,
    val warning: Boolean = false,
)

object GuidanceBuilder {

    fun build(route: Route, snap: NavSnapshot, arrivalToleranceM: Double = 1.0): Guidance {
        val i = snap.segmentIndex
        val seg = route.segments[i]
        val remaining = max(0.0, seg.lengthM - snap.positionM)
        val (dest, toDest) = nextDestination(route, i, remaining)

        return when (snap.state) {
            NavState.IDLE -> Guidance(Maneuver.STRAIGHT, null, "Ready", route.name, null, dest, toDest)
            NavState.FINISHED -> Guidance(Maneuver.DONE, null, "You have arrived", seg.to, null, seg.to, 0.0)
            NavState.LOST -> Guidance(
                Maneuver.LOST, null, "Location uncertain", "Stop and face along the corridor", null, dest, toDest, warning = true,
            )
            NavState.AWAITING_CONTINUE -> {
                val next = route.segments.getOrNull(i + 1)
                val (nDest, nDist) = if (next != null) nextDestination(route, i + 1, next.lengthM) else seg.to to 0.0
                Guidance(Maneuver.ARRIVE, null, "Arrived at ${seg.to}", "Press volume up to continue",
                    next?.let { startManeuver(it) }, nDest, nDist)
            }
            NavState.TRACKING -> when {
                snap.awaitingStartTurn && seg.startTurn != null -> Guidance(
                    turnManeuver(seg.startTurn), null, "Turn ${turnWord(seg.startTurn)}", "then walk straight",
                    Maneuver.STRAIGHT, dest, toDest,
                )
                snap.offCourse -> Guidance(
                    Maneuver.TURN_AROUND, null, "Turn back", "You may have left the corridor", null, dest, toDest, warning = true,
                )
                snap.turnPending -> Guidance(
                    Maneuver.STRAIGHT, null, "Keep walking", "Confirming the turn…", null, dest, toDest,
                )
                else -> trackingGuidance(route, i, seg, remaining, dest, toDest, arrivalToleranceM)
            }
        }
    }

    private fun trackingGuidance(
        route: Route, i: Int, seg: Segment, remaining: Double, dest: String, toDest: Double, tol: Double,
    ): Guidance {
        val next = route.segments.getOrNull(i + 1)
        return when (seg.endAction) {
            EndAction.TURN_LEFT, EndAction.TURN_RIGHT -> {
                val dir = seg.expectedEndTurn!!
                Guidance(turnManeuver(dir), remaining, "Turn ${turnWord(dir)}", next?.to ?: seg.to,
                    next?.let { endManeuver(it) }, dest, toDest)
            }
            EndAction.ARRIVE -> {
                val side = seg.arrivalSide
                if (remaining <= tol && side != null) {
                    Guidance(if (side == TurnDir.LEFT) Maneuver.FACE_LEFT else Maneuver.FACE_RIGHT, null,
                        "Face the door on your ${turnWord(side)}", seg.to, null, dest, toDest)
                } else {
                    Guidance(Maneuver.ARRIVE, remaining, seg.to,
                        side?.let { "on your ${turnWord(it)}" }, null, dest, toDest)
                }
            }
            EndAction.CONTINUE -> Guidance(Maneuver.STRAIGHT, remaining, "Continue straight", seg.to,
                next?.let { endManeuver(it) }, dest, toDest)
        }
    }

    /** First ARRIVE waypoint at or after segment [from], and the walking distance to it. */
    fun nextDestination(route: Route, from: Int, remainingInCurrent: Double): Pair<String, Double> {
        var dist = remainingInCurrent
        for (k in from until route.segments.size) {
            val s = route.segments[k]
            if (k > from) dist += s.lengthM
            if (s.endAction == EndAction.ARRIVE || k == route.segments.lastIndex) return s.to to dist
        }
        return route.segments.last().to to dist
    }

    private fun turnManeuver(d: TurnDir) = when (d) {
        TurnDir.LEFT -> Maneuver.TURN_LEFT
        TurnDir.RIGHT -> Maneuver.TURN_RIGHT
        TurnDir.AROUND -> Maneuver.TURN_AROUND
    }

    private fun startManeuver(s: Segment) = if (s.startTurn == TurnDir.AROUND) Maneuver.TURN_AROUND else Maneuver.STRAIGHT

    private fun endManeuver(s: Segment) = when (s.endAction) {
        EndAction.TURN_LEFT -> Maneuver.TURN_LEFT
        EndAction.TURN_RIGHT -> Maneuver.TURN_RIGHT
        EndAction.ARRIVE -> Maneuver.ARRIVE
        EndAction.CONTINUE -> Maneuver.STRAIGHT
    }
}

/** Flat 2-D layout of the route for drawing a map. Metres; x = east, y = north; heading 0 = north, clockwise. */
class RouteGeometry(val route: Route) {
    data class Seg(val x0: Double, val y0: Double, val x1: Double, val y1: Double, val headingDeg: Double)
    data class Pt(val x: Double, val y: Double)

    val segments: List<Seg>

    init {
        var x = 0.0
        var y = 0.0
        var h = 0.0
        segments = route.segments.map { s ->
            // Only a turn-around changes the walking line at a segment start. LEFT/RIGHT start turns
            // just undo "face the door" at a waypoint, so the corridor direction is unchanged.
            if (s.startTurn == TurnDir.AROUND) h += 180.0
            val r = Math.toRadians(h)
            val x1 = x + s.lengthM * sin(r)
            val y1 = y + s.lengthM * cos(r)
            val seg = Seg(x, y, x1, y1, norm(h))
            x = x1; y = y1
            when (s.endAction) {
                EndAction.TURN_LEFT -> h -= 90.0
                EndAction.TURN_RIGHT -> h += 90.0
                else -> Unit
            }
            seg
        }
    }

    fun pointAt(segIndex: Int, s: Double): Pt {
        val g = segments[segIndex.coerceIn(0, segments.lastIndex)]
        val len = route.segments[segIndex].lengthM
        val f = (s / len).coerceIn(0.0, 1.05)
        return Pt(g.x0 + (g.x1 - g.x0) * f, g.y0 + (g.y1 - g.y0) * f)
    }

    fun headingAt(segIndex: Int): Double = segments[segIndex.coerceIn(0, segments.lastIndex)].headingDeg

    private fun norm(a: Double): Double = ((a % 360.0) + 360.0) % 360.0
}
