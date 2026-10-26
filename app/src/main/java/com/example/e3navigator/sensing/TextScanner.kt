package com.example.e3navigator.sensing

import android.os.SystemClock
import android.util.Size
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.example.e3navigator.core.TextObservation
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Camera + on-device OCR (function F2, visual part).
 *
 * CameraX delivers frames; ML Kit reads text. Frames are processed in memory only and never
 * saved or transmitted (report §9.4 Privacy / PDPA).
 *
 * [onText] is called on the main thread with every text line found (plus multi-line blocks
 * joined), each with its height as a fraction of the image height for range estimation.
 */
class TextScanner(
    private val activity: AppCompatActivity,
    private val previewView: PreviewView,
    private val onText: (observations: List<TextObservation>, rawText: String, processingMs: Long) -> Unit,
    private val onError: (String) -> Unit,
) {
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()

    @Volatile var enabled = true
    @Volatile private var lastRunMs = 0L

    fun start() {
        val future = ProcessCameraProvider.getInstance(activity)
        future.addListener({
            try {
                val provider = future.get()
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                val selector = ResolutionSelector.Builder()
                    .setResolutionStrategy(
                        ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)
                    )
                    .build()
                val analysis = ImageAnalysis.Builder()
                    .setResolutionSelector(selector)
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(executor) { proxy -> analyze(proxy) }
                provider.unbindAll()
                provider.bindToLifecycle(activity, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (e: Exception) {
                onError("Camera failed to start: ${e.message}")
            }
        }, ContextCompat.getMainExecutor(activity))
    }

    @OptIn(ExperimentalGetImage::class)
    private fun analyze(proxy: ImageProxy) {
        val now = SystemClock.elapsedRealtime()
        val media = proxy.image
        if (!enabled || media == null || now - lastRunMs < MIN_INTERVAL_MS) {
            proxy.close()
            return
        }
        lastRunMs = now
        val rotation = proxy.imageInfo.rotationDegrees
        val uprightHeight = (if (rotation % 180 == 0) proxy.height else proxy.width).toDouble()
        val input = InputImage.fromMediaImage(media, rotation)

        recognizer.process(input)
            .addOnSuccessListener { text ->
                val obs = ArrayList<TextObservation>()
                for (block in text.textBlocks) {
                    var maxH = 0.0
                    for (line in block.lines) {
                        val h = (line.boundingBox?.height() ?: 0) / uprightHeight
                        maxH = maxOf(maxH, h)
                        obs += TextObservation(line.text, h)
                    }
                    if (block.lines.size > 1) obs += TextObservation(block.text.replace('\n', ' '), maxH)
                }
                onText(obs, text.text, SystemClock.elapsedRealtime() - now)
            }
            .addOnFailureListener { e -> onError("OCR error: ${e.message}") }
            .addOnCompleteListener { proxy.close() }
    }

    fun shutdown() {
        executor.shutdown()
        recognizer.close()
    }

    companion object {
        /** At most ~4 OCR runs per second: enough at walking speed, and saves battery. */
        const val MIN_INTERVAL_MS = 250L
    }
}
