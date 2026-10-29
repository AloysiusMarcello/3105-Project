import { store } from './storage.js';

const INDEX_KEY = 'e3nav.logs';
const KEEP = 15;
const HEADER = 'wall_time,elapsed_ms,event,state,segment,pos_m,sigma_m,steps,heading_deg,detail\n';

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const wallTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

/**
 * CSV log of everything that happens: steps, turns, OCR readings, position fixes, spoken cues,
 * speech latency, survey marks (port of NavLogger.kt; same columns). Open the CSVs in
 * Excel/Python for the Section 5 / 7 test results.
 *
 * The current file and the last few runs are kept in browser storage; use Share / Download
 * in the testing tools to get them off the phone.
 */
export class NavLogger {
  constructor() {
    this.name = null;
    this.text = '';
    this.lines = 0;
  }

  startNew(tag) {
    this.flush();
    this.name = `${tag}_${stamp(new Date())}.csv`;
    this.text = HEADER;
    this.lines = 0;
    const index = NavLogger.list().filter((n) => n !== this.name);
    index.push(this.name);
    while (index.length > KEEP) store.remove(`e3nav.log.${index.shift()}`);
    store.set(INDEX_KEY, JSON.stringify(index));
  }

  log(event, snap, headingDeg, detail = '') {
    if (!this.name) return;
    const row = [
      wallTime(new Date()),
      Math.round(performance.now()),
      event,
      snap?.state ?? '',
      snap?.segmentId ?? '',
      snap ? snap.positionM.toFixed(2) : '',
      snap ? snap.sigmaM.toFixed(2) : '',
      snap ? snap.totalSteps : '',
      headingDeg != null ? headingDeg.toFixed(1) : '',
      `"${String(detail).replace(/"/g, "'").replace(/\n/g, ' ')}"`,
    ].join(',');
    this.text += `${row}\n`;
    if (++this.lines % 20 === 0) this.flush();
  }

  flush() {
    if (!this.name) return;
    if (!store.set(`e3nav.log.${this.name}`, this.text)) {
      // Storage full: drop the oldest saved run and try once more.
      const index = NavLogger.list();
      if (index.length > 1) {
        store.remove(`e3nav.log.${index.shift()}`);
        store.set(INDEX_KEY, JSON.stringify(index));
        store.set(`e3nav.log.${this.name}`, this.text);
      }
    }
  }

  static list() {
    try { return JSON.parse(store.get(INDEX_KEY, '[]')) ?? []; } catch { return []; }
  }

  static read(name) {
    return store.get(`e3nav.log.${name}`, '');
  }
}

/** Shares a text file through the phone's share sheet where supported, otherwise downloads it. */
export async function shareOrDownload(name, text, type = 'text/csv') {
  const file = new File([text], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'downloaded';
}
