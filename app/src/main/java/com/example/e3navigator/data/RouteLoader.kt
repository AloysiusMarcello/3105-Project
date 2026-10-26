package com.example.e3navigator.data

import android.content.Context
import com.example.e3navigator.core.EndAction
import com.example.e3navigator.core.Landmark
import com.example.e3navigator.core.Route
import com.example.e3navigator.core.Segment
import com.example.e3navigator.core.TurnDir
import org.json.JSONObject
import java.io.File

/**
 * Loads the route JSON.
 *
 * If a file named route.json exists in the app's external files folder
 * (Android/data/com.example.e3navigator/files/route.json — copy it over USB), it is used;
 * otherwise the built-in assets/routes/e3_route.json. So the route can be re-surveyed and
 * updated without rebuilding the app (report §9.2.3 Maintainability).
 */
object RouteLoader {
    const val OVERRIDE_FILE = "route.json"
    private const val ASSET = "routes/e3_route.json"

    data class Loaded(val route: Route, val source: String)

    fun load(context: Context): Loaded {
        val override = File(context.getExternalFilesDir(null), OVERRIDE_FILE)
        return if (override.exists()) {
            Loaded(parse(override.readText()), override.absolutePath)
        } else {
            val json = context.assets.open(ASSET).bufferedReader().use { it.readText() }
            Loaded(parse(json), "built-in $ASSET")
        }
    }

    fun parse(json: String): Route {
        val o = JSONObject(json)
        val segArr = o.getJSONArray("segments")
        val segments = (0 until segArr.length()).map { i ->
            val s = segArr.getJSONObject(i)
            val lmArr = s.optJSONArray("landmarks")
            val landmarks = if (lmArr == null) emptyList() else (0 until lmArr.length()).map { j ->
                val l = lmArr.getJSONObject(j)
                val aliasArr = l.optJSONArray("aliases")
                Landmark(
                    id = l.getString("id"),
                    text = l.getString("text"),
                    positionM = l.getDouble("positionM"),
                    announce = l.optStringOrNull("announce"),
                    confirmsArrival = l.optBoolean("confirmsArrival", false),
                    aliases = if (aliasArr == null) emptyList() else (0 until aliasArr.length()).map { aliasArr.getString(it) },
                    sightingDistanceM = l.optDoubleOrNull("sightingDistanceM"),
                )
            }
            Segment(
                id = s.getString("id"),
                from = s.getString("from"),
                to = s.getString("to"),
                lengthM = s.getDouble("lengthM"),
                endAction = EndAction.valueOf(s.getString("endAction")),
                startInstruction = s.optStringOrNull("startInstruction"),
                startTurn = s.optStringOrNull("startTurn")?.let { TurnDir.valueOf(it) },
                arrivalMessage = s.optStringOrNull("arrivalMessage"),
                arrivalSide = s.optStringOrNull("arrivalSide")?.let { TurnDir.valueOf(it) },
                maxSigmaM = s.optDoubleOrNull("maxSigmaM"),
                landmarks = landmarks,
            )
        }
        return Route(o.getString("routeId"), o.optString("name", o.getString("routeId")), segments)
    }

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (has(key) && !isNull(key)) getString(key) else null

    private fun JSONObject.optDoubleOrNull(key: String): Double? =
        if (has(key) && !isNull(key)) getDouble(key) else null
}
