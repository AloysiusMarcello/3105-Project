package com.example.e3navigator.data

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import androidx.core.content.ContextCompat
import java.io.BufferedWriter
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Raw sensor log for debugging "distance reads zero" on a particular phone.
 *
 * Writes every step-detector, step-counter, rotation-vector and linear-acceleration event to
 * Android/data/com.example.e3navigator/files/logs/sensors_*.csv (shareable with Share log).
 * It runs alongside MotionSensors, so it can be used during a normal walk.
 *
 * Procedure: start, walk exactly 30 counted steps, stop, then compare the counts.
 *  - No STEP_DETECTOR rows          -> sensor missing, not registered, or permission refused
 *  - Rows arrive in late bursts      -> batching (registration here uses maxReportLatencyUs = 0)
 *  - Rows present, counts match      -> sensors are fine; the fault is downstream (step length, UI)
 */
class SensorDiagnosticLogger(private val context: Context) : SensorEventListener {

    private val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private var writer: BufferedWriter? = null
    private var rows = 0L

    var file: File? = null
        private set
    val running: Boolean get() = writer != null

    /** Steps seen by TYPE_STEP_DETECTOR since start(). */
    var detectorSteps = 0
        private set

    /** Steps since start() according to TYPE_STEP_COUNTER (which counts from boot). */
    var counterSteps = 0
        private set
    private var counterBaseline = Float.NaN

    data class PreFlight(
        val activityRecognitionGranted: Boolean,
        val hasStepDetector: Boolean,
        val hasStepCounter: Boolean,
        val hasGameRotationVector: Boolean,
        val hasRotationVector: Boolean,
        val hasAccelerometer: Boolean,
    ) {
        val usable: Boolean get() = activityRecognitionGranted && (hasStepDetector || hasStepCounter)

        override fun toString() = buildString {
            appendLine("ACTIVITY_RECOGNITION granted  $activityRecognitionGranted")
            appendLine("STEP_DETECTOR                 $hasStepDetector")
            appendLine("STEP_COUNTER                  $hasStepCounter")
            appendLine("GAME_ROTATION_VECTOR          $hasGameRotationVector")
            appendLine("ROTATION_VECTOR               $hasRotationVector")
            appendLine("ACCELEROMETER                 $hasAccelerometer")
            append(if (usable) "-> hardware steps usable" else "-> hardware steps NOT usable (app falls back to accelerometer)")
        }
    }

    fun preFlight() = PreFlight(
        activityRecognitionGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED,
        hasStepDetector = sm.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR) != null,
        hasStepCounter = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null,
        hasGameRotationVector = sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR) != null,
        hasRotationVector = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR) != null,
        hasAccelerometer = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null,
    )

    fun start(): PreFlight {
        stop()
        val report = preFlight()
        val dir = File(context.getExternalFilesDir(null), "logs").apply { mkdirs() }
        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val f = File(dir, "sensors_$stamp.csv")
        file = f
        rows = 0
        detectorSteps = 0
        counterSteps = 0
        counterBaseline = Float.NaN
        writer = f.bufferedWriter().also {
            report.toString().lines().forEach { line -> it.write("# $line\n") }
            it.write("wall_clock_ms,event_ns,sensor,v0,v1,v2,v3,v4,n_values,accuracy\n")
        }
        for (type in SENSORS.keys) {
            // maxReportLatencyUs = 0 defeats batching, which otherwise looks like "no steps".
            sm.getDefaultSensor(type)?.let { sm.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME, 0) }
        }
        return report
    }

    fun stop(): File? {
        if (writer == null) return null
        sm.unregisterListener(this)
        writer?.let {
            it.write("# detectorSteps=$detectorSteps counterSteps=$counterSteps rows=$rows\n")
            it.flush()
            it.close()
        }
        writer = null
        return file
    }

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_STEP_DETECTOR -> detectorSteps++
            Sensor.TYPE_STEP_COUNTER -> {
                val raw = event.values[0]
                if (counterBaseline.isNaN()) counterBaseline = raw
                counterSteps = (raw - counterBaseline).toInt()
            }
        }
        val w = writer ?: return
        val v = event.values
        // n_values is logged because some Samsung firmwares return 5 values from the rotation vectors.
        val cols = (0 until 5).joinToString(",") { i -> v.getOrNull(i)?.toString() ?: "" }
        w.write("${System.currentTimeMillis()},${event.timestamp},${SENSORS[event.sensor.type]},$cols,${v.size},${event.accuracy}\n")
        if (++rows % 200 == 0L) w.flush()
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    companion object {
        private val SENSORS = mapOf(
            Sensor.TYPE_STEP_DETECTOR to "STEP_DETECTOR",
            Sensor.TYPE_STEP_COUNTER to "STEP_COUNTER",
            Sensor.TYPE_GAME_ROTATION_VECTOR to "GAME_ROTATION_VECTOR",
            Sensor.TYPE_ROTATION_VECTOR to "ROTATION_VECTOR",
            Sensor.TYPE_LINEAR_ACCELERATION to "LINEAR_ACCEL",
        )
    }
}
