import { makeConfig, DEFAULT_CONFIG } from '../core/config.js';
import { parseRoute } from '../core/route.js';

/** localStorage that never throws (private windows, blocked site data). */
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); return true; } catch { return false; }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

const SETTINGS_KEY = 'e3nav.settings';

const SETTING_DEFAULTS = {
  stepLengthM: DEFAULT_CONFIG.stepLengthM,
  sightingDistanceM: DEFAULT_CONFIG.sightingDistanceM,
  plateSizeCalib: DEFAULT_CONFIG.plateSizeCalib,
  maxSigmaM: DEFAULT_CONFIG.maxSigmaM,
  driftFraction: DEFAULT_CONFIG.driftFraction,
  /** Weinberg constant for adaptive step length (set by the calibration walk). 0 = not calibrated. */
  weinbergK: 0,
  /** Estimate each step's length from its bounce (shorter steps in crowds) instead of a fixed length. */
  adaptiveSteps: true,
  /** Black out the screen while navigating (it faces the user's chest). Turn off for demos. */
  dimWhileNavigating: true,
  /** Double-tap anywhere on the locked screen = the main button (for phones with no headset or remote). */
  doubleTapControl: true,
  speechRate: 1.0,
  /** auto = browser TextDetector if present, else Tesseract.js; off = camera preview only. */
  ocrEngine: 'auto',
};

/** User-tunable parameters, persisted in the browser (port of AppSettings.kt). */
export class AppSettings {
  constructor() {
    let saved = {};
    try { saved = JSON.parse(store.get(SETTINGS_KEY, '{}')) ?? {}; } catch { saved = {}; }
    Object.assign(this, SETTING_DEFAULTS, saved);
  }

  save() {
    const o = {};
    for (const k of Object.keys(SETTING_DEFAULTS)) o[k] = this[k];
    store.set(SETTINGS_KEY, JSON.stringify(o));
  }

  toConfig() {
    return makeConfig({
      stepLengthM: this.stepLengthM,
      sightingDistanceM: this.sightingDistanceM,
      plateSizeCalib: this.plateSizeCalib,
      maxSigmaM: this.maxSigmaM,
      driftFraction: this.driftFraction,
    });
  }
}

const ROUTE_OVERRIDE_KEY = 'e3nav.routeOverride';
const BUILT_IN_ROUTE = 'routes/e3_route.json';

/**
 * Loads the route JSON (port of RouteLoader.kt). A route file loaded in the testing tools is
 * kept in the browser and overrides the built-in one, so the route can be re-surveyed and
 * updated without editing the site (report §9.2.3 Maintainability).
 */
export const RouteLoader = {
  async load() {
    const override = store.get(ROUTE_OVERRIDE_KEY);
    if (override) {
      const { name, json } = JSON.parse(override);
      return { route: parseRoute(json), source: `loaded file ${name}` };
    }
    const res = await fetch(BUILT_IN_ROUTE, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${BUILT_IN_ROUTE}: HTTP ${res.status}`);
    return { route: parseRoute(await res.text()), source: `built-in ${BUILT_IN_ROUTE}` };
  },

  /** Validates and stores an uploaded route file; throws with a readable message if it is invalid. */
  setOverride(name, json) {
    const route = parseRoute(json);
    if (!store.set(ROUTE_OVERRIDE_KEY, JSON.stringify({ name, json }))) throw new Error('browser storage is blocked');
    return route;
  },

  clearOverride() {
    store.remove(ROUTE_OVERRIDE_KEY);
  },
};
