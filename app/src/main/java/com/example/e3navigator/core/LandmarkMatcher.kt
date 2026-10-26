package com.example.e3navigator.core

/** One piece of text read by OCR in a camera frame. */
data class TextObservation(
    val text: String,
    /** Height of the text's bounding box divided by the image height (0..1). Used for range estimation. */
    val heightFraction: Double = 0.0,
)

/**
 * Matches OCR output against landmark text.
 *
 * Both strings are normalised the same way: upper-cased, separators removed, and common
 * OCR letter/digit confusions folded together (O/D/Q->0, I/L->1, Z->2, A->4, S->5, G->6,
 * T->7, B->8). So
 * "E3-O6-O2", "e3 06 02" and "E3-06-02" all match. Matching is exact after normalisation
 * (no fuzzy edit distance), because confusing E3-06-02 with E3-06-03 would be worse than
 * missing a reading.
 */
object LandmarkMatcher {
    private val confusions = mapOf(
        'O' to '0', 'D' to '0', 'Q' to '0',
        'I' to '1', 'L' to '1', '|' to '1',
        'Z' to '2', 'A' to '4', 'S' to '5', 'G' to '6', 'T' to '7', 'B' to '8',
    )

    fun normalise(s: String): String = fold(s).text

    /** Normalised text, plus per character: was it a real digit, and was there whitespace before it. */
    private class Folded(val text: String, val rawDigit: BooleanArray, val spaceBefore: BooleanArray)

    private fun fold(s: String): Folded {
        val sb = StringBuilder()
        val raw = ArrayList<Boolean>()
        val space = ArrayList<Boolean>()
        var sawSpace = false
        for (c in s.uppercase()) {
            if (c.isWhitespace()) sawSpace = true
            if (!c.isLetterOrDigit() && c != '|') continue
            sb.append(confusions[c] ?: c)
            raw += c.isDigit()
            space += sawSpace
            sawSpace = false
        }
        return Folded(sb.toString(), raw.toBooleanArray(), space.toBooleanArray())
    }

    /**
     * True if [detected] contains [expected] as a whole token. A real digit directly before/after
     * rejects the match (E3-06-021, E4-06-02 against "06-02"). A letter folded to a digit only
     * rejects it when attached, so "E3-06-02 SEMINAR" still matches although S folds to 5.
     */
    fun matches(detected: String, expected: String): Boolean {
        val e = normalise(expected)
        if (e.length < 3) return false
        val d = fold(detected)
        fun blocks(i: Int, gap: Boolean) = d.text[i].isDigit() && (d.rawDigit[i] || !gap)
        var from = 0
        while (true) {
            val idx = d.text.indexOf(e, from)
            if (idx < 0) return false
            val afterIdx = idx + e.length
            val blockedBefore = idx > 0 && blocks(idx - 1, d.spaceBefore[idx])
            val blockedAfter = afterIdx < d.text.length && blocks(afterIdx, d.spaceBefore[afterIdx])
            if (!blockedBefore && !blockedAfter) return true
            from = idx + 1
        }
    }

    fun matches(detected: String, landmark: Landmark): Boolean =
        matches(detected, landmark.text) || landmark.aliases.any { matches(detected, it) }
}

/**
 * Requires repeated consistent OCR readings before a landmark counts as seen
 * (a single frame can be misread).
 */
class LandmarkConfirmer(private val minHits: Int, private val windowMs: Long) {
    private val hits = HashMap<String, ArrayDeque<Long>>()

    /** Record a hit; returns true when the landmark becomes confirmed (then its history is cleared). */
    fun hit(landmarkId: String, nowMs: Long): Boolean {
        val q = hits.getOrPut(landmarkId) { ArrayDeque() }
        q.addLast(nowMs)
        while (q.isNotEmpty() && nowMs - q.first() > windowMs) q.removeFirst()
        if (q.size >= minHits) {
            q.clear()
            return true
        }
        return false
    }

    fun clear() = hits.clear()
}
