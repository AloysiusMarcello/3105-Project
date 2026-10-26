package com.example.e3navigator.feedback

import android.content.Context
import android.media.AudioAttributes
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.example.e3navigator.core.HapticKind
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Spoken guidance (function F7) through whatever audio device is connected,
 * e.g. a Bluetooth bone-conduction headset.
 *
 * Reports the delay from request to speech start via [onLatency], for the report's
 * instruction-latency requirement.
 */
class Speaker(context: Context, private val onLatency: (text: String, ms: Long) -> Unit) : TextToSpeech.OnInitListener {
    private val tts = TextToSpeech(context.applicationContext, this)
    private var ready = false
    private val pending = ArrayList<Pair<String, Boolean>>()
    private val requestedAt = ConcurrentHashMap<String, Pair<String, Long>>()
    private var counter = 0
    private var lastText = ""
    private var lastAt = 0L

    var rate: Float = 1.0f
        set(v) {
            field = v
            if (ready) tts.setSpeechRate(v)
        }

    override fun onInit(status: Int) {
        if (status != TextToSpeech.SUCCESS) return
        val res = tts.setLanguage(Locale.UK)
        if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) tts.setLanguage(Locale.ENGLISH)
        tts.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
        )
        tts.setSpeechRate(rate)
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) {
                requestedAt.remove(utteranceId)?.let { (text, t) -> onLatency(text, SystemClock.elapsedRealtime() - t) }
            }
            override fun onDone(utteranceId: String) = Unit
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String) = Unit
        })
        ready = true
        pending.forEach { (t, u) -> speak(t, u) }
        pending.clear()
    }

    fun speak(text: String, urgent: Boolean = false) {
        val now = SystemClock.elapsedRealtime()
        if (text == lastText && now - lastAt < 1500) return // never repeat on every sensor event
        lastText = text
        lastAt = now
        if (!ready) {
            pending += text to urgent
            return
        }
        val id = "u${counter++}"
        requestedAt[id] = text to now
        // Full volume within the media stream; the stream itself is set by MainActivity.
        val params = Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f) }
        tts.speak(text, if (urgent) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, params, id)
    }

    fun shutdown() {
        tts.stop()
        tts.shutdown()
    }
}

/** Short vibration patterns that back up the speech (useful in a noisy corridor). */
class Haptics(context: Context) {
    private val vibrator: Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }

    fun play(kind: HapticKind) {
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        val pattern = when (kind) {
            HapticKind.TURN_SOON -> longArrayOf(0, 80, 120, 80)
            HapticKind.TURN_NOW -> longArrayOf(0, 350)
            HapticKind.CONFIRM -> longArrayOf(0, 40)
            HapticKind.WARNING -> longArrayOf(0, 150, 100, 150, 100, 150)
            HapticKind.ARRIVED -> longArrayOf(0, 400, 150, 400)
        }
        v.vibrate(VibrationEffect.createWaveform(pattern, -1))
    }
}
