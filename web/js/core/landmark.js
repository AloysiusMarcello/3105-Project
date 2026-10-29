/**
 * Matches OCR output against landmark text (port of LandmarkMatcher.kt).
 *
 * Both strings are normalised the same way: upper-cased, separators removed, and common
 * OCR letter/digit confusions folded together (O/D/Q->0, I/L->1, Z->2, A->4, S->5, G->6,
 * T->7, B->8). So "E3-O6-O2", "e3 06 02" and "E3-06-02" all match. Matching is exact after
 * normalisation (no fuzzy edit distance), because confusing E3-06-02 with E3-06-03 would be
 * worse than missing a reading.
 */

const CONFUSIONS = {
  O: '0', D: '0', Q: '0',
  I: '1', L: '1', '|': '1',
  Z: '2', A: '4', S: '5', G: '6', T: '7', B: '8',
};

const isDigit = (c) => c >= '0' && c <= '9';
const isLetterOrDigit = (c) => /[\p{L}\p{N}]/u.test(c);
const isWhitespace = (c) => /\s/.test(c);

/** Normalised text, plus per character: was it a real digit, and was there whitespace before it. */
function fold(s) {
  let text = '';
  const rawDigit = [];
  const spaceBefore = [];
  let sawSpace = false;
  for (const c of s.toUpperCase()) {
    if (isWhitespace(c)) sawSpace = true;
    if (!isLetterOrDigit(c) && c !== '|') continue;
    text += CONFUSIONS[c] ?? c;
    rawDigit.push(isDigit(c));
    spaceBefore.push(sawSpace);
    sawSpace = false;
  }
  return { text, rawDigit, spaceBefore };
}

export function normalise(s) {
  return fold(s).text;
}

/**
 * True if `detected` contains `expected` as a whole token. A real digit directly before/after
 * rejects the match (E3-06-021, E4-06-02 against "06-02"). A letter folded to a digit only
 * rejects it when attached, so "E3-06-02 SEMINAR" still matches although S folds to 5.
 */
export function matchesText(detected, expected) {
  const e = normalise(expected);
  if (e.length < 3) return false;
  const d = fold(detected);
  const blocks = (i, gap) => isDigit(d.text[i]) && (d.rawDigit[i] || !gap);
  let from = 0;
  for (;;) {
    const idx = d.text.indexOf(e, from);
    if (idx < 0) return false;
    const afterIdx = idx + e.length;
    const blockedBefore = idx > 0 && blocks(idx - 1, d.spaceBefore[idx]);
    const blockedAfter = afterIdx < d.text.length && blocks(afterIdx, d.spaceBefore[afterIdx]);
    if (!blockedBefore && !blockedAfter) return true;
    from = idx + 1;
  }
}

export function matchesLandmark(detected, lm) {
  return matchesText(detected, lm.text) || lm.aliases.some((a) => matchesText(detected, a));
}

/**
 * Requires repeated consistent OCR readings before a landmark counts as seen
 * (a single frame can be misread).
 */
export class LandmarkConfirmer {
  constructor(minHits, windowMs) {
    this.minHits = minHits;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** Record a hit; returns true when the landmark becomes confirmed (then its history is cleared). */
  hit(landmarkId, nowMs) {
    let q = this.hits.get(landmarkId);
    if (!q) this.hits.set(landmarkId, (q = []));
    q.push(nowMs);
    while (q.length && nowMs - q[0] > this.windowMs) q.shift();
    if (q.length >= this.minHits) {
      q.length = 0;
      return true;
    }
    return false;
  }

  clear() {
    this.hits.clear();
  }
}
