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
 */

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
/** At most ~4 OCR runs per second: enough at walking speed, and saves battery. */
const MIN_INTERVAL_MS = 250;
/** Frames are scaled down to at most this width before OCR (speed vs. reading small plates). */
const MAX_OCR_WIDTH = 1280;

export class TextScanner {
  constructor(video, onText, onError, onStatus = () => {}) {
    this.video = video;
    this.onText = onText;
    this.onError = onError;
    this.onStatus = onStatus;
    this.enabled = true;
    this.engineName = 'none';
    this.status = 'off';
    this.stream = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.running = false;
    this.lastRunMs = 0;
    /** Mean time per OCR cycle, used to widen the landmark confirmation window when OCR is slow. */
    this.avgCycleMs = 0;
    this.worker = null;
    this.detector = null;
  }

  setStatus(s) {
    this.status = s;
    this.onStatus(s);
  }

  /** @param {'auto'|'tesseract'|'off'} engine */
  async start(engine = 'auto') {
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
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
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
      if (!this.enabled || this.video.readyState < 2 || document.hidden) {
        await sleep(200);
        continue;
      }
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
    const { data } = await this.worker.recognize(this.canvas);
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

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.worker?.terminate();
    this.worker = null;
  }
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
