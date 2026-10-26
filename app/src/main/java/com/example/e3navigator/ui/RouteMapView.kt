package com.example.e3navigator.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import com.example.e3navigator.core.EndAction
import com.example.e3navigator.core.NavSnapshot
import com.example.e3navigator.core.NavState
import com.example.e3navigator.core.Route
import com.example.e3navigator.core.RouteGeometry
import com.example.e3navigator.core.TurnDetector
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Maps-style schematic map of the surveyed route.
 *
 * Navigating: heading-up, the user's arrow fixed in the lower third, the active leg in blue and
 * the walked part in grey. The light-blue halo around the arrow is the position uncertainty (±σ).
 * Before starting (or after tapping the overview button): north-up overview of the whole route.
 */
class RouteMapView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    private var route: Route? = null
    private var geo: RouteGeometry? = null
    private var snap: NavSnapshot? = null
    var overview = true
        set(v) { field = v; invalidate() }

    // Smoothly animated camera
    private var camX = 0.0; private var camY = 0.0; private var camHeading = 0.0
    private var dotX = 0.0; private var dotY = 0.0; private var arrowHeading = 0.0; private var halo = 0.0
    private var initialised = false

    private val d = resources.displayMetrics.density
    private val bg = Color.parseColor("#F1F3F4")
    private val corridorFill = paint(Color.WHITE, Paint.Style.STROKE)
    private val corridorEdge = paint(Color.parseColor("#DADCE0"), Paint.Style.STROKE)
    private val routeOutline = paint(Color.parseColor("#1557B0"), Paint.Style.STROKE)
    private val routeActive = paint(Color.parseColor("#4285F4"), Paint.Style.STROKE)
    private val routeInactive = paint(Color.parseColor("#AECBFA"), Paint.Style.STROKE)
    private val routeWalked = paint(Color.parseColor("#BDC1C6"), Paint.Style.STROKE)
    private val haloFill = paint(Color.parseColor("#334285F4"), Paint.Style.FILL)
    private val haloEdge = paint(Color.parseColor("#664285F4"), Paint.Style.STROKE).apply { strokeWidth = 1.5f * d }
    private val arrowFill = paint(Color.parseColor("#1A73E8"), Paint.Style.FILL)
    private val arrowLost = paint(Color.parseColor("#9AA0A6"), Paint.Style.FILL)
    private val arrowEdge = paint(Color.WHITE, Paint.Style.STROKE).apply { strokeWidth = 3f * d; strokeJoin = Paint.Join.ROUND }
    private val pinRed = paint(Color.parseColor("#EA4335"), Paint.Style.FILL)
    private val pinDark = paint(Color.parseColor("#B31412"), Paint.Style.FILL)
    private val poi = paint(Color.parseColor("#80868B"), Paint.Style.FILL)
    private val white = paint(Color.WHITE, Paint.Style.FILL)
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#3C4043"); textSize = 12f * d; isFakeBoldText = true
        setShadowLayer(3f * d, 0f, 0f, Color.WHITE)
    }

    private val m = Matrix()
    private val pts = FloatArray(2)

    private fun paint(c: Int, s: Paint.Style) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = c; style = s; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }

    fun setRoute(r: Route) {
        route = r
        geo = RouteGeometry(r)
        initialised = false
        invalidate()
    }

    fun update(s: NavSnapshot) {
        val wasNavigating = snap?.state.let { it != null && it != NavState.IDLE && it != NavState.FINISHED }
        val navigating = s.state != NavState.IDLE && s.state != NavState.FINISHED
        snap = s
        // Follow the user when navigation starts; show the whole route when it ends.
        if (navigating != wasNavigating) overview = !navigating
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(bg)
        val g = geo ?: return
        val r = route ?: return
        val s = snap

        // Target camera
        val segI = s?.segmentIndex ?: 0
        val p = g.pointAt(segI, s?.positionM ?: 0.0)
        val routeHeading = g.headingAt(segI)
        val userHeading = routeHeading + (s?.netTurnDeg ?: 0.0)
        val tgtHalo = (s?.sigmaM ?: 0.0).coerceAtMost(8.0)

        if (!initialised) {
            camX = p.x; camY = p.y; camHeading = routeHeading; dotX = p.x; dotY = p.y; arrowHeading = userHeading; halo = tgtHalo
            initialised = true
        }
        val k = 0.18
        dotX += (p.x - dotX) * k; dotY += (p.y - dotY) * k
        halo += (tgtHalo - halo) * k
        arrowHeading += TurnDetector.angleDiff(userHeading, arrowHeading) * k

        // Camera: heading-up following the user, or north-up overview of the whole route
        val scale: Float
        val anchorX = width / 2f
        val anchorY: Float
        val rot: Double
        if (overview) {
            val xs = g.segments.flatMap { listOf(it.x0, it.x1) }; val ys = g.segments.flatMap { listOf(it.y0, it.y1) }
            val spanX = max(xs.max() - xs.min(), 10.0); val spanY = max(ys.max() - ys.min(), 10.0)
            scale = min((width * 0.75f) / spanX.toFloat(), (height * 0.5f) / spanY.toFloat())
            camX += ((xs.max() + xs.min()) / 2 - camX) * k; camY += ((ys.max() + ys.min()) / 2 - camY) * k
            camHeading += TurnDetector.angleDiff(0.0, camHeading) * k
            anchorY = height * 0.52f
            rot = camHeading
        } else {
            scale = height / 45f // ~45 m of corridor visible
            camX += (dotX - camX) * k; camY += (dotY - camY) * k
            camHeading += TurnDetector.angleDiff(routeHeading, camHeading) * k
            anchorY = height * 0.68f
            rot = camHeading
        }

        // world (x east, y north) -> screen
        m.reset()
        m.postTranslate((-camX).toFloat(), (-camY).toFloat())
        m.postScale(scale, -scale)
        m.postRotate((-rot).toFloat())
        m.postTranslate(anchorX, anchorY)

        fun scr(x: Double, y: Double): Pair<Float, Float> {
            pts[0] = x.toFloat(); pts[1] = y.toFloat(); m.mapPoints(pts); return pts[0] to pts[1]
        }

        // Corridors (drawn wide, like streets)
        corridorEdge.strokeWidth = 3.4f * scale + 2f * d
        corridorFill.strokeWidth = 3.4f * scale
        val path = Path()
        for (seg in g.segments) {
            val (ax, ay) = scr(seg.x0, seg.y0); val (bx, by) = scr(seg.x1, seg.y1)
            path.moveTo(ax, ay); path.lineTo(bx, by)
        }
        canvas.drawPath(path, corridorEdge)
        canvas.drawPath(path, corridorFill)

        // Route: inactive legs, active leg (to next waypoint), walked part
        val active = activeRange(r, segI)
        val w = 7f * d
        routeInactive.strokeWidth = w; routeOutline.strokeWidth = w + 3f * d; routeActive.strokeWidth = w; routeWalked.strokeWidth = w
        g.segments.forEachIndexed { i, seg ->
            if (i !in active) line(canvas, scr(seg.x0, seg.y0), scr(seg.x1, seg.y1), routeInactive)
        }
        for (i in active) {
            val seg = g.segments[i]
            val start = if (i == segI) g.pointAt(i, s?.positionM ?: 0.0) else RouteGeometry.Pt(seg.x0, seg.y0)
            line(canvas, scr(start.x, start.y), scr(seg.x1, seg.y1), routeOutline)
            line(canvas, scr(start.x, start.y), scr(seg.x1, seg.y1), routeActive)
            if (i == segI) line(canvas, scr(seg.x0, seg.y0), scr(start.x, start.y), routeWalked)
        }

        // Landmarks (grey dots with labels) and waypoints (red pins)
        r.segments.forEachIndexed { i, seg ->
            for (lm in seg.landmarks) {
                if (lm.confirmsArrival) continue
                val lp = g.pointAt(i, lm.positionM); val (x, y) = scr(lp.x, lp.y)
                canvas.drawCircle(x, y, 5f * d, white); canvas.drawCircle(x, y, 3.5f * d, poi)
                canvas.drawText(lm.text, x + 8f * d, y + 4f * d, label)
            }
            if (seg.endAction == EndAction.ARRIVE) {
                val e = scr(g.segments[i].x1, g.segments[i].y1)
                pin(canvas, e.first, e.second, if (i in active) pinRed else pinDark, i in active)
                canvas.drawText(seg.to, e.first + 14f * d, e.second - 16f * d, label)
            }
        }

        // User arrow with uncertainty halo
        val (ux, uy) = scr(dotX, dotY)
        val haloPx = max(halo.toFloat() * scale, 14f * d)
        canvas.drawCircle(ux, uy, haloPx, haloFill); canvas.drawCircle(ux, uy, haloPx, haloEdge)
        canvas.save()
        canvas.translate(ux, uy)
        canvas.rotate((arrowHeading - rot).toFloat())
        val a = Path().apply {
            moveTo(0f, -14f * d); lineTo(11f * d, 12f * d); lineTo(0f, 6f * d); lineTo(-11f * d, 12f * d); close()
        }
        canvas.drawPath(a, arrowEdge)
        canvas.drawPath(a, if (s?.state == NavState.LOST) arrowLost else arrowFill)
        canvas.restore()

        // Keep animating until settled
        val moving = abs(p.x - dotX) > 0.01 || abs(p.y - dotY) > 0.01 || abs(tgtHalo - halo) > 0.01 ||
            abs(TurnDetector.angleDiff(userHeading, arrowHeading)) > 0.2 ||
            abs(TurnDetector.angleDiff(if (overview) 0.0 else routeHeading, camHeading)) > 0.2
        if (moving) postInvalidateOnAnimation()
    }

    /** Segments from the current one up to and including the next ARRIVE. */
    private fun activeRange(r: Route, from: Int): IntRange {
        var end = from
        while (end < r.segments.lastIndex && r.segments[end].endAction != EndAction.ARRIVE) end++
        return from..end
    }

    private fun line(c: Canvas, a: Pair<Float, Float>, b: Pair<Float, Float>, p: Paint) =
        c.drawLine(a.first, a.second, b.first, b.second, p)

    private fun pin(c: Canvas, x: Float, y: Float, fill: Paint, big: Boolean) {
        val r = (if (big) 11f else 8f) * d
        val p = Path().apply {
            moveTo(x, y)
            lineTo(x - r * 0.75f, y - r * 1.4f)
            arcTo(RectF(x - r, y - r * 2.6f, x + r, y - r * 0.6f), 150f, 240f)
            close()
        }
        c.drawPath(p, fill)
        c.drawCircle(x, y - r * 1.6f, r * 0.38f, pinDark.takeIf { fill != pinDark } ?: white)
    }
}
