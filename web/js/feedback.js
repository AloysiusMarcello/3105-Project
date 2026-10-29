import { HapticKind } from './core/engine.js';

/**
 * Spoken guidance (function F7) through the browser's speech synthesis, which plays through
 * whatever audio device is connected, e.g. a Bluetooth bone-conduction headset.
 *
 * Browsers only allow speech after the user has touched the page, so call unlock() from a tap.
 * Reports the delay from request to speech start via onLatency, for the report's
 * instruction-latency requirement.
 */
export class Speaker {
  constructor(onLatency) {
    this.onLatency = onLatency;
    this.synth = window.speechSynthesis ?? null;
    this.rate = 1.0;
    this.voice = null;
    this.unlocked = false;
    this.pending = [];
    this.lastText = '';
    this.lastAt = 0;
    if (this.synth) {
      this.pickVoice();
      this.synth.addEventListener?.('voiceschanged', () => this.pickVoice());
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
    u.onstart = () => this.onLatency(text, Math.round(performance.now() - now));
    if (urgent) this.synth.cancel();
    this.synth.speak(u);
  }

  stop() {
    this.synth?.cancel();
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
