package com.example.e3navigator.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import com.example.e3navigator.core.Maneuver

/** Draws the turn arrow in the instruction banner (white strokes, like a navigation turn card). */
class ManeuverView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    var maneuver: Maneuver = Maneuver.STRAIGHT
        set(v) { field = v; invalidate() }

    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.FILL }

    override fun onDraw(c: Canvas) {
        val s = minOf(width, height).toFloat()
        c.save()
        c.translate((width - s) / 2f, (height - s) / 2f)
        c.scale(s / 24f, s / 24f) // draw in a 24x24 grid
        stroke.strokeWidth = 2.6f
        when (maneuver) {
            Maneuver.STRAIGHT -> { c.drawLine(12f, 21f, 12f, 5f, stroke); head(c, 12f, 3f, 0f) }
            Maneuver.TURN_LEFT -> turn(c, left = true)
            Maneuver.TURN_RIGHT -> turn(c, left = false)
            Maneuver.FACE_LEFT -> { c.drawLine(18f, 12f, 7f, 12f, stroke); head(c, 4.5f, 12f, -90f); door(c, 2f) }
            Maneuver.FACE_RIGHT -> { c.drawLine(6f, 12f, 17f, 12f, stroke); head(c, 19.5f, 12f, 90f); door(c, 21f) }
            Maneuver.TURN_AROUND -> {
                val p = Path().apply { moveTo(16f, 21f); lineTo(16f, 10f); arcTo(RectF(8f, 4f, 16f, 12f), 0f, -180f); lineTo(8f, 17f) }
                c.drawPath(p, stroke); head(c, 8f, 19.5f, 180f)
            }
            Maneuver.ARRIVE, Maneuver.DONE -> {
                val p = Path().apply {
                    moveTo(12f, 22f); lineTo(6.6f, 12.5f); arcTo(RectF(5.5f, 2.5f, 18.5f, 15.5f), 150f, 240f); close()
                }
                c.drawPath(p, fill)
                c.drawCircle(12f, 9f, 2.4f, Paint(fill).apply { color = Color.parseColor("#188038") })
            }
            Maneuver.LOST -> {
                c.drawCircle(12f, 12f, 9.5f, stroke)
                c.drawLine(12f, 7f, 12f, 13.5f, stroke)
                c.drawCircle(12f, 17f, 1.5f, fill)
            }
        }
        c.restore()
    }

    private fun turn(c: Canvas, left: Boolean) {
        val p = Path()
        if (left) {
            p.moveTo(16f, 21f); p.lineTo(16f, 13f); p.quadTo(16f, 9f, 12f, 9f); p.lineTo(6f, 9f)
            c.drawPath(p, stroke); head(c, 4f, 9f, -90f)
        } else {
            p.moveTo(8f, 21f); p.lineTo(8f, 13f); p.quadTo(8f, 9f, 12f, 9f); p.lineTo(18f, 9f)
            c.drawPath(p, stroke); head(c, 20f, 9f, 90f)
        }
    }

    /** Filled arrow head with its tip at (x, y), pointing [deg] clockwise from up. */
    private fun head(c: Canvas, x: Float, y: Float, deg: Float) {
        c.save(); c.translate(x, y); c.rotate(deg)
        c.drawPath(Path().apply { moveTo(0f, -1f); lineTo(4.5f, 5f); lineTo(-4.5f, 5f); close() }, fill)
        c.restore()
    }

    private fun door(c: Canvas, x: Float) {
        c.drawLine(x, 5f, x, 19f, Paint(stroke).apply { strokeWidth = 2f })
    }
}
