import { HapticKind } from './core/engine.js';

/**
 * Spoken guidance (function F7) through the browser's speech synthesis, which plays through
 * whatever audio device is connected, e.g. a Bluetooth bone-conduction headset.
 *
 * Browsers only allow speech after the user has touched the page, so call unlock() from a tap.
 * Reports the delay from request to speech start via onLatency, for the report's
 * instruction-latency requirement, and stalls or errors via onEvent(event, detail) for the log.
 *
 * Chrome (notably on Android) can wedge its speech queue: utterances are accepted but never
 * play until something calls cancel(). A watchdog notices queued speech that has not moved and
 * restarts the synthesizer with the newest cue (older cues are stale by then anyway).
 */
/** Queued speech that has neither started nor finished for this long (at rate 1) counts as stuck. */
const STUCK_MS = 12000;

export class Speaker {
  constructor(onLatency, onEvent = () => {}) {
    this.onLatency = onLatency;
    this.onEvent = onEvent;
    this.synth = window.speechSynthesis ?? null;
    this.rate = 1.0;
    this.voice = null;
    this.unlocked = false;
    this.pending = [];
    this.lastText = '';
    this.lastAt = 0;
    /** Utterances queued or playing. Holding them also stops Chrome garbage-collecting them mid-queue. */
    this.live = [];
    /** Last time the queue moved (an utterance started, ended or failed). */
    this.lastMoveAt = 0;
    this.retried = false;
    if (this.synth) {
      this.pickVoice();
      this.synth.addEventListener?.('voiceschanged', () => this.pickVoice());
      setInterval(() => this.watchdog(), 1000);
    }
  }

  get available() {
    return !!this.synth;
  }

  /** Prefer an on-device British English voice (works offline), then any English one. */
  pickVoice() {
    const voices = this.synth.getVoices();
    const score = (v) => (v.lang === 'en-GB' ? 4 : v.lang.startsWith('en') ? 2 : 0) + (v.localService ? 1 : 0);
    this.voice = voices.filter((v) => score(v) >= 2).sort((a, b) => score(b) - score(a))[0] ?? null;
  }

  unlock() {
    if (this.unlocked || !this.synth) return;
    this.unlocked = true;
    // An empty utterance inside the tap handler satisfies autoplay rules on mobile browsers.
    this.synth.speak(new SpeechSynthesisUtterance(''));
    const queued = this.pending;
    this.pending = [];
    queued.forEach(([t, u]) => this.speak(t, u));
  }

  speak(text, urgent = false) {
    const now = performance.now();
    if (text === this.lastText && now - this.lastAt < 1500) return; // never repeat on every sensor event
    this.lastText = text;
    this.lastAt = now;
    if (!this.synth) return;
    if (!this.unlocked) {
      this.pending.push([text, urgent]);
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.voice?.lang ?? 'en-GB';
    if (this.voice) u.voice = this.voice;
    u.rate = this.rate;
    u.volume = 1;
    u.onstart = () => {
      this.lastMoveAt = performance.now();
      this.retried = false;
      this.onLatency(text, Math.round(this.lastMoveAt - now));
    };
    u.onend = () => this.settle(u);
    u.onerror = (e) => {
      this.settle(u);
      // 'interrupted'/'canceled' are our own cancel() calls, not faults.
      if (e.error !== 'interrupted' && e.error !== 'canceled') this.onEvent('tts_error', `${e.error} text=${text}`);
    };
    if (urgent) this.clear();
    if (!this.live.length) this.lastMoveAt = now;
    this.live.push(u);
    this.synth.resume(); // no-op unless Chrome left the synthesizer paused
    this.synth.speak(u);
  }

  settle(u) {
    if (!this.live.includes(u)) return; // already dropped by clear()
    this.lastMoveAt = performance.now();
    this.retried = false;
    this.live = this.live.filter((x) => x !== u);
  }

  clear() {
    this.live = [];
    this.synth.cancel();
  }

  watchdog() {
    if (!this.live.length || performance.now() - this.lastMoveAt < STUCK_MS / this.rate) return;
    const newest = this.live[this.live.length - 1].text;
    // Retry once; if even that never starts, drop it rather than repeating it every few seconds.
    const retry = !this.retried;
    this.onEvent('tts_stuck', `queued=${this.live.length} ${retry ? 'restarting with' : 'dropping'}: ${newest}`);
    this.clear();
    if (!retry) return;
    this.retried = true;
    this.lastText = '';
    this.speak(newest);
  }

  stop() {
    if (this.synth) this.clear();
  }
}

/** Short vibration patterns that back up the speech (useful in a noisy corridor). Android browsers only. */
export class Haptics {
  static PATTERNS = {
    [HapticKind.TURN_SOON]: [80, 120, 80],
    [HapticKind.TURN_NOW]: [350],
    [HapticKind.CONFIRM]: [40],
    [HapticKind.WARNING]: [150, 100, 150, 100, 150],
    [HapticKind.ARRIVED]: [400, 150, 400],
  };

  get available() {
    return typeof navigator.vibrate === 'function';
  }

  play(kind) {
    if (!this.available) return;
    try { navigator.vibrate(Haptics.PATTERNS[kind]); } catch { /* blocked before first tap */ }
  }
}
