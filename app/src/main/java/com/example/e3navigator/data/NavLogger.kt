package com.example.e3navigator.data

import android.content.Context
import android.os.SystemClock
import com.example.e3navigator.core.NavSnapshot
import java.io.BufferedWriter
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * CSV log of everything that happens: steps, turns, OCR readings, position fixes, spoken cues,
 * speech latency, survey marks. Open the CSVs in Excel/Python for the Section 5 / 7 test results.
 *
 * Files: Android/data/com.example.e3navigator/files/logs/  (or use the Share log button).
 */
class NavLogger(context: Context) {
    private val dir = File(context.getExternalFilesDir(null), "logs").apply { mkdirs() }
    private var writer: BufferedWriter? = null
    private var lines = 0

    var file: File? = null
        private set

    @Synchronized
    fun startNew(tag: String) {
        close()
        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val f = File(dir, "${tag}_$stamp.csv")
        file = f
        writer = f.bufferedWriter().also {
            it.write("wall_time,elapsed_ms,event,state,segment,pos_m,sigma_m,steps,heading_deg,detail\n")
        }
    }

    @Synchronized
    fun log(event: String, snap: NavSnapshot?, headingDeg: Double?, detail: String = "") {
        val w = writer ?: return
        val wall = SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(Date())
        val row = listOf(
            wall,
            SystemClock.elapsedRealtime().toString(),
            event,
            snap?.state?.name ?: "",
            snap?.segmentId ?: "",
            snap?.let { "%.2f".format(Locale.US, it.positionM) } ?: "",
            snap?.let { "%.2f".format(Locale.US, it.sigmaM) } ?: "",
            snap?.totalSteps?.toString() ?: "",
            headingDeg?.let { "%.1f".format(Locale.US, it) } ?: "",
            "\"" + detail.replace("\"", "'").replace("\n", " ") + "\"",
        ).joinToString(",")
        w.write(row)
        w.write("\n")
        if (++lines % 20 == 0) w.flush()
    }

    @Synchronized
    fun flush() {
        writer?.flush()
    }

    @Synchronized
    fun close() {
        writer?.flush()
        writer?.close()
        writer = null
    }
}
