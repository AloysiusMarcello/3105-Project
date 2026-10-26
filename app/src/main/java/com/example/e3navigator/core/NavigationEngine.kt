package com.example.e3navigator.core

import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sqrt

enum class NavState { IDLE, TRACKING, AWAITING_CONTINUE, LOST, FINISHED }

/**
 * How much the engine may claim about position (report §7, safe localisation failure).
 *  HIGH   σ ≤ preciseCueMaxSigmaM: exact distances ("In about 2 metres, turn left", "Stop. Turn left now.")
 *  MEDIUM above that: approximate cues only ("coming up soon", "turn when your cane finds the opening")
 *  LOW    σ above the segment limit (state LOST): no directions, ask the user to stop until a sign is read
 */
enum class Confidence { HIGH, MEDIUM, LOW }

enum class HapticKind { TURN_SOON, TURN_NOW, CONFIRM, WARNING, ARRIVED }

/** Everything the engine wants the app to do. The engine itself never touches Android APIs. */
sealed interface NavOutput {
    data class Speak(val text: String, val urgent: Boolean = false) : NavOutput
    data class Haptic(val kind: HapticKind) : NavOutput
    data class Log(val event: String, val detail: String = "") : NavOutput
}

data class NavSnapshot(
    val state: NavState,
    val segmentIndex: Int,
    val segmentId: String,
    val segmentFrom: String,
    val segmentTo: String,
    val positionM: Double,
    val segmentLengthM: Double,
    val sigmaM: Double,
    val totalSteps: Int,
    val netTurnDeg: Double,
    val turnPending: Boolean,
    val offCourse: Boolean,
    val awaitingStartTurn: Boolean,
    val lastLandmark: String?,
    val confidence: Confidence = Confidence.HIGH,
)

/**
 * Hybrid visual-inertial route tracker (report Concept C, functions F3–F9).
 *
 * Position is one-dimensional: the current route segment plus the distance walked along it.
 *  - Steps move the estimate forward and grow its uncertainty (dead reckoning, F3).
 *  - Confirmed landmarks correct the estimate with a 1-D Kalman update (F4).
 *  - A turn is accepted only near the expected junction, in the expected direction, and
 *    after further steps confirm it (route-constrained turn detection).
 *  - When uncertainty exceeds the limit, directions stop until a landmark is seen again (F9).
 *
 * All calls must come from a single thread. Time is passed in explicitly so the engine can
 * be tested with simulated walks.
 */
class NavigationEngine(
    val route: Route,
    var config: NavConfig,
    private val out: (NavOutput) -> Unit,
) {
    private class PendingTurn(val sigmaAtTurn: Double) {
        var steps = 0
        var distM = 0.0
    }

    var state = NavState.IDLE
        private set

    private var segIndex = 0
    private var s = 0.0
    private var sigmaFix = 0.0
    private var distSinceFix = 0.0
    private var totalSteps = 0
    private var netTurn = 0.0
    private var pending: PendingTurn? = null
    private var offCourse = false
    private var offCourseSteps = 0
    private var awaitingStartTurn = false
    private var startTurnSteps = 0
    private var startTurnDist = 0.0
    private var lastProgressS = 0.0
    private var lostSteps = 0
    private var carrySigma = 0.0

    // Per-segment announcement flags
    private var announcedSoon = false
    private var announcedNow = false
    private var announcedNear = false
    /** The "coming up" cue was given vaguely; a later sign fix may upgrade it to an exact distance. */
    private var approachCueWasVague = false
    private var arrivalLandmarkSeen = false

    private val announcedLandmarks = HashSet<String>()
    private val lastFixAt = HashMap<String, Long>()
    private var confirmer = LandmarkConfirmer(config.landmarkMinHits, config.landmarkWindowMs)
    private var lastLandmark: String? = null

    val segment: Segment get() = route.segments[segIndex]

    /** Current 1-sigma position uncertainty in metres. */
    val sigma: Double get() = sigmaFix + config.driftFraction * distSinceFix

    val confidence: Confidence
        get() = when {
            state == NavState.LOST -> Confidence.LOW
            sigma <= config.preciseCueMaxSigmaM -> Confidence.HIGH
            else -> Confidence.MEDIUM
        }
    private var loggedConfidence = Confidence.HIGH

    /** Logs every change of confidence level, so the CSV shows where on the route each level applied. */
    private fun noteConfidence() {
        val c = confidence
        if (c == loggedConfidence) return
        log("confidence", "${loggedConfidence}->$c sigma=${fmt(sigma)} s=${fmt(s)}")
        loggedConfidence = c
    }

    // ------------------------------------------------------------------ control

    fun start(nowMs: Long) {
        confirmer = LandmarkConfirmer(config.landmarkMinHits, config.landmarkWindowMs)
        confirmer.clear()
        announcedLandmarks.clear()
        lastFixAt.clear()
        lastLandmark = null
        totalSteps = 0
        state = NavState.TRACKING
        log("nav_start", "route=${route.id} t=$nowMs stepLength=${config.stepLengthM}")
        speak("Navigation started.")
        beginSegment(0, 0.0, config.startSigmaM, 0.0, speakInstruction = true)
        loggedConfidence = confidence
    }

    fun stop() {
        state = NavState.IDLE
        pending = null
        log("nav_stop")
    }

    /** User confirms they are ready to continue after arriving at a waypoint. */
    fun continueAfterArrival() {
        if (state != NavState.AWAITING_CONTINUE) return
        state = NavState.TRACKING
        beginSegment(segIndex + 1, 0.0, carrySigma, 0.0, speakInstruction = true)
    }

    /** Spoken status on demand (e.g. a "repeat" button). */
    fun repeatInstruction() {
        when (state) {
            NavState.IDLE -> speak("Navigation is not running.")
            NavState.TRACKING -> speak(guidanceSummary())
            NavState.AWAITING_CONTINUE -> speak("You are at ${segment.to}. $CONTINUE_PROMPT")
            NavState.LOST -> speak(LOST_MESSAGE)
            NavState.FINISHED -> speak("Navigation complete. You are at ${segment.to}.")
        }
    }

    // ------------------------------------------------------------------ inputs

    /**
     * One detected step. [stepLengthM] is the per-step length from the adaptive step model;
     * null = use the calibrated average.
     */
    fun onStep(nowMs: Long, stepLengthM: Double? = null) {
        step(stepLengthM)
        noteConfidence()
    }

    private fun step(stepLengthM: Double?) {
        totalSteps++
        when (state) {
            NavState.LOST -> {
                lostSteps++
                if (config.lostReminderSteps > 0 && lostSteps % config.lostReminderSteps == 0) {
                    speak(LOST_MESSAGE, urgent = true)
                }
                return
            }
            NavState.TRACKING -> Unit
            else -> return
        }
        val stepLen = stepLengthM ?: config.stepLengthM

        if (awaitingStartTurn) {
            startTurnSteps++
            startTurnDist += stepLen
            if (startTurnSteps < config.startTurnGraceSteps) return
            // User walked off without a detected start turn: assume it was made before "continue".
            awaitingStartTurn = false
            log("start_turn_assumed", "steps=$startTurnSteps")
            s += startTurnDist
            distSinceFix += startTurnDist
            checkProgress()
            return
        }

        pending?.let { p ->
            p.steps++
            p.distM += stepLen
            distSinceFix += stepLen
            if (p.steps >= config.turnConfirmSteps) commitTurn(p)
            return
        }

        distSinceFix += stepLen
        // Always count the distance. A rotation away from the corridor is usually the phone twisting
        // on its mount or a dodge; if he really left the corridor, the uncertainty and overshoot checks catch it.
        s += stepLen
        if (offCourse && ++offCourseSteps >= config.offCourseTimeoutSteps) {
            offCourse = false
            netTurn = 0.0
            log("off_course_timeout", "steps=$offCourseSteps (assuming the phone twisted, not the user)")
        }

        // Route-specific checks first, so "you passed the turn" wins over the generic message.
        if (!offCourse) checkProgress()
        if (state == NavState.TRACKING && sigma > (segment.maxSigmaM ?: config.maxSigmaM)) {
            goLost("uncertainty", LOST_MESSAGE)
        }
    }

    fun onTurn(ev: TurnEvent) {
        log("turn_event", "dir=${ev.direction} angle=${fmt(ev.angleDeg)} s=${fmt(s)} sigma=${fmt(sigma)} state=$state")
        if (state != NavState.TRACKING) return
        netTurn += ev.angleDeg
        val seg = segment

        if (awaitingStartTurn) {
            if (seg.startTurn != null && matchesTurn(netTurn, seg.startTurn)) {
                awaitingStartTurn = false
                netTurn = 0.0
                log("start_turn_done", "dir=${seg.startTurn}")
                haptic(HapticKind.CONFIRM)
                speak("Good. Walk straight ahead.")
            }
            return
        }

        val expected = seg.expectedEndTurn
        if (expected != null && abs(seg.lengthM - s) <= config.turnWindowM + sigma) {
            if (matchesTurn(netTurn, expected)) {
                if (pending == null) {
                    pending = PendingTurn(sigma)
                    offCourse = false
                    log("turn_accepted", "net=${fmt(netTurn)} s=${fmt(s)}")
                    haptic(HapticKind.CONFIRM)
                    speak("Good. Now walk straight ahead.")
                }
            } else {
                if (pending != null) {
                    pending = null
                    log("turn_cancelled", "net=${fmt(netTurn)}")
                }
                if (abs(netTurn) >= config.offCourseDeg) {
                    log("wrong_turn", "net=${fmt(netTurn)} expected=$expected")
                    haptic(HapticKind.WARNING)
                    speak("Wrong way. Turn back, then turn ${turnWord(expected)}.", urgent = true)
                }
            }
            return
        }

        // Turning to face the destination door (plates sit on doors in side recesses) is expected.
        if (seg.endAction == EndAction.ARRIVE && abs(seg.lengthM - s) <= config.turnWindowM + sigma) {
            log("turn_at_waypoint", "net=${fmt(netTurn)} s=${fmt(s)}")
            return
        }

        // Not at a junction where a turn is expected.
        if (abs(netTurn) >= config.offCourseDeg) {
            if (!offCourse) {
                offCourse = true
                offCourseSteps = 0
                log("off_course", "net=${fmt(netTurn)} s=${fmt(s)} (rotation away from junction)")
                haptic(HapticKind.WARNING)
                speak("You may have turned off the corridor. Turn back to continue.", urgent = true)
            }
        } else if (offCourse) {
            offCourse = false
            log("back_on_route", "net=${fmt(netTurn)}")
            haptic(HapticKind.CONFIRM)
            speak("Back on route.")
        } else {
            log("turn_ignored", "net=${fmt(netTurn)} s=${fmt(s)}")
        }
    }

    /** OCR results from one camera frame. */
    fun onText(observations: List<TextObservation>, nowMs: Long) {
        if (state != NavState.TRACKING && state != NavState.LOST) return
        val countedThisFrame = HashSet<String>() // one hit per landmark per frame, however many text boxes match
        for (obs in observations) {
            val candidates = ArrayList<Pair<Int, Landmark>>()
            route.segments.forEachIndexed { i, seg ->
                seg.landmarks.forEach { lm -> if (LandmarkMatcher.matches(obs.text, lm)) candidates += i to lm }
            }
            if (candidates.isEmpty()) continue
            val chosen = chooseCandidate(candidates)
            if (chosen == null) {
                log("landmark_out_of_sequence", "text=${obs.text}")
                continue
            }
            if (!countedThisFrame.add(chosen.second.id)) continue
            if (confirmer.hit(chosen.second.id, nowMs)) {
                handleLandmark(chosen.first, chosen.second, obs.heightFraction, nowMs)
            }
        }
        noteConfidence()
    }

    // ------------------------------------------------------------------ internals

    private fun chooseCandidate(cands: List<Pair<Int, Landmark>>): Pair<Int, Landmark>? {
        if (cands.isEmpty()) return null
        fun priority(segI: Int): Int? = when {
            segI == segIndex -> 0
            segI == segIndex + 1 -> 1
            state == NavState.LOST -> 2 + abs(segI - segIndex) + (if (segI < segIndex) 1 else 0)
            else -> null
        }
        // Same priority (e.g. two EXIT signs on one segment): take the one nearest the current estimate.
        fun gap(c: Pair<Int, Landmark>): Double =
            if (c.first == segIndex) abs(c.second.positionM - (c.second.sightingDistanceM ?: config.sightingDistanceM) - s) else c.second.positionM
        return cands.mapNotNull { c -> priority(c.first)?.let { it to c } }
            .minWithOrNull(compareBy<Pair<Int, Pair<Int, Landmark>>> { it.first }.thenBy { gap(it.second) })?.second
    }

    private fun handleLandmark(segI: Int, lm: Landmark, heightFraction: Double, nowMs: Long) {
        val last = lastFixAt[lm.id]
        if (last != null && nowMs - last < config.landmarkCooldownMs) return
        lastFixAt[lm.id] = nowMs

        val d = sightingDistance(lm, heightFraction)
        val sObs = (lm.positionM - d).coerceAtLeast(0.0)
        lastLandmark = lm.text
        log("landmark_confirmed", "id=${lm.id} text=${lm.text} seg=${route.segments[segI].id} sObs=${fmt(sObs)} s=${fmt(s)} sigma=${fmt(sigma)} range=${fmt(d)} state=$state")

        if (state == NavState.LOST) {
            if (segI != segIndex) {
                beginSegment(segI, sObs, config.landmarkSigmaM, 0.0, speakInstruction = false)
            } else {
                s = sObs
                sigmaFix = config.landmarkSigmaM
                distSinceFix = 0.0
                netTurn = 0.0
                pending = null
                offCourse = false
                awaitingStartTurn = false
            }
            state = NavState.TRACKING
            lostSteps = 0
            if (lm.confirmsArrival) arrivalLandmarkSeen = true
            announcedLandmarks += lm.id
            log("relocalised", "seg=${segment.id} s=${fmt(s)}")
            haptic(HapticKind.CONFIRM)
            speak("Location confirmed, ${lm.announce ?: lm.text}. ${guidanceSummary()}")
            checkProgress()
            return
        }

        // TRACKING
        if (segI == segIndex) {
            if (pending != null) {
                log("landmark_ignored", "turn pending")
                return
            }
            fuse(sObs)
        } else if (segI == segIndex + 1) {
            val seg = segment
            val nearEnd = s >= seg.lengthM - config.turnWindowM - sigma
            val canAdvance = pending != null ||
                seg.endAction == EndAction.CONTINUE ||
                (seg.expectedEndTurn != null && nearEnd)
            if (!canAdvance) {
                log("landmark_out_of_sequence", "id=${lm.id}")
                return
            }
            if (pending == null && seg.expectedEndTurn != null) log("turn_inferred_from_landmark", "id=${lm.id}")
            val hadTurn = pending != null || seg.expectedEndTurn != null
            beginSegment(segI, sObs, config.landmarkSigmaM, 0.0, speakInstruction = false)
            if (hadTurn) speak("You have turned.")
            route.segments[segI].startInstruction?.let { speak(it) }
        } else {
            log("landmark_out_of_sequence", "id=${lm.id}")
            return
        }

        if (lm.confirmsArrival) arrivalLandmarkSeen = true
        if (lm.announce != null && announcedLandmarks.add(lm.id)) speak(lm.announce)
        checkProgress()
    }

    /** 1-D Kalman update of the along-segment position with a landmark observation. */
    private fun fuse(sObs: Double) {
        val priorVar = sigma * sigma
        val obsVar = config.landmarkSigmaM * config.landmarkSigmaM
        val innovation = sObs - s
        if (abs(innovation) > 3.0 * sqrt(priorVar + obsVar)) {
            // The camera reading is far more trustworthy than a badly drifted step count.
            log("large_correction", "from=${fmt(s)} to=${fmt(sObs)}")
            s = sObs
            sigmaFix = config.landmarkSigmaM
        } else {
            val k = priorVar / (priorVar + obsVar)
            s += k * innovation
            sigmaFix = sqrt((1 - k) * priorVar)
        }
        distSinceFix = 0.0
        log("position_fix", "s=${fmt(s)} sigma=${fmt(sigma)}")
        if (approachCueWasVague && sigma <= config.preciseCueMaxSigmaM) {
            // Now we know better: allow the exact "in about N metres" cue.
            approachCueWasVague = false
            announcedSoon = false
            announcedNear = false
        }
    }

    private fun checkProgress() {
        if (state != NavState.TRACKING || pending != null || awaitingStartTurn || offCourse) return
        val seg = segment
        val remaining = seg.lengthM - s
        // Exact distances only when the estimate is good; otherwise vaguer wording, given earlier.
        val precise = sigma <= config.preciseCueMaxSigmaM
        val announceAt = config.turnAnnounceM + if (precise) 0.0 else sigma
        progressCue(seg, remaining, precise)

        when (seg.endAction) {
            EndAction.TURN_LEFT, EndAction.TURN_RIGHT -> {
                val w = turnWord(seg.expectedEndTurn!!)
                if (!announcedSoon && remaining <= announceAt && remaining > config.turnNowM) {
                    announcedSoon = true
                    haptic(HapticKind.TURN_SOON)
                    approachCueWasVague = !precise
                    speak(if (precise) "In about ${metres(remaining)}, turn $w." else "The $w turn is coming up soon. Slow down.")
                    log("cue_turn_soon", "remaining=${fmt(remaining)}")
                }
                if (!announcedNow && remaining <= config.turnNowM) {
                    announcedNow = true
                    announcedSoon = true
                    haptic(HapticKind.TURN_NOW)
                    speak(
                        if (precise) "Stop. Turn $w now."
                        else "You should be at the $w turn. Stop, and turn $w when your cane finds the opening.",
                        urgent = true,
                    )
                    log("cue_turn_now", "remaining=${fmt(remaining)}")
                }
                if (-remaining > config.overshootM + sigma) {
                    goLost("overshoot_turn", "You may have passed the $w turn. Please stop.")
                }
            }
            EndAction.CONTINUE -> {
                if (remaining <= 0) {
                    if (segIndex == route.segments.lastIndex) finish()
                    else beginSegment(segIndex + 1, -remaining, sigmaFix, distSinceFix, speakInstruction = true)
                }
            }
            EndAction.ARRIVE -> {
                val side = seg.arrivalSide?.let { " on your ${turnWord(it)}" } ?: ""
                if (!announcedNear && remaining <= announceAt && remaining > config.arrivalToleranceM) {
                    announcedNear = true
                    approachCueWasVague = !precise
                    speak(cap(if (precise) "${seg.to} is about ${metres(remaining)} ahead$side."
                        else "${seg.to} is coming up soon$side. Slow down."))
                    log("cue_approaching", "remaining=${fmt(remaining)}")
                }
                // Destinations with no readable sign (e.g. a pictogram-only toilet door) arrive by steps alone.
                if (remaining <= config.arrivalToleranceM &&
                    (sigma <= config.arrivalMaxSigmaM || arrivalLandmarkSeen || !seg.hasArrivalLandmark)
                ) {
                    arrive()
                    return
                }
                if (!announcedNow && remaining <= config.arrivalToleranceM) {
                    announcedNow = true
                    val prompt = seg.arrivalSide?.let {
                        "${seg.to} should be here$side. Stop and turn ${turnWord(it)} to face the door so I can read the sign."
                    } ?: "${seg.to} should be just ahead. Slow down while I look for the sign."
                    speak(cap(prompt))
                    log("cue_looking_for_waypoint", "sigma=${fmt(sigma)}")
                }
                if (-remaining > config.overshootM + sigma) {
                    goLost("overshoot_waypoint", "You may have walked past ${seg.to}. Please stop.")
                }
            }
        }
    }

    /** "Still on track" update every [NavConfig.progressIntervalM] on long stretches. */
    private fun progressCue(seg: Segment, remaining: Double, precise: Boolean) {
        if (s - lastProgressS < config.progressIntervalM) return
        lastProgressS = s
        if (remaining <= config.turnAnnounceM + 5.0 + (if (precise) 0.0 else sigma)) return
        val target = when (seg.endAction) {
            EndAction.TURN_LEFT, EndAction.TURN_RIGHT -> "the ${turnWord(seg.expectedEndTurn!!)} turn"
            EndAction.ARRIVE -> seg.to
            EndAction.CONTINUE -> "the end of this section"
        }
        val dist = if (precise) metres(remaining) else "${((remaining / 5.0).roundToInt() * 5).coerceAtLeast(5)} metres"
        speak("Keep going straight. About $dist to $target.")
        log("cue_progress", "remaining=${fmt(remaining)} sigma=${fmt(sigma)}")
    }

    private fun commitTurn(p: PendingTurn) {
        val next = segIndex + 1
        val sStart = p.distM
        log("turn_committed", "steps_after=${p.steps}")
        haptic(HapticKind.CONFIRM)
        beginSegment(next, sStart, minOf(p.sigmaAtTurn, config.turnFixSigmaM), sStart, speakInstruction = true)
    }

    private fun arrive() {
        val seg = segment
        carrySigma = minOf(sigma, config.landmarkSigmaM)
        haptic(HapticKind.ARRIVED)
        log("arrived", "waypoint=${seg.to} s=${fmt(s)} sigma=${fmt(sigma)} landmark=$arrivalLandmarkSeen")
        if (segIndex == route.segments.lastIndex) {
            finish(seg.arrivalMessage ?: "You have arrived at ${seg.to}.")
        } else {
            state = NavState.AWAITING_CONTINUE
            speak((seg.arrivalMessage ?: "You have arrived at ${seg.to}.") + " " + CONTINUE_PROMPT)
        }
    }

    private fun finish(message: String? = null) {
        state = NavState.FINISHED
        log("finished")
        speak(listOfNotNull(message, "Navigation complete.").joinToString(" "))
    }

    private fun goLost(reason: String, message: String) {
        state = NavState.LOST
        pending = null
        lostSteps = 0
        log("lost", "reason=$reason s=${fmt(s)} sigma=${fmt(sigma)}")
        haptic(HapticKind.WARNING)
        speak(message, urgent = true)
    }

    private fun beginSegment(i: Int, sStart: Double, sigmaFixNew: Double, distSince: Double, speakInstruction: Boolean) {
        segIndex = i
        s = sStart
        sigmaFix = sigmaFixNew
        distSinceFix = distSince
        netTurn = 0.0
        pending = null
        offCourse = false
        announcedSoon = false
        announcedNow = false
        announcedNear = false
        approachCueWasVague = false
        arrivalLandmarkSeen = false
        val seg = segment
        awaitingStartTurn = seg.startTurn != null
        startTurnSteps = 0
        startTurnDist = 0.0
        lastProgressS = sStart
        log("segment_start", "seg=${seg.id} ${seg.from}->${seg.to} s=${fmt(s)} sigma=${fmt(sigma)}")
        if (speakInstruction) seg.startInstruction?.let { speak(it) }
    }

    private fun guidanceSummary(): String {
        val seg = segment
        val remaining = seg.lengthM - s
        return when {
            awaitingStartTurn && seg.startTurn != null -> "Turn ${turnWord(seg.startTurn)}, then walk straight."
            seg.expectedEndTurn != null && remaining > 0.5 ->
                "Walk straight. Turn ${turnWord(seg.expectedEndTurn!!)} in about ${metres(remaining)}."
            seg.expectedEndTurn != null -> "Turn ${turnWord(seg.expectedEndTurn!!)} now."
            seg.endAction == EndAction.ARRIVE && remaining > 0.5 ->
                "Walk straight. ${seg.to} in about ${metres(remaining)}."
            seg.endAction == EndAction.ARRIVE -> "${seg.to} should be just ahead."
            else -> "Walk straight."
        }
    }

    private fun matchesTurn(net: Double, dir: TurnDir): Boolean {
        val tol = config.turnMatchToleranceDeg
        return when (dir) {
            TurnDir.LEFT -> abs(net + 90.0) <= tol
            TurnDir.RIGHT -> abs(net - 90.0) <= tol
            TurnDir.AROUND -> abs(abs(net) - 180.0) <= tol
        }
    }

    private fun sightingDistance(lm: Landmark, heightFraction: Double): Double = when {
        lm.sightingDistanceM != null -> lm.sightingDistanceM
        config.plateSizeCalib > 0 && heightFraction > 0 ->
            (config.plateSizeCalib / heightFraction).coerceIn(config.minSightingDistanceM, config.maxSightingDistanceM)
        else -> config.sightingDistanceM
    }

    fun snapshot() = NavSnapshot(
        state = state,
        segmentIndex = segIndex,
        segmentId = segment.id,
        segmentFrom = segment.from,
        segmentTo = segment.to,
        positionM = s,
        segmentLengthM = segment.lengthM,
        sigmaM = sigma,
        totalSteps = totalSteps,
        netTurnDeg = netTurn,
        turnPending = pending != null,
        offCourse = offCourse,
        awaitingStartTurn = awaitingStartTurn,
        lastLandmark = lastLandmark,
        confidence = confidence,
    )

    private fun speak(text: String, urgent: Boolean = false) = out(NavOutput.Speak(text, urgent))
    private fun haptic(kind: HapticKind) = out(NavOutput.Haptic(kind))
    private fun log(event: String, detail: String = "") = out(NavOutput.Log(event, detail))

    companion object {
        const val CONTINUE_PROMPT = "Press volume up when you are ready to continue."
        const val LOST_MESSAGE = "Location uncertain. Please stop and face along the corridor so I can find a room sign."

        private fun fmt(x: Double) = String.format(java.util.Locale.US, "%.2f", x)

        private fun cap(t: String) = t.replaceFirstChar { it.uppercaseChar() }

        private fun metres(x: Double): String {
            val m = x.roundToInt().coerceAtLeast(1)
            return if (m == 1) "1 metre" else "$m metres"
        }
    }
}
