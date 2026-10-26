package com.example.e3navigator.core

/**
 * Route model for a predefined indoor route.
 *
 * A route is a sequence of straight corridor segments. Each segment ends with an action
 * (turn, continue, or arrive at a waypoint) and may contain visual landmarks (room plates,
 * signs) at known distances from the segment start.
 *
 * All distances are in metres, measured along the walking line.
 */

enum class EndAction { TURN_LEFT, TURN_RIGHT, CONTINUE, ARRIVE }

enum class TurnDir { LEFT, RIGHT, AROUND }

data class Landmark(
    /** Unique id within the route, e.g. "L2". */
    val id: String,
    /** Text printed on the plate/sign, e.g. "E3-06-02". */
    val text: String,
    /** Distance from the start of the segment to the point beside the plate. */
    val positionM: Double,
    /** Spoken when the landmark is first confirmed on this pass; null = silent position correction. */
    val announce: String? = null,
    /** True if reading this plate confirms arrival at the segment's end waypoint. */
    val confirmsArrival: Boolean = false,
    /** Other spellings that should also match (e.g. "E3 06 02", "06-02"). */
    val aliases: List<String> = emptyList(),
    /**
     * How far BEFORE the sign (measured along the route) the user typically is when it is read,
     * overriding the global setting. A ceiling EXIT sign facing down the corridor is read from
     * several metres before it; a door plate in a side recess, read by turning to face the door,
     * is read while standing beside it, so 0.
     */
    val sightingDistanceM: Double? = null,
)

data class Segment(
    val id: String,
    val from: String,
    val to: String,
    val lengthM: Double,
    val endAction: EndAction,
    /** Spoken when this segment begins. Null = nothing spoken (e.g. a plain corridor continuation). */
    val startInstruction: String? = null,
    /** A turn the user must make before walking this segment (e.g. AROUND for the return leg). */
    val startTurn: TurnDir? = null,
    /** Spoken on arrival when endAction == ARRIVE. */
    val arrivalMessage: String? = null,
    /** Which side the destination door is on (LEFT/RIGHT), for "on your left" cues and "turn to face the door". */
    val arrivalSide: TurnDir? = null,
    /**
     * Uncertainty allowed on this segment before guidance stops, overriding the global setting.
     * Use for long straight corridors with no decision points and no readable signs.
     */
    val maxSigmaM: Double? = null,
    val landmarks: List<Landmark> = emptyList(),
) {
    val hasArrivalLandmark: Boolean get() = landmarks.any { it.confirmsArrival }

    val expectedEndTurn: TurnDir?
        get() = when (endAction) {
            EndAction.TURN_LEFT -> TurnDir.LEFT
            EndAction.TURN_RIGHT -> TurnDir.RIGHT
            else -> null
        }
}

data class Route(
    val id: String,
    val name: String,
    val segments: List<Segment>,
) {
    init {
        require(segments.isNotEmpty()) { "Route must have at least one segment" }
        val ids = segments.flatMap { s -> s.landmarks.map { it.id } }
        require(ids.size == ids.toSet().size) { "Landmark ids must be unique across the route" }
        segments.forEach { seg ->
            require(seg.lengthM > 0) { "Segment ${seg.id} must have positive length" }
            seg.landmarks.forEach { lm ->
                require(lm.positionM >= 0 && lm.positionM <= seg.lengthM + 1.0) {
                    "Landmark ${lm.id} position ${lm.positionM} is outside segment ${seg.id} (0..${seg.lengthM})"
                }
            }
        }
    }

    val totalLengthM: Double get() = segments.sumOf { it.lengthM }
}

fun turnWord(dir: TurnDir): String = when (dir) {
    TurnDir.LEFT -> "left"
    TurnDir.RIGHT -> "right"
    TurnDir.AROUND -> "around"
}
