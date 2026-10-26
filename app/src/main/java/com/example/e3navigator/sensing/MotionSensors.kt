package com.example.e3navigator.sensing

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import com.example.e3navigator.core.AccelStepDetector
import com.example.e3navigator.core.StepAmplitudeTracker
import kotlin.math.atan2
import kotlin.math.hypot

enum class StepSource { HARDWARE, ACCEL }

/**
 * Reads the phone's motion sensors (function F2).
 *
 * - Steps: Android's hardware step detector AND the app's accelerometer detector run side by
 *   side. The app feeds the selected one to navigation and logs the other, so the team can
 *   compare them in the step-detection tests.
 * - Heading: the game rotation vector (gyro + accelerometer, no magnetometer, which is
 *   unreliable indoors near steel). The camera's pointing direction is projected onto the
 *   horizontal plane, so a tilted chest-mounted phone still gives the walking direction.
 *
 * Callbacks arrive on the main thread.
 */
class MotionSensors(context: Context, private val listener: Listener) : SensorEventListener {

    interface Listener {
        fun onStep(source: StepSource, timeMs: Long)
        fun onHeading(timeMs: Long, headingDeg: Double)
    }

    private val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val stepSensor: Sensor? = sm.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR)
    private val accel: Sensor? = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private val rotationSensor: Sensor? =
        sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR) ?: sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)

    private val accelDetector = AccelStepDetector()

    /** Bounce of the current step (peak-to-trough of filtered acceleration), for the adaptive step length. */
    val amplitude = StepAmplitudeTracker()
    private val rot = FloatArray(9)
    private var running = false

    val hasHardwareStepDetector: Boolean get() = stepSensor != null
    val hasHeading: Boolean get() = rotationSensor != null
    val headingSensorName: String get() = rotationSensor?.let { if (it.type == Sensor.TYPE_GAME_ROTATION_VECTOR) "game rotation vector" else "rotation vector" } ?: "none"

    /** Set false if ACTIVITY_RECOGNITION was refused (hardware step detector needs it on Android 10+). */
    var hardwareStepsPermitted = true

    fun start() {
        if (running) return
        running = true
        accelDetector.reset()
        if (stepSensor != null && hardwareStepsPermitted) {
            // maxReportLatencyUs = 0: deliver each step immediately, no batching.
            sm.registerListener(this, stepSensor, SensorManager.SENSOR_DELAY_FASTEST, 0)
        }
        accel?.let { sm.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
        rotationSensor?.let { sm.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
    }

    fun stop() {
        if (!running) return
        running = false
        sm.unregisterListener(this)
    }

    override fun onSensorChanged(event: SensorEvent) {
        val now = SystemClock.elapsedRealtime()
        when (event.sensor.type) {
            Sensor.TYPE_STEP_DETECTOR -> listener.onStep(StepSource.HARDWARE, now)
            Sensor.TYPE_ACCELEROMETER -> {
                val v = event.values
                val step = accelDetector.onSample(now, v[0].toDouble(), v[1].toDouble(), v[2].toDouble())
                amplitude.onSample(accelDetector.currentFiltered)
                if (step) listener.onStep(StepSource.ACCEL, now)
            }
            Sensor.TYPE_GAME_ROTATION_VECTOR, Sensor.TYPE_ROTATION_VECTOR -> {
                // Some Samsung firmwares return 5 values; older Android versions throw on more than 4.
                val v = if (event.values.size > 4) event.values.copyOf(4) else event.values
                SensorManager.getRotationMatrixFromVector(rot, v)
                // Camera looks along the device's -Z axis. world = R * (0, 0, -1)
                val east = -rot[2].toDouble()
                val north = -rot[5].toDouble()
                if (hypot(east, north) < 0.3) return // phone pointing almost straight up/down
                var deg = Math.toDegrees(atan2(east, north))
                if (deg < 0) deg += 360.0
                listener.onHeading(now, deg)
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
