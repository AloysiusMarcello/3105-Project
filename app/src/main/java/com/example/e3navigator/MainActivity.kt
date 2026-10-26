package com.example.e3navigator

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.example.e3navigator.core.GuidanceBuilder
import com.example.e3navigator.core.LandmarkMatcher
import com.example.e3navigator.core.NavOutput
import com.example.e3navigator.core.NavState
import com.example.e3navigator.core.NavigationEngine
import com.example.e3navigator.core.Route
import com.example.e3navigator.core.StepFusion
import com.example.e3navigator.core.StepLengthModel
import com.example.e3navigator.core.TextObservation
import com.example.e3navigator.core.TurnDetector
import com.example.e3navigator.data.AppSettings
import com.example.e3navigator.data.NavLogger
import com.example.e3navigator.data.RouteLoader
import com.example.e3navigator.data.SensorDiagnosticLogger
import java.io.File
import com.example.e3navigator.feedback.Haptics
import com.example.e3navigator.feedback.Speaker
import com.example.e3navigator.sensing.MotionSensors
import com.example.e3navigator.sensing.StepSource
import com.example.e3navigator.sensing.TextScanner
import com.example.e3navigator.ui.ManeuverView
import com.example.e3navigator.ui.RouteMapView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.ceil

/**
 * Wires the Android sensors, camera, speech and logging to the pure-Kotlin NavigationEngine.
 * All engine calls happen on the main thread.
 */
class MainActivity : AppCompatActivity(), MotionSensors.Listener {

    private lateinit var settings: AppSettings
    private lateinit var logger: NavLogger
    private lateinit var speaker: Speaker
    private lateinit var haptics: Haptics
    private lateinit var sensors: MotionSensors
    private lateinit var diagnostics: SensorDiagnosticLogger
    private lateinit var diagButton: Button
    private var diagReport = ""
    private var scanner: TextScanner? = null
    private var engine: NavigationEngine? = null
    private var route: Route? = null
    private val turnDetector = TurnDetector()

    // Views
    private lateinit var statusText: TextView
    private lateinit var startOverlay: View
    private lateinit var touchShield: View
    private var mediaSession: MediaSession? = null
    private val handler = Handler(Looper.getMainLooper())
    private var shieldUnlocked = false
    private var volDownStopFired = false
    private lateinit var continueButton: Button
    private lateinit var debugText: TextView
    private lateinit var routeText: TextView
    private lateinit var calibButton: Button
    private lateinit var calibDistance: EditText
    private lateinit var plateDistance: EditText
    private lateinit var stepLengthEdit: EditText
    private lateinit var sightingEdit: EditText
    private lateinit var plateCalibEdit: EditText
    private lateinit var maxSigmaEdit: EditText
    private lateinit var driftEdit: EditText
    private lateinit var hardwareStepCheck: CheckBox
    private lateinit var adaptiveStepCheck: CheckBox
    private lateinit var dimCheck: CheckBox
    private lateinit var stepModel: StepLengthModel
    private var counterDistanceM = 0.0
    private var lastStepLengthM = 0.0
    private val calibAmplitudes = ArrayList<Double?>()
    private lateinit var guidanceVolumeEdit: EditText

    // Maps-style navigation screen
    private lateinit var mapView: RouteMapView
    private lateinit var banner: LinearLayout
    private lateinit var maneuverIcon: ManeuverView
    private lateinit var distanceText: TextView
    private lateinit var titleText: TextView
    private lateinit var subtitleText: TextView
    private lateinit var thenChip: LinearLayout
    private lateinit var thenIcon: ManeuverView
    private lateinit var stopButton: ImageButton
    private lateinit var etaText: TextView
    private lateinit var etaDetail: TextView
    private lateinit var toolsPanel: View

    // Live readings for the debug panel / tools
    private var heading: Double? = null
    private var counterSteps = 0
    private var hardwareStepsSeen = 0
    private var accelStepsSeen = 0
    private var calibrating = false
    private var calibSteps = 0
    private var lastOcrText = ""
    private var lastOcrMs = 0L
    private var lastLoggedOcr = ""
    private var lastMatchText = ""
    private var lastMatchHeight = 0.0
    private var lastUiUpdate = 0L

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { onPermissionsResult() }

    // ------------------------------------------------------------------ lifecycle

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        // Hardware volume keys adjust the media stream (which the speech uses), not the ringer.
        volumeControlStream = AudioManager.STREAM_MUSIC
        bindViews()

        settings = AppSettings(this)
        stepModel = StepLengthModel(settings.stepLengthM, settings.weinbergK, settings.adaptiveSteps)
        logger = NavLogger(this).also { it.startNew("session") }
        speaker = Speaker(this) { text, ms ->
            runOnUiThread { logger.log("tts_latency", engine?.snapshot(), heading, "ms=$ms text=$text") }
        }.also { it.rate = settings.speechRate }
        haptics = Haptics(this)
        sensors = MotionSensors(this, this)
        diagnostics = SensorDiagnosticLogger(this)
        fillSettingsFields()

        try {
            val loaded = RouteLoader.load(this)
            route = loaded.route
            engine = NavigationEngine(loaded.route, settings.toConfig(), ::onNavOutput)
            mapView.setRoute(loaded.route)
            routeText.text = "Route: ${loaded.route.name} (${loaded.route.segments.size} segments, " +
                "${"%.1f".format(Locale.US, loaded.route.totalLengthM)} m)\nSource: ${loaded.source}"
        } catch (e: Exception) {
            routeText.text = "ROUTE FILE ERROR: ${e.message}"
            statusText.text = "Route file error. Open the testing tools for details."
            startOverlay.isEnabled = false
        }

        if (!sensors.hasHeading) {
            Toast.makeText(this, "This phone has no rotation sensor: turn detection unavailable", Toast.LENGTH_LONG).show()
        }

        askPermissions()
        setupMediaSession()
        speaker.speak(WELCOME)
        updateUi(force = true)
    }

    override fun onResume() {
        super.onResume()
        if (hasPermission(Manifest.permission.CAMERA)) sensors.start()
    }

    override fun onPause() {
        super.onPause()
        sensors.stop()
        if (diagnostics.running) {
            diagnostics.stop()
            diagButton.text = "Sensor diagnostic"
        }
        logger.log("app_paused", engine?.snapshot(), heading)
        logger.flush()
    }

    override fun onDestroy() {
        super.onDestroy()
        mediaSession?.release()
        handler.removeCallbacksAndMessages(null)
        scanner?.shutdown()
        speaker.shutdown()
        logger.close()
    }

    // ------------------------------------------------------------------ permissions

    private fun askPermissions() {
        val needed = mutableListOf(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) needed += Manifest.permission.ACTIVITY_RECOGNITION
        val missing = needed.filter { !hasPermission(it) }
        if (missing.isEmpty()) onPermissionsResult() else permissionLauncher.launch(missing.toTypedArray())
    }

    private fun onPermissionsResult() {
        val activityOk = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || hasPermission(Manifest.permission.ACTIVITY_RECOGNITION)
        sensors.hardwareStepsPermitted = activityOk
        stepFusion.reset(preferHardwareSteps)
        if (!activityOk) Toast.makeText(this, "Activity permission refused: using accelerometer step detection", Toast.LENGTH_LONG).show()

        if (hasPermission(Manifest.permission.CAMERA)) {
            if (scanner == null) {
                scanner = TextScanner(this, findViewById<PreviewView>(R.id.previewView), ::onText) { msg ->
                    logger.log("camera_error", engine?.snapshot(), heading, msg)
                    statusText.text = msg
                }.also { it.start() }
            }
            sensors.stop()
            sensors.start()
        } else {
            statusText.text = "Camera permission is required."
            speaker.speak("Camera permission is required.")
        }
        updateUi(force = true)
    }

    private fun hasPermission(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    // ------------------------------------------------------------------ sensor inputs

    private val preferHardwareSteps: Boolean
        get() = settings.useHardwareStepDetector && sensors.hasHardwareStepDetector && sensors.hardwareStepsPermitted

    /** Picks Android's or the app's step detector, switching automatically if the active one goes silent. */
    private val stepFusion = StepFusion(preferHardware = false)
    private var lastStepMs = 0L

    override fun onStep(source: StepSource, timeMs: Long) {
        if (source == StepSource.HARDWARE) hardwareStepsSeen++ else accelStepsSeen++
        val fs = if (source == StepSource.HARDWARE) StepFusion.Source.HARDWARE else StepFusion.Source.ACCEL
        val counts = stepFusion.onStep(fs, timeMs)
        stepFusion.lastSwitch?.let { (from, to) ->
            logger.log("step_source_switch", engine?.snapshot(), heading, "$from -> $to (active detector went silent)")
        }
        if (!counts) {
            logger.log("step_alt", engine?.snapshot(), heading, "source=$source")
            return
        }
        lastStepMs = timeMs
        counterSteps++
        val amp = sensors.amplitude.take()
        val len = stepModel.length(amp)
        lastStepLengthM = len
        counterDistanceM += len
        if (calibrating) { calibSteps++; calibAmplitudes += amp }
        engine?.onStep(timeMs, len)
        logger.log("step", engine?.snapshot(), heading, "source=$source len=${fmt(len, 3)} amp=${amp?.let { fmt(it, 3) } ?: "-"}")
        updateUi()
    }

    override fun onHeading(timeMs: Long, headingDeg: Double) {
        heading = headingDeg
        turnDetector.onHeading(timeMs, headingDeg)?.let { ev ->
            logger.log("turn_detected", engine?.snapshot(), heading, "dir=${ev.direction} angle=${"%.1f".format(Locale.US, ev.angleDeg)}")
            engine?.onTurn(ev)
            updateUi(force = true)
        }
        updateUi()
    }

    private fun onText(observations: List<TextObservation>, raw: String, processingMs: Long) {
        val now = SystemClock.elapsedRealtime()
        val flat = raw.replace('\n', ' ').trim()
        if (flat.isNotEmpty()) {
            lastOcrText = flat
            lastOcrMs = now
        }
        // Remember the size of any route landmark seen (for plate-size calibration)
        route?.let { r ->
            for (o in observations) for (seg in r.segments) for (lm in seg.landmarks) {
                if (LandmarkMatcher.matches(o.text, lm)) {
                    lastMatchText = lm.text
                    lastMatchHeight = o.heightFraction
                }
            }
        }
        if (flat.any { it.isDigit() } && flat != lastLoggedOcr) {
            lastLoggedOcr = flat
            logger.log("ocr", engine?.snapshot(), heading, "ms=$processingMs text=$flat")
        }
        engine?.onText(observations, now)
        updateUi()
    }

    // ------------------------------------------------------------------ engine outputs

    private fun onNavOutput(o: NavOutput) {
        val snap = engine?.snapshot()
        when (o) {
            is NavOutput.Speak -> {
                speaker.speak(o.text, o.urgent)
                statusText.text = o.text
                logger.log("speak", snap, heading, o.text)
            }
            is NavOutput.Haptic -> haptics.play(o.kind)
            is NavOutput.Log -> logger.log(o.event, snap, heading, o.detail)
        }
        updateUi(force = true)
    }

    // ------------------------------------------------------------------ buttons

    private fun bindViews() {
        statusText = findViewById(R.id.statusText)
        startOverlay = findViewById(R.id.startOverlay)
        touchShield = findViewById(R.id.touchShield)
        continueButton = findViewById(R.id.continueButton)
        debugText = findViewById(R.id.debugText)
        routeText = findViewById(R.id.routeText)
        calibButton = findViewById(R.id.calibButton)
        calibDistance = findViewById(R.id.calibDistance)
        plateDistance = findViewById(R.id.plateDistance)
        stepLengthEdit = findViewById(R.id.stepLength)
        sightingEdit = findViewById(R.id.sightingDistance)
        plateCalibEdit = findViewById(R.id.plateCalib)
        maxSigmaEdit = findViewById(R.id.maxSigma)
        driftEdit = findViewById(R.id.drift)
        hardwareStepCheck = findViewById(R.id.hardwareStepCheck)
        adaptiveStepCheck = findViewById(R.id.adaptiveStepCheck)
        dimCheck = findViewById(R.id.dimCheck)
        guidanceVolumeEdit = findViewById(R.id.guidanceVolume)
        findViewById<View>(R.id.volumeUpButton).setOnClickListener { adjustVolume(AudioManager.ADJUST_RAISE) }
        findViewById<View>(R.id.volumeDownButton).setOnClickListener { adjustVolume(AudioManager.ADJUST_LOWER) }
        mapView = findViewById(R.id.mapView)
        banner = findViewById(R.id.banner)
        maneuverIcon = findViewById(R.id.maneuverIcon)
        distanceText = findViewById(R.id.distanceText)
        titleText = findViewById(R.id.titleText)
        subtitleText = findViewById(R.id.subtitleText)
        thenChip = findViewById(R.id.thenChip)
        thenIcon = findViewById(R.id.thenIcon)
        stopButton = findViewById(R.id.stopButton)
        etaText = findViewById(R.id.etaText)
        etaDetail = findViewById(R.id.etaDetail)
        toolsPanel = findViewById(R.id.toolsPanel)
        findViewById<View>(R.id.cameraCard).clipToOutline = true

        startOverlay.setOnClickListener { startNavigation() }
        findViewById<View>(R.id.overlayToolsButton).setOnClickListener { toolsPanel.visibility = View.VISIBLE; updateUi(force = true) }
        setupTouchShield()
        stopButton.setOnClickListener { stopNavigation() }
        continueButton.setOnClickListener { engine?.continueAfterArrival() }
        findViewById<View>(R.id.repeatButton).setOnClickListener {
            if (engine?.state == NavState.IDLE) speaker.speak("Press start to begin navigation.") else engine?.repeatInstruction()
        }
        findViewById<View>(R.id.overviewButton).setOnClickListener { mapView.overview = !mapView.overview }
        findViewById<View>(R.id.toolsButton).setOnClickListener { toolsPanel.visibility = View.VISIBLE; setDimmed(false); updateUi(force = true) }
        findViewById<View>(R.id.closeToolsButton).setOnClickListener { toolsPanel.visibility = View.GONE; updateUi(force = true) }
        calibButton.setOnClickListener { toggleCalibration() }
        findViewById<Button>(R.id.plateCalibButton).setOnClickListener { calibratePlate() }
        findViewById<Button>(R.id.markButton).setOnClickListener { surveyMark() }
        findViewById<Button>(R.id.resetStepsButton).setOnClickListener {
            counterSteps = 0; counterDistanceM = 0.0; hardwareStepsSeen = 0; accelStepsSeen = 0
            logger.log("counter_reset", engine?.snapshot(), heading)
            updateUi(force = true)
        }
        findViewById<Button>(R.id.shareButton).setOnClickListener { shareLog() }
        diagButton = findViewById(R.id.diagButton)
        diagButton.setOnClickListener { toggleDiagnostics() }
        findViewById<Button>(R.id.saveButton).setOnClickListener { saveSettings() }
    }

    private fun startNavigation() {
        val e = engine ?: return
        if (e.state != NavState.IDLE && e.state != NavState.FINISHED) return
        e.config = settings.toConfig()
        turnDetector.reset()
        logger.startNew("nav")
        ensureGuidanceVolume()
        logger.log("config", null, heading, e.config.toString().replace(",", ";"))
        e.start(SystemClock.elapsedRealtime())
        shieldUnlocked = false
        setDimmed(true)
        updateUi(force = true)
    }

    private fun stopNavigation() {
        val e = engine ?: return
        if (e.state == NavState.IDLE) return
        e.stop()
        speaker.speak("Navigation stopped.", urgent = true)
        statusText.text = "Navigation stopped."
        logger.startNew("session")
        mapView.overview = true
        setDimmed(false)
        updateUi(force = true)
    }

    /** Raise media volume to the configured level if it is lower (never lowers it). */
    private fun ensureGuidanceVolume() {
        val pct = settings.guidanceVolumePct
        if (pct <= 0) return
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val target = (max * pct / 100.0).toInt().coerceIn(1, max)
        val current = am.getStreamVolume(AudioManager.STREAM_MUSIC)
        if (current < target) {
            try {
                am.setStreamVolume(AudioManager.STREAM_MUSIC, target, AudioManager.FLAG_SHOW_UI)
            } catch (e: SecurityException) {
                // e.g. Do Not Disturb policy; leave the volume as it is
            }
        }
        logger.log("volume", null, heading, "media=$current->${am.getStreamVolume(AudioManager.STREAM_MUSIC)}/$max target=$pct%")
    }

    /** During navigation volume up is "continue/repeat", so the app offers its own volume step. */
    private fun adjustVolume(direction: Int) {
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI)
    }

    private fun toggleCalibration() {
        if (!calibrating) {
            calibrating = true
            calibSteps = 0
            calibAmplitudes.clear()
            calibButton.text = "Stop"
            val d = calibDistance.text.toString().toDoubleOrNull() ?: 10.0
            speaker.speak("Walk exactly ${fmt(d, 0)} metres at your normal pace, then tap stop.")
            logger.log("calib_start", null, heading, "distance=$d")
        } else {
            calibrating = false
            calibButton.text = "Calibrate step"
            val d = calibDistance.text.toString().toDoubleOrNull() ?: 10.0
            if (calibSteps < 5) {
                speaker.speak("Only $calibSteps steps detected. Calibration not saved.")
                return
            }
            val len = d / calibSteps
            settings.stepLengthM = len
            stepModel.fixedM = len
            val k = StepLengthModel.calibrateK(d, calibAmplitudes)
            if (k != null) { settings.weinbergK = k; stepModel.k = k }
            logger.log("calib_adaptive", null, heading, "k=${k?.let { fmt(it, 4) } ?: "not enough bounce data"}")
            stepLengthEdit.setText(fmt(len, 3))
            engine?.config = settings.toConfig()
            speaker.speak("Step length ${fmt(len, 2)} metres from $calibSteps steps." +
                if (k != null) " Adaptive step length calibrated." else " Not enough movement data for adaptive steps; using a fixed length.")
            logger.log("calib_done", null, heading, "distance=$d steps=$calibSteps stepLength=${fmt(len, 3)}")
        }
    }

    private fun calibratePlate() {
        val d = plateDistance.text.toString().toDoubleOrNull()
        if (d == null || lastMatchHeight <= 0.0) {
            Toast.makeText(this, "Point the camera at a route plate first", Toast.LENGTH_SHORT).show()
            return
        }
        val calib = d * lastMatchHeight
        settings.plateSizeCalib = calib
        plateCalibEdit.setText(fmt(calib, 4))
        engine?.config = settings.toConfig()
        logger.log("plate_calib", engine?.snapshot(), heading, "plate=$lastMatchText distance=$d height=${fmt(lastMatchHeight, 4)} calib=${fmt(calib, 4)}")
        Toast.makeText(this, "Plate calibration = ${fmt(calib, 4)}", Toast.LENGTH_SHORT).show()
    }

    private fun surveyMark() {
        val detail = "counterSteps=$counterSteps distance_est=${fmt(counterDistanceM, 2)} " +
            "hw=$hardwareStepsSeen accel=$accelStepsSeen lastOcr=$lastOcrText"
        logger.log("survey_mark", engine?.snapshot(), heading, detail)
        logger.flush()
        Toast.makeText(this, "Marked at $counterSteps steps", Toast.LENGTH_SHORT).show()
    }

    /** Raw sensor CSV: walk 30 counted steps between start and stop, then compare the counts. */
    private fun toggleDiagnostics() {
        if (!diagnostics.running) {
            val report = diagnostics.start()
            diagReport = report.toString()
            diagButton.text = "Stop sensor diagnostic"
            logger.log("diag_start", engine?.snapshot(), heading, diagReport.replace("\n", "; "))
            speaker.speak("Sensor diagnostic started. Walk exactly 30 steps, then tap stop.")
        } else {
            val f = diagnostics.stop()
            diagButton.text = "Sensor diagnostic"
            val result = "detector=${diagnostics.detectorSteps} counter=${diagnostics.counterSteps}"
            diagReport = "Last run: $result\n${f?.name ?: ""}"
            logger.log("diag_stop", engine?.snapshot(), heading, "$result file=${f?.name}")
            speaker.speak("Sensor diagnostic stopped. Step detector ${diagnostics.detectorSteps}, step counter ${diagnostics.counterSteps}.")
            if (f != null && !isFinishing) shareFile(f)
        }
        updateUi(force = true)
    }

    private fun shareLog() {
        logger.flush()
        logger.file?.let { shareFile(it) }
    }

    private fun shareFile(f: File) {
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/csv"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(intent, "Share ${f.name}"))
    }

    private fun fillSettingsFields() {
        stepLengthEdit.setText(fmt(settings.stepLengthM, 3))
        sightingEdit.setText(fmt(settings.sightingDistanceM, 2))
        plateCalibEdit.setText(fmt(settings.plateSizeCalib, 4))
        maxSigmaEdit.setText(fmt(settings.maxSigmaM, 2))
        driftEdit.setText(fmt(settings.driftFraction, 3))
        hardwareStepCheck.isChecked = settings.useHardwareStepDetector
        adaptiveStepCheck.isChecked = settings.adaptiveSteps
        dimCheck.isChecked = settings.dimWhileNavigating
        guidanceVolumeEdit.setText(settings.guidanceVolumePct.toString())
    }

    private fun saveSettings() {
        stepLengthEdit.text.toString().toDoubleOrNull()?.let { settings.stepLengthM = it }
        sightingEdit.text.toString().toDoubleOrNull()?.let { settings.sightingDistanceM = it }
        plateCalibEdit.text.toString().toDoubleOrNull()?.let { settings.plateSizeCalib = it }
        maxSigmaEdit.text.toString().toDoubleOrNull()?.let { settings.maxSigmaM = it }
        driftEdit.text.toString().toDoubleOrNull()?.let { settings.driftFraction = it }
        settings.useHardwareStepDetector = hardwareStepCheck.isChecked
        stepFusion.reset(preferHardwareSteps)
        settings.adaptiveSteps = adaptiveStepCheck.isChecked
        settings.dimWhileNavigating = dimCheck.isChecked
        setDimmed(isNavigating() && !shieldUnlocked)
        stepModel.fixedM = settings.stepLengthM
        stepModel.adaptive = settings.adaptiveSteps
        guidanceVolumeEdit.text.toString().toIntOrNull()?.let { settings.guidanceVolumePct = it }
        engine?.config = settings.toConfig()
        logger.log("settings_saved", engine?.snapshot(), heading, settings.toConfig().toString().replace(",", ";"))
        Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
    }

    // ------------------------------------------------------------------ physical controls
    //
    // While worn, the screen faces the user's chest, so everything is done with buttons he can find
    // by touch on the edge of the phone (or a headset / Bluetooth remote button):
    //   Volume up (tap)          start · continue after a waypoint · repeat instruction
    //   Volume up (hold)         louder
    //   Volume down (tap)        "where am I?" status
    //   Volume down (hold 2 s)   stop navigation
    //   Headset / remote button  same as volume up tap

    /** The one "do the next thing" action. */
    private fun primaryAction() {
        val e = engine ?: return
        when (e.state) {
            NavState.IDLE, NavState.FINISHED -> startNavigation()
            NavState.AWAITING_CONTINUE -> e.continueAfterArrival()
            else -> e.repeatInstruction()
        }
        updateUi(force = true)
    }

    /** Spoken summary of where the user is and what comes next. */
    private fun statusAction() {
        val e = engine
        val r = route
        if (e == null || r == null) return
        val snap = e.snapshot()
        if (snap.state == NavState.IDLE || snap.state == NavState.FINISHED) {
            speaker.speak(WELCOME, urgent = true)
            return
        }
        val g = GuidanceBuilder.build(r, snap, settings.toConfig().arrivalToleranceM)
        val parts = mutableListOf<String>()
        when (snap.state) {
            NavState.LOST -> parts += "Location uncertain. Please stop and face along the corridor."
            NavState.AWAITING_CONTINUE -> parts += "You are at ${snap.segmentTo}. Press volume up to continue."
            else -> {
                parts += "Heading to ${g.destination}, about ${g.remainingToDestinationM.toInt()} metres away."
                parts += g.distanceM?.let { d -> if (d >= 1.5) "${g.title} in about ${d.toInt()} metres." else "${g.title} now." }
                    ?: "${g.title}."
            }
        }
        speaker.speak(parts.joinToString(" "), urgent = true)
        logger.log("status_request", snap, heading)
    }

    private fun isNavigating(): Boolean = engine?.state.let { it != null && it != NavState.IDLE && it != NavState.FINISHED }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        val held = event != null && event.repeatCount > 0
        when (keyCode) {
            KeyEvent.KEYCODE_VOLUME_UP -> {
                if (held) { if (event!!.repeatCount % 3 == 0) adjustVolume(AudioManager.ADJUST_RAISE) }
                else event?.startTracking()
                return true
            }
            KeyEvent.KEYCODE_VOLUME_DOWN -> {
                if (!held) { volDownStopFired = false; event?.startTracking(); return true }
                if (!volDownStopFired && event!!.eventTime - event.downTime >= 2000) {
                    volDownStopFired = true
                    if (isNavigating()) stopNavigation() else adjustVolume(AudioManager.ADJUST_LOWER)
                }
                return true
            }
            // Bluetooth camera-shutter remotes, wired headset buttons
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_HEADSETHOOK, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                if (!held) primaryAction()
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    /** Taps are handled on release, so that holding a key can mean something else. */
    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        val tap = event != null && !event.isCanceled && event.eventTime - event.downTime < 500
        when (keyCode) {
            KeyEvent.KEYCODE_VOLUME_UP -> { if (tap) primaryAction(); return true }
            KeyEvent.KEYCODE_VOLUME_DOWN -> { if (tap && !volDownStopFired) statusAction(); return true }
        }
        return super.onKeyUp(keyCode, event)
    }

    /** Bluetooth headset (e.g. bone-conduction) play/pause button = primary action. */
    private fun setupMediaSession() {
        val session = MediaSession(this, "E3Navigator")
        session.setCallback(object : MediaSession.Callback() {
            override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
                val ke: KeyEvent? = if (Build.VERSION.SDK_INT >= 33) {
                    mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
                } else {
                    @Suppress("DEPRECATION") mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                }
                if (ke != null && ke.action == KeyEvent.ACTION_DOWN && ke.repeatCount == 0) {
                    logger.log("headset_button", engine?.snapshot(), heading, "key=${ke.keyCode}")
                    primaryAction()
                }
                return true
            }
        })
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE)
                .setState(PlaybackState.STATE_PLAYING, 0, 1f)
                .build()
        )
        session.isActive = true
        mediaSession = session
    }

    /** During navigation every touch is swallowed. Testers unlock by holding a finger on the screen for 3 s. */
    private fun setupTouchShield() {
        val unlock = Runnable {
            shieldUnlocked = true
            touchShield.visibility = View.GONE
            setDimmed(false)
            Toast.makeText(this, "Screen unlocked for testing", Toast.LENGTH_SHORT).show()
            logger.log("screen_unlocked", engine?.snapshot(), heading)
        }
        touchShield.setOnTouchListener { _, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> handler.postDelayed(unlock, 3000)
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> handler.removeCallbacks(unlock)
            }
            true
        }
    }

    /** Dim the screen while worn: nobody can see it, it saves battery, and it doesn't glow on the user's chest. */
    private fun setDimmed(dim: Boolean) {
        val lp = window.attributes
        lp.screenBrightness = if (dim && settings.dimWhileNavigating) 0.02f else android.view.WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        window.attributes = lp
    }

    // ------------------------------------------------------------------ UI

    private fun updateUi(force: Boolean = false) {
        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastUiUpdate < 200) return
        lastUiUpdate = now
        val e = engine
        val snap = e?.snapshot()
        val navigating = e != null && e.state != NavState.IDLE && e.state != NavState.FINISHED
        startOverlay.visibility = if (navigating || toolsPanel.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        touchShield.visibility = if (navigating && !shieldUnlocked && toolsPanel.visibility != View.VISIBLE) View.VISIBLE else View.GONE
        stopButton.visibility = if (navigating) View.VISIBLE else View.INVISIBLE
        continueButton.visibility = if (e?.state == NavState.AWAITING_CONTINUE) View.VISIBLE else View.GONE
        val r = route
        if (e != null && r != null && snap != null) {
            mapView.update(snap)
            updateBanner(r, snap)
        }
        if (toolsPanel.visibility != View.VISIBLE) return

        val ocrAge = if (lastOcrMs == 0L) "-" else "${(now - lastOcrMs) / 1000}s ago"
        debugText.text = buildString {
            if (snap != null) {
                appendLine("State    ${snap.state}${if (snap.offCourse) " (OFF COURSE)" else ""}${if (snap.turnPending) " (turn pending)" else ""}${if (snap.awaitingStartTurn) " (awaiting start turn)" else ""}")
                appendLine("Segment  ${snap.segmentIndex + 1}: ${snap.segmentFrom} -> ${snap.segmentTo}")
                appendLine("Position ${fmt(snap.positionM, 1)} / ${fmt(snap.segmentLengthM, 1)} m   ±${fmt(snap.sigmaM, 2)} m  ${snap.confidence}")
                appendLine("Net turn ${fmt(snap.netTurnDeg, 0)}°   Last landmark ${snap.lastLandmark ?: "-"}")
            }
            val sinceStep = if (lastStepMs == 0L) "never" else "${(now - lastStepMs) / 1000}s ago"
            appendLine("Steps    counter=$counterSteps  hw=$hardwareStepsSeen  accel=$accelStepsSeen  using=${stepFusion.active}  last=$sinceStep")
            appendLine("Distance ${fmt(counterDistanceM, 1)} m  last step ${fmt(lastStepLengthM, 2)} m  " +
                (if (stepModel.isAdaptiveActive) "adaptive (K=${fmt(stepModel.k, 3)})" else "fixed ${fmt(settings.stepLengthM, 3)} m") +
                (if (calibrating) "  CALIBRATING ($calibSteps)" else ""))
            appendLine("Heading  ${heading?.let { fmt(it, 0) + "°" } ?: "-"} (${sensors.headingSensorName})")
            appendLine("OCR      ${lastOcrText.take(60)} ($ocrAge)")
            if (lastMatchText.isNotEmpty()) appendLine("Plate    $lastMatchText  h=${fmt(lastMatchHeight, 4)}")
            if (diagnostics.running) appendLine("Diag     RUNNING detector=${diagnostics.detectorSteps} counter=${diagnostics.counterSteps}")
            if (diagReport.isNotEmpty()) append(diagReport)
        }
    }

    /** Instruction banner + bottom ETA bar, from the same guidance the voice uses. */
    private fun updateBanner(r: Route, snap: com.example.e3navigator.core.NavSnapshot) {
        val g = GuidanceBuilder.build(r, snap, settings.toConfig().arrivalToleranceM)
        maneuverIcon.maneuver = g.maneuver
        distanceText.visibility = if (g.distanceM != null) View.VISIBLE else View.GONE
        distanceText.text = g.distanceM?.let { distanceLabel(it) } ?: ""
        titleText.text = g.title
        subtitleText.text = g.subtitle ?: ""
        subtitleText.visibility = if (g.subtitle.isNullOrEmpty()) View.GONE else View.VISIBLE
        val colour = Color.parseColor(if (g.warning) "#C5221F" else "#188038")
        (banner.background.mutate() as? GradientDrawable)?.setColor(colour)
        thenChip.visibility = if (g.then != null && !g.warning) View.VISIBLE else View.GONE
        g.then?.let { thenIcon.maneuver = it }
        banner.contentDescription = listOfNotNull(g.distanceM?.let { "In ${distanceLabel(it)}" }, g.title, g.subtitle).joinToString(". ")

        if (snap.state == NavState.IDLE || snap.state == NavState.FINISHED) {
            etaText.text = minutesLabel(r.totalLengthM)
            etaDetail.text = "${r.totalLengthM.toInt()} m · ${r.name}"
        } else {
            etaText.text = minutesLabel(g.remainingToDestinationM)
            val arriveAt = SimpleDateFormat("HH:mm", Locale.getDefault())
                .format(Date(System.currentTimeMillis() + (g.remainingToDestinationM / WALK_SPEED_MPS * 1000).toLong()))
            etaDetail.text = "${g.remainingToDestinationM.toInt()} m · $arriveAt\nto ${g.destination}"
        }
    }

    private fun distanceLabel(m: Double) = if (m < 1.5) "Now" else "${m.toInt()} m"

    private fun minutesLabel(m: Double): String {
        val min = ceil(m / WALK_SPEED_MPS / 60.0).toInt().coerceAtLeast(1)
        return "$min min"
    }

    private fun fmt(x: Double, decimals: Int) = String.format(Locale.US, "%.${decimals}f", x)

    companion object {
        /** Typical walking speed of a cane user, for ETA only. */
        const val WALK_SPEED_MPS = 0.9

        const val WELCOME = "E3 Navigator is ready. Fasten the phone on your chest with the camera facing forward. " +
            "Then press the upper volume button to start. During the walk, press it again to repeat an instruction, " +
            "or after arriving, to continue. Press the lower volume button to hear where you are. " +
            "Hold the lower volume button for two seconds to stop."
    }
}
