import { AccelStepDetector, StepAmplitudeTracker } from '../core/detectors.js';

const DEG = 180 / Math.PI;

/**
 * Reads the phone's motion sensors in the browser (function F2; replaces MotionSensors.kt).
 *
 * - Steps: the app's accelerometer detector on `devicemotion` (browsers have no hardware
 *   step detector).
 * - Heading: RelativeOrientationSensor (gyro + accelerometer, no magnetometer, like Android's
 *   game rotation vector) where available, otherwise `deviceorientation`. The camera's pointing
 *   direction (device −Z) is projected onto the horizontal plane, so a tilted chest-mounted
 *   phone still gives the walking direction.
 *
 * Sensors need a secure context (https:// or localhost). iOS asks for permission on a tap.
 */
export class MotionSensors {
  /** @param {{onStep(timeMs:number):void, onHeading(timeMs:number, deg:number):void, onSample?(row:object):void}} listener */
  constructor(listener) {
    this.listener = listener;
    this.detector = new AccelStepDetector();
    /** Bounce of the current step (peak-to-trough of filtered acceleration), for the adaptive step length. */
    this.amplitude = new StepAmplitudeTracker();
    this.running = false;
    this.headingSource = 'none';
    this.motionSamples = 0;
    this.motionHz = 0;
    this.headingSamples = 0;
    this._rateWindow = [];
    this._orientationSensor = null;
    this._onMotion = (e) => this.handleMotion(e);
    this._onOrientation = (e) => this.handleOrientation(e);
  }

  /** iOS 13+ requires an explicit permission request from a user gesture. Returns a short status. */
  static async requestPermission() {
    const results = [];
    for (const Ev of [window.DeviceMotionEvent, window.DeviceOrientationEvent]) {
      if (Ev && typeof Ev.requestPermission === 'function') {
        try { results.push(await Ev.requestPermission()); } catch (e) { results.push(`error: ${e.message}`); }
      }
    }
    return results.length ? results.join(', ') : 'not needed';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.detector.reset();
    window.addEventListener('devicemotion', this._onMotion);
    this.startOrientation();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    window.removeEventListener('devicemotion', this._onMotion);
    window.removeEventListener('deviceorientation', this._onOrientation);
    try { this._orientationSensor?.stop(); } catch { /* already stopped */ }
    this._orientationSensor = null;
  }

  startOrientation() {
    if ('RelativeOrientationSensor' in window) {
      try {
        const s = new window.RelativeOrientationSensor({ frequency: 60, referenceFrame: 'device' });
        s.addEventListener('reading', () => {
          const [x, y, z, w] = s.quaternion;
          // Rotation matrix third column (device z axis in world); camera looks along −z.
          this.emitHeading(-2 * (x * z + w * y), -2 * (y * z - w * x));
        });
        s.addEventListener('error', () => this.fallbackOrientation());
        s.start();
        this._orientationSensor = s;
        this.headingSource = 'relative orientation sensor';
        return;
      } catch {
        // Not allowed (permissions policy) or not supported: use the event instead.
      }
    }
    this.fallbackOrientation();
  }

  fallbackOrientation() {
    try { this._orientationSensor?.stop(); } catch { /* ignore */ }
    this._orientationSensor = null;
    if (!this.running) return;
    window.removeEventListener('deviceorientation', this._onOrientation);
    window.addEventListener('deviceorientation', this._onOrientation);
    this.headingSource = 'deviceorientation';
  }

  handleOrientation(e) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    const a = e.alpha / DEG;
    const b = e.beta / DEG;
    const g = e.gamma / DEG;
    // R = Rz(alpha)·Rx(beta)·Ry(gamma); third column = device z axis in world (x east, y north).
    const m13 = Math.cos(g) * Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.sin(g);
    const m23 = Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.cos(g) * Math.sin(b);
    this.emitHeading(-m13, -m23);
  }

  emitHeading(east, north) {
    if (Math.hypot(east, north) < 0.3) return; // phone pointing almost straight up/down
    let deg = Math.atan2(east, north) * DEG;
    if (deg < 0) deg += 360;
    this.headingSamples++;
    this.listener.onHeading(performance.now(), deg);
  }

  handleMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const now = performance.now();
    this.motionSamples++;
    this._rateWindow.push(now);
    while (this._rateWindow.length && now - this._rateWindow[0] > 2000) this._rateWindow.shift();
    this.motionHz = this._rateWindow.length / 2;
    const step = this.detector.onSample(now, a.x, a.y, a.z);
    this.amplitude.onSample(this.detector.currentFiltered);
    this.listener.onSample?.({ t: now, ax: a.x, ay: a.y, az: a.z, filtered: this.detector.currentFiltered, step });
    if (step) this.listener.onStep(now);
  }
}
