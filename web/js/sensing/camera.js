/**
 * Camera + on-device OCR (function F2, visual part; replaces TextScanner.kt).
 *
 * getUserMedia delivers the rear camera; text is read by the browser's built-in TextDetector
 * where it exists (Shape Detection API), otherwise by Tesseract.js running locally in
 * WebAssembly. Frames are processed in memory only and never saved or transmitted
 * (report §9.4 Privacy / PDPA); the CDN only supplies the OCR code and language model.
 *
 * `onText(observations, rawText, processingMs)` gets every text line found (plus multi-line
 * blocks joined), each with its height as a fraction of the image height for range estimation.
 *
 * Phones can pause the preview or stall the camera stream (screen off, app switch, another tab
 * taking the camera), leaving a frozen frame that OCR would read forever. A watchdog resumes a
 * paused preview and reopens the camera when the stream ends or stops producing new images;
 * `onEvent(event, detail)` reports this for the log.
 */

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
/** At most ~4 OCR runs per second: enough at walking speed, and saves battery. */
const MIN_INTERVAL_MS = 250;
/** Frames are scaled down to at most this width before OCR (speed vs. reading small plates). */
const MAX_OCR_WIDTH = 1280;
/** Size of the pixel sample used to tell a new frame from a frozen one (sensor noise makes every real frame differ). */
const SAMPLE_W = 64;
const SAMPLE_H = 48;
/** No new image for this long while the page is visible means the stream has stalled. */
const FROZEN_MS = 5000;
/** Reopen the camera at most this often. */
const RESTART_GAP_MS = 15000;
/** One Tesseract pass taking longer than this means the worker has hung. */
const OCR_TIMEOUT_MS = 20000;

export class TextScanner {
  constructor(video, onText, onError, onStatus = () => {}, onEvent = () => {}) {
    this.video = video;
    this.onText = onText;
    this.onError = onError;
    this.onStatus = onStatus;
    this.onEvent = onEvent;
    this.enabled = true;
    this.engineName = 'none';
    this.status = 'off';
    this.stream = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    const sample = document.createElement('canvas');
    sample.width = SAMPLE_W;
    sample.height = SAMPLE_H;
    this.sampleCtx = sample.getContext('2d', { willReadFrequently: true });
    this.sampleCtx.imageSmoothingEnabled = false; // keep per-pixel noise; averaging could hide it
    this.running = false;
    this.lastRunMs = 0;
    /** Mean time per OCR cycle, used to widen the landmark confirmation window when OCR is slow. */
    this.avgCycleMs = 0;
    this.worker = null;
    this.detector = null;
    this.wanted = false;
    this.restarting = false;
    this.restarts = 0;
    this.lastRestartAt = 0;
    this.frameHash = 0;
    this.ocrHash = null;
    /** When the camera last delivered an image that differed from the one before. */
    this.lastFrameAt = 0;
    this.watchTimer = null;
  }

  setStatus(s) {
    this.status = s;
    this.onStatus(s);
  }

  /** @param {'auto'|'tesseract'|'off'} engine */
  async start(engine = 'auto') {
    if (!(await this.openCamera())) return false;
    this.wanted = true;
    this.watchTimer = setInterval(() => this.watch(), 1000);
    if (engine === 'off') {
      this.setStatus('camera on, OCR off');
      return true;
    }
    await this.initOcr(engine);
    if (this.engineName !== 'none') {
      this.running = true;
      this.loop();
    }
    return true;
  }

  async openCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch (e) {
      this.setStatus('camera unavailable');
      this.onError(`Camera failed to start: ${e.message || e.name}`);
      return false;
    }
    this.stream.getVideoTracks()[0]?.addEventListener('ended', () => this.onEvent('camera_track_ended', ''));
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.lastFrameAt = performance.now();
    return true;
  }

  /** Samples the preview and notes when the image last changed. Returns the sample's hash. */
  sampleFrame() {
    this.sampleCtx.drawImage(this.video, 0, 0, SAMPLE_W, SAMPLE_H);
    const d = this.sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    let h = 0;
    let max = 0;
    for (let i = 0; i < d.length; i++) {
      h = (Math.imul(h, 31) + d[i]) | 0;
      if ((i & 3) !== 3 && d[i] > max) max = d[i];
    }
    // A covered lens gives steady black images: nothing to read, but not a stalled stream.
    if (h !== this.frameHash || max < 16) {
      this.frameHash = h;
      this.lastFrameAt = performance.now();
    }
    return h;
  }

  /** Once a second: keep the preview playing, and reopen the camera if the stream ended or froze. */
  watch() {
    const now = performance.now();
    if (!this.wanted || this.restarting || document.hidden) {
      this.lastFrameAt = now; // nothing arrives while hidden: restart the clock
      return;
    }
    const track = this.stream?.getVideoTracks()[0];
    if (!track || track.readyState === 'ended') {
      if (now - this.lastRestartAt > RESTART_GAP_MS) this.restartCamera('camera stream ended');
      return;
    }
    if (this.video.paused) {
      this.onEvent('camera_resume', 'preview was paused');
      this.video.play().catch(() => {});
      return;
    }
    if (this.video.readyState >= 2) this.sampleFrame();
    const stale = now - this.lastFrameAt;
    if (stale > FROZEN_MS && now - this.lastRestartAt > RESTART_GAP_MS) {
      this.restartCamera(`no new image for ${Math.round(stale / 1000)} s`);
    }
  }

  async restartCamera(reason) {
    this.restarting = true;
    this.restarts++;
    this.lastRestartAt = performance.now();
    this.onEvent('camera_restart', reason);
    this.setStatus('camera restarting…');
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const ok = await this.openCamera();
    this.restarting = false;
    if (ok) this.setStatus(this.engineName === 'none' ? 'camera on, OCR off' : 'ready');
  }

  async initOcr(engine) {
    if (engine === 'auto' && 'TextDetector' in window) {
      try {
        this.detector = new window.TextDetector();
        // Some browsers expose the class but have no backend: probe once.
        await this.detector.detect(this.video);
        this.engineName = 'TextDetector (built-in)';
        this.setStatus('ready');
        return;
      } catch {
        this.detector = null;
      }
    }
    try {
      this.setStatus('loading Tesseract…');
      await loadScript(TESSERACT_URL);
      this.worker = await window.Tesseract.createWorker('eng', 1, {
        logger: (m) => {
          if (m.status && m.progress != null && m.progress < 1) this.setStatus(`${m.status} ${Math.round(m.progress * 100)}%`);
        },
      });
      // Default page segmentation. (Sparse-text mode, PSM 11, read nothing from a clear plate in testing.)
      // A fixed DPI stops a console warning on every frame; camera frames carry no DPI.
      await this.worker.setParameters({ user_defined_dpi: '300' });
      this.engineName = 'Tesseract.js';
      this.setStatus('ready');
    } catch (e) {
      this.engineName = 'none';
      this.setStatus('OCR failed to load');
      this.onError(`OCR failed to load: ${e.message || e}`);
    }
  }

  async loop() {
    while (this.running) {
      const wait = MIN_INTERVAL_MS - (performance.now() - this.lastRunMs);
      if (wait > 0) await sleep(wait);
      if (!this.running) break;
      if (!this.enabled || this.restarting || this.video.readyState < 2 || document.hidden) {
        await sleep(200);
        continue;
      }
      // Never read the same image twice: two readings of one frozen frame would wrongly confirm a sign.
      const hash = this.sampleFrame();
      if (hash === this.ocrHash) {
        await sleep(150);
        continue;
      }
      this.ocrHash = hash;
      const t0 = performance.now();
      if (this.lastRunMs) {
        const cycle = t0 - this.lastRunMs;
        this.avgCycleMs = this.avgCycleMs ? this.avgCycleMs * 0.8 + cycle * 0.2 : cycle;
      }
      this.lastRunMs = t0;
      try {
        const { observations, raw } = await this.recognise();
        this.onText(observations, raw, performance.now() - t0);
      } catch (e) {
        this.onError(`OCR error: ${e.message || e}`);
        if (e instanceof OcrTimeout) await this.resetWorker();
        await sleep(1000);
      }
    }
  }

  async recognise() {
    const v = this.video;
    if (this.detector) {
      const found = await this.detector.detect(v);
      const h = v.videoHeight || 1;
      const observations = found.map((t) => ({ text: t.rawValue ?? '', heightFraction: t.boundingBox.height / h }))
        .filter((o) => o.text);
      return { observations, raw: observations.map((o) => o.text).join('\n') };
    }
    const scale = Math.min(1, MAX_OCR_WIDTH / (v.videoWidth || MAX_OCR_WIDTH));
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(v, 0, 0, w, h);
    const { data } = await withTimeout(this.worker.recognize(this.canvas), OCR_TIMEOUT_MS);
    const observations = [];
    for (const block of data.blocks ?? []) {
      const lines = (block.paragraphs ?? []).flatMap((p) => p.lines ?? []);
      let maxH = 0;
      for (const line of lines) {
        const text = line.text.trim();
        const lh = (line.bbox.y1 - line.bbox.y0) / h;
        maxH = Math.max(maxH, lh);
        if (text) observations.push({ text, heightFraction: lh });
      }
      if (lines.length > 1) observations.push({ text: block.text.replace(/\n/g, ' ').trim(), heightFraction: maxH });
    }
    return { observations, raw: data.text ?? '' };
  }

  /** A hung Tesseract worker never answers again: replace it. */
  async resetWorker() {
    this.onEvent('ocr_restart', `a pass took over ${OCR_TIMEOUT_MS / 1000} s`);
    this.worker?.terminate();
    this.worker = null;
    await this.initOcr('tesseract');
  }

  stop() {
    this.running = false;
    this.wanted = false;
    clearInterval(this.watchTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.worker?.terminate();
    this.worker = null;
  }
}

class OcrTimeout extends Error {}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new OcrTimeout(`OCR took over ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src === src)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}
