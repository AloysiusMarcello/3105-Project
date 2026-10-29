import { matchesLandmark } from './core/landmark.js';
import { NavState, NavigationEngine } from './core/engine.js';
import { buildGuidance } from './core/guidance.js';
import { StepLengthModel, TurnDetector, angleDiff, normaliseDeg } from './core/detectors.js';
import { AppSettings, RouteLoader } from './data/storage.js';
import { NavLogger, shareOrDownload } from './data/logger.js';
import { Haptics, Speaker } from './feedback.js';
import { MotionSensors } from './sensing/motion.js';
import { TextScanner } from './sensing/camera.js';
import { RouteMap } from './ui/map.js';
import { maneuverSvg } from './ui/maneuver.js';

/**
 * Wires the browser's sensors, camera, speech and logging to the NavigationEngine
 * (port of MainActivity.kt).
 */

/** Typical walking speed of a cane user, for ETA only. */
const WALK_SPEED_MPS = 0.9;

const WELCOME = 'E3 Navigator is ready. Fasten the phone on your chest with the camera facing forward. ' +
  'Then press the play button on your headset, or the button on your remote, to start. During the walk, ' +
  'press it again to repeat an instruction, or after arriving, to continue. Press next track to hear where you are. ' +
  'Press previous track to stop.';

const HELP_ARMED = 'or press the main button\n\n' +
  'Main button (headset play/pause, remote, Space): start · continue · repeat\n' +
  'Next track / W: where am I?\n' +
  'Previous track / Esc: stop';
const HELP_UNARMED = 'This turns on the camera, motion sensors and speech.\nCamera frames are read on this device and never stored or uploaded.';

const $ = (id) => document.getElementById(id);
const fmt = (x, d) => Number(x).toFixed(d);
const params = new URLSearchParams(location.search);

// ------------------------------------------------------------------ state

const settings = new AppSettings();
const logger = new NavLogger();
logger.startNew('session');
const speaker = new Speaker((text, ms) => logger.log('tts_latency', snap(), heading, `ms=${ms} text=${text}`));
speaker.rate = settings.speechRate;
const haptics = new Haptics();
const turnDetector = new TurnDetector();
const stepModel = new StepLengthModel(settings.stepLengthM, settings.weinbergK, settings.adaptiveSteps);
const map = new RouteMap($('map'));

let route = null;
let routeSource = '';
/** @type {NavigationEngine|null} */
let engine = null;
let armed = false;
let motion = null;
let scanner = null;
let wakeLock = null;
let shieldUnlocked = false;
let simMode = params.has('sim');

// Live readings for the debug panel / tools
let heading = null;
let counterSteps = 0;
let accelStepsSeen = 0;
let counterDistanceM = 0;
let lastStepLengthM = 0;
let lastStepMs = 0;
// Distance walked in the current (or last) navigation run, shown in the bottom bar
let walkedM = 0;
let walkedSteps = 0;
let calibrating = false;
let calibSteps = 0;
const calibAmplitudes = [];
let lastOcrText = '';
let lastOcrMs = 0;
let lastLoggedOcr = '';
let lastMatchText = '';
let lastMatchHeight = 0;
let lastUiUpdate = 0;
let permissionReport = '';
let cameraStatus = 'off';

const snap = () => engine?.snapshot() ?? null;
const isNavigating = () => engine != null && engine.state !== NavState.IDLE && engine.state !== NavState.FINISHED;
const toolsOpen = () => !$('toolsPanel').hidden;

// ------------------------------------------------------------------ start-up

async function init() {
  bindViews();
  fillSettingsFields();
  if (!window.isSecureContext) {
    const w = $('startWarning');
    w.textContent = 'This page is on plain http://. Phones only allow the camera and motion sensors over https:// ' +
      '(or on localhost). See web/README.md for how to open it on a phone.';
    w.hidden = false;
  }
  if (!speaker.available) toast('This browser has no speech synthesis: guidance will be on screen only.');
  await loadRoute();
  setSimMode(simMode);
  updateOverlay();
  updateUi(true);
}

async function loadRoute() {
  try {
    const loaded = await RouteLoader.load();
    route = loaded.route;
    routeSource = loaded.source;
    engine = new NavigationEngine(route, currentConfig(), onNavOutput);
    map.setRoute(route);
    $('routeText').textContent = `Route: ${route.name} (${route.segments.length} segments, ${fmt(route.totalLengthM, 1)} m)\nSource: ${routeSource}`;
    fillSimSigns();
  } catch (e) {
    route = null;
    engine = null;
    $('routeText').textContent = `ROUTE FILE ERROR: ${e.message}`;
    $('statusText').textContent = 'Route file error. Open the testing tools for details.';
  }
}

/** First tap: everything browsers only allow after the user has touched the page. */
async function arm() {
  if (armed) return;
  armed = true;
  speaker.unlock();
  setupMediaSession(); // starts silent audio, needs the tap
  // iOS: must be the first await inside the tap.
  const perm = await MotionSensors.requestPermission();
  motion = new MotionSensors({
    onStep: (t) => { if (!simMode) { accelStepsSeen++; onStep(t, motion.amplitude.take(), 'ACCEL'); } },
    onHeading: (t, deg) => { if (!simMode) onHeading(t, deg); },
    onSample: (row) => diagnostics.sample(row),
  });
  motion.start();
  permissionReport = `motion permission: ${perm}`;
  logger.log('armed', null, heading, `${permissionReport}; secure=${window.isSecureContext}; ua=${navigator.userAgent}`);
  speaker.speak(WELCOME);
  updateOverlay();
  updateUi(true);

  scanner = new TextScanner($('preview'), onText, (msg) => {
    logger.log('camera_error', snap(), heading, msg);
    $('statusText').textContent = msg;
  }, (s) => { cameraStatus = s; $('cameraLabel').textContent = s; updateUi(); });
  scanner.start(settings.ocrEngine).then((ok) => {
    logger.log('camera', snap(), heading, `ok=${ok} ocr=${scanner.engineName}`);
    $('cameraLabel').textContent = ok ? scanner.engineName : 'Camera off';
    if (!ok) speaker.speak('The camera is not available. Signs cannot be read.');
  });

  // A laptop has no motion sensors: fall back to the simulator so the app can still be tried.
  setTimeout(() => {
    if (motion.motionSamples === 0 && !simMode) {
      setSimMode(true);
      logger.log('sim_auto', null, heading, 'no devicemotion samples within 3 s');
      toast('No motion sensors found, so the simulator is on (see Testing tools).');
    }
  }, 3000);
}

// ------------------------------------------------------------------ sensor inputs

function onStep(timeMs, amp, source) {
  lastStepMs = timeMs;
  counterSteps++;
  const len = stepModel.length(amp);
  lastStepLengthM = len;
  counterDistanceM += len;
  if (calibrating) { calibSteps++; calibAmplitudes.push(amp); }
  if (isNavigating()) {
    walkedM += len;
    walkedSteps++;
    updateWalked();
  }
  engine?.onStep(timeMs, len);
  logger.log('step', snap(), heading, `source=${source} len=${fmt(len, 3)} amp=${amp != null ? fmt(amp, 3) : '-'}`);
  updateUi();
}

function onHeading(timeMs, headingDeg) {
  heading = headingDeg;
  diagnostics.heading = headingDeg;
  const ev = turnDetector.onHeading(timeMs, headingDeg);
  if (ev) {
    logger.log('turn_detected', snap(), heading, `dir=${ev.direction} angle=${fmt(ev.angleDeg, 1)}`);
    engine?.onTurn(ev);
    updateUi(true);
  }
  updateUi();
}

function onText(observations, raw, processingMs) {
  const now = performance.now();
  const flat = raw.replace(/\n/g, ' ').trim();
  if (flat) {
    lastOcrText = flat;
    lastOcrMs = now;
  }
  // Remember the size of any route landmark seen (for plate-size calibration)
  if (route) {
    for (const o of observations) for (const seg of route.segments) for (const lm of seg.landmarks) {
      if (matchesLandmark(o.text, lm)) {
        lastMatchText = lm.text;
        lastMatchHeight = o.heightFraction;
      }
    }
  }
  if (/\d/.test(flat) && flat !== lastLoggedOcr) {
    lastLoggedOcr = flat;
    logger.log('ocr', snap(), heading, `ms=${Math.round(processingMs)} text=${flat}`);
  }
  engine?.onText(observations, now);
  updateUi();
}

// ------------------------------------------------------------------ engine outputs

function onNavOutput(o) {
  const s = engine?.snapshot() ?? null;
  if (o.type === 'speak') {
    speaker.speak(o.text, o.urgent);
    $('statusText').textContent = o.text;
    logger.log('speak', s, heading, o.text);
  } else if (o.type === 'haptic') {
    haptics.play(o.kind);
  } else {
    logger.log(o.event, s, heading, o.detail);
  }
  updateUi(true);
}

// ------------------------------------------------------------------ navigation control

/**
 * Engine settings from the saved settings. Tesseract can take longer than the 1.5 s
 * two-reading window, so the window is widened to 2.5 OCR cycles when OCR is slow.
 */
function currentConfig() {
  const cfg = settings.toConfig();
  const cycle = scanner?.avgCycleMs ?? 0;
  if (cycle > 0) cfg.landmarkWindowMs = Math.max(cfg.landmarkWindowMs, Math.round(cycle * 2.5));
  return cfg;
}

function startNavigation() {
  const e = engine;
  if (!e) return;
  if (e.state !== NavState.IDLE && e.state !== NavState.FINISHED) return;
  e.config = currentConfig();
  turnDetector.reset();
  logger.startNew('nav');
  logger.log('config', null, heading, JSON.stringify(e.config).replace(/,/g, ';'));
  e.start(performance.now());
  walkedM = 0;
  walkedSteps = 0;
  updateWalked();
  shieldUnlocked = false;
  keepAwake(true);
  updateUi(true);
}

function stopNavigation() {
  const e = engine;
  if (!e || e.state === NavState.IDLE) return;
  e.stop();
  speaker.speak('Navigation stopped.', true);
  $('statusText').textContent = 'Navigation stopped.';
  logger.startNew('session');
  map.overview = true;
  keepAwake(false);
  updateUi(true);
}

/** The one "do the next thing" action. */
function primaryAction() {
  if (!armed) { arm(); return; }
  const e = engine;
  if (!e) return;
  if (e.state === NavState.IDLE || e.state === NavState.FINISHED) startNavigation();
  else if (e.state === NavState.AWAITING_CONTINUE) e.continueAfterArrival();
  else e.repeatInstruction();
  updateUi(true);
}

/** Spoken summary of where the user is and what comes next. */
function statusAction() {
  const e = engine;
  if (!e || !route) return;
  const s = e.snapshot();
  if (s.state === NavState.IDLE || s.state === NavState.FINISHED) {
    speaker.speak(WELCOME, true);
    return;
  }
  const g = buildGuidance(route, s, currentConfig().arrivalToleranceM);
  const parts = [];
  if (s.state === NavState.LOST) parts.push('Location uncertain. Please stop and face along the corridor.');
  else if (s.state === NavState.AWAITING_CONTINUE) parts.push(`You are at ${s.segmentTo}. Press the main button to continue.`);
  else {
    parts.push(`Heading to ${g.destination}, about ${Math.trunc(g.remainingToDestinationM)} metres away.`);
    if (g.distanceM == null) parts.push(`${g.title}.`);
    else parts.push(g.distanceM >= 1.5 ? `${g.title} in about ${Math.trunc(g.distanceM)} metres.` : `${g.title} now.`);
  }
  speaker.speak(parts.join(' '), true);
  logger.log('status_request', s, heading);
}

async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (e) {
    logger.log('wake_lock_error', snap(), heading, e.message);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    logger.log('app_hidden', snap(), heading);
    logger.flush();
  } else {
    logger.log('app_visible', snap(), heading);
    if (isNavigating()) keepAwake(true);
  }
});
window.addEventListener('pagehide', () => logger.flush());

// ------------------------------------------------------------------ physical controls
//
// While worn, the screen faces the user's chest, so everything is done with buttons he can find
// by touch. Browsers do not pass the phone's volume keys to web pages, so the controls are:
//   Headset play/pause, remote button (Enter), Space   start · continue · repeat
//   Headset next track, W, ArrowDown                   "where am I?"
//   Headset previous track, Esc                        stop navigation
// Volume keys are handled too in the rare browser that passes them on.

/** A silent looping track keeps a media session, so the headset buttons reach the page. */
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const audio = new Audio(silentWavUrl(10));
  audio.loop = true;
  audio.play().catch((e) => logger.log('media_session_error', null, heading, e.message));
  try { navigator.mediaSession.metadata = new MediaMetadata({ title: 'E3 Navigator', artist: 'Navigation guidance' }); } catch { /* old browser */ }
  const handle = (action, fn) => {
    try {
      navigator.mediaSession.setActionHandler(action, () => {
        logger.log('headset_button', snap(), heading, `action=${action}`);
        fn();
      });
    } catch { /* action not supported */ }
  };
  handle('play', primaryAction);
  handle('pause', primaryAction);
  handle('nexttrack', statusAction);
  handle('previoustrack', stopNavigation);
  handle('stop', stopNavigation);
  navigator.mediaSession.playbackState = 'playing';
}

function silentWavUrl(seconds) {
  const rate = 8000;
  const n = rate * seconds;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128); // 8-bit PCM silence
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

let statusHoldTimer = null;
let statusHoldFired = false;

function keyRole(e) {
  switch (e.key) {
    case 'Enter': case ' ': case 'MediaPlayPause': case 'MediaPlay': case 'MediaPause': case 'AudioVolumeUp':
      return 'main';
    case 'AudioVolumeDown': case 'ArrowDown': case 'w': case 'W': return 'status';
    case 'Escape': case 'MediaStop': return 'stop';
    default: return null;
  }
}

window.addEventListener('keydown', (e) => {
  if (toolsOpen()) {
    if (e.key === 'Escape') openTools(false);
    return;
  }
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
  if (t instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) return; // the button handles it
  if (simMode && simKey(e)) { e.preventDefault(); return; }
  const role = keyRole(e);
  if (!role) return;
  e.preventDefault();
  if (e.repeat) return;
  if (role === 'main') primaryAction();
  else if (role === 'stop') stopNavigation();
  else {
    // Tap = where am I; hold 2 s = stop (as volume down on the Android app)
    statusHoldFired = false;
    clearTimeout(statusHoldTimer);
    statusHoldTimer = setTimeout(() => { statusHoldFired = true; stopNavigation(); }, 2000);
  }
});

window.addEventListener('keyup', (e) => {
  if (keyRole(e) !== 'status' || statusHoldTimer == null) return;
  clearTimeout(statusHoldTimer);
  statusHoldTimer = null;
  if (!statusHoldFired) statusAction();
});

/**
 * During navigation every touch is swallowed. Testers unlock by holding a finger on the screen
 * for 3 s; a double-tap is the main button (optional, for phones with no headset or remote).
 */
function setupTouchShield() {
  const shield = $('touchShield');
  let unlockTimer = null;
  let lastTap = 0;
  shield.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    clearTimeout(unlockTimer);
    unlockTimer = setTimeout(() => {
      shieldUnlocked = true;
      toast('Screen unlocked for testing');
      logger.log('screen_unlocked', snap(), heading);
      updateUi(true);
    }, 3000);
  });
  const release = () => { clearTimeout(unlockTimer); };
  shield.addEventListener('pointerup', () => {
    release();
    const now = performance.now();
    if (settings.doubleTapControl && now - lastTap < 400) {
      lastTap = 0;
      logger.log('double_tap', snap(), heading);
      primaryAction();
    } else {
      lastTap = now;
    }
  });
  shield.addEventListener('pointercancel', release);
  shield.addEventListener('contextmenu', (ev) => ev.preventDefault());
}

// ------------------------------------------------------------------ simulator (laptop testing)

const sim = { heading: 0, target: 0, timer: null, walkTimer: null, last: 0 };

function setSimMode(on) {
  simMode = on;
  $('simCheck').checked = on;
  $('simPad').hidden = !on;
  clearInterval(sim.timer);
  sim.timer = null;
  if (!on) {
    setSimWalk(false);
  } else {
    sim.last = performance.now();
    // Feed a smooth simulated heading at 20 Hz, so turns go through the real TurnDetector.
    sim.timer = setInterval(() => {
      const now = performance.now();
      const maxStep = (150 * (now - sim.last)) / 1000; // 150°/s
      sim.last = now;
      const d = angleDiff(sim.target, sim.heading);
      sim.heading = normaliseDeg(sim.heading + Math.max(-maxStep, Math.min(maxStep, d)));
      onHeading(now, sim.heading);
    }, 50);
  }
  updateUi(true);
}

function setSimWalk(on) {
  clearInterval(sim.walkTimer);
  sim.walkTimer = on ? setInterval(() => onStep(performance.now(), null, 'SIM'), 550) : null;
  $('simWalkButton').classList.toggle('on', on);
  $('simWalkButton').textContent = on ? 'Stop walking' : 'Walk';
}

function simTurn(delta) {
  sim.target = normaliseDeg(sim.target + delta);
  logger.log('sim_turn', snap(), heading, `delta=${delta}`);
}

/** Shows a sign to the "camera": two readings 300 ms apart, like two OCR frames. */
function simSign(text) {
  if (!text) return;
  logger.log('sim_sign', snap(), heading, `text=${text}`);
  onText([{ text, heightFraction: 0 }], text, 0);
  setTimeout(() => onText([{ text, heightFraction: 0 }], text, 0), 300);
  toast(`Camera reads "${text}"`);
}

function simAction(name) {
  switch (name) {
    case 'step': onStep(performance.now(), null, 'SIM'); break;
    case 'walk': setSimWalk(sim.walkTimer == null); break;
    case 'left': simTurn(-90); break;
    case 'right': simTurn(90); break;
    case 'around': simTurn(180); break;
  }
}

function simKey(e) {
  if (e.repeat && e.key !== 'ArrowUp') return false;
  switch (e.key) {
    case 'ArrowUp': simAction('step'); return true;
    case 'g': case 'G': simAction('walk'); return true;
    case 'ArrowLeft': simAction('left'); return true;
    case 'ArrowRight': simAction('right'); return true;
    case 't': case 'T': simAction('around'); return true;
    default: {
      const n = Number(e.key);
      const opts = $('simSign').options;
      if (Number.isInteger(n) && n >= 1 && n < opts.length) { simSign(opts[n].value); return true; }
      return false;
    }
  }
}

function fillSimSigns() {
  const sel = $('simSign');
  sel.length = 1;
  const texts = [...new Set(route.segments.flatMap((s) => s.landmarks.map((l) => l.text)))];
  texts.forEach((t, i) => sel.add(new Option(`${i + 1}: ${t}`, t)));
}

// ------------------------------------------------------------------ testing tools

/** Raw sensor CSV: walk 30 counted steps between start and stop, then compare the counts. */
const diagnostics = {
  running: false,
  rows: [],
  steps: 0,
  heading: null,
  report: '',
  sample(r) {
    if (!this.running) return;
    if (r.step) this.steps++;
    const mag = Math.hypot(r.ax, r.ay, r.az) - 9.80665;
    this.rows.push(`${Math.round(r.t)},${fmt(r.ax, 3)},${fmt(r.ay, 3)},${fmt(r.az, 3)},${fmt(mag, 3)},${fmt(r.filtered, 3)},${r.step ? 1 : 0},${this.heading != null ? fmt(this.heading, 1) : ''}`);
  },
};

function preflight() {
  return [
    `secure context (https/localhost)  ${window.isSecureContext}`,
    `DeviceMotionEvent                 ${'DeviceMotionEvent' in window}`,
    `motion samples so far             ${motion?.motionSamples ?? 0} (${fmt(motion?.motionHz ?? 0, 0)} Hz)`,
    `heading source                    ${motion?.headingSource ?? 'not started'} (${motion?.headingSamples ?? 0} samples)`,
    `${permissionReport || 'motion permission: not requested yet'}`,
    `camera / OCR                      ${scanner?.engineName ?? 'not started'} (${cameraStatus})`,
    `speech voice                      ${speaker.voice ? `${speaker.voice.name} (${speaker.voice.lang})` : speaker.available ? 'default' : 'none'}`,
    `vibration                         ${haptics.available}`,
    `screen wake lock                  ${'wakeLock' in navigator}`,
  ].join('\n');
}

function toggleDiagnostics() {
  if (!armed) { toast('Tap the start screen first to turn the sensors on.'); return; }
  if (!diagnostics.running) {
    diagnostics.running = true;
    diagnostics.rows = [];
    diagnostics.steps = 0;
    diagnostics.report = preflight();
    $('diagButton').textContent = 'Stop sensor diagnostic';
    $('diagButton').classList.add('active');
    logger.log('diag_start', snap(), heading, diagnostics.report.replace(/\n/g, '; '));
    speaker.speak('Sensor diagnostic started. Walk exactly 30 steps, then tap stop.');
  } else {
    diagnostics.running = false;
    $('diagButton').textContent = 'Sensor diagnostic';
    $('diagButton').classList.remove('active');
    const result = `accel steps=${diagnostics.steps} samples=${diagnostics.rows.length}`;
    const name = `sensors_${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}.csv`;
    logger.log('diag_stop', snap(), heading, `${result} file=${name}`);
    speaker.speak(`Sensor diagnostic stopped. The step detector counted ${diagnostics.steps} steps.`);
    const csv = `${diagnostics.report.split('\n').map((l) => `# ${l}`).join('\n')}\n# ${result}\n` +
      `t_ms,ax,ay,az,mag_minus_g,filtered,step,heading_deg\n${diagnostics.rows.join('\n')}\n`;
    diagnostics.report = `Last run: ${result}\n${name}`;
    shareOrDownload(name, csv);
  }
  updateUi(true);
}

function toggleCalibration() {
  const d = Number($('calibDistance').value) || 10;
  if (!calibrating) {
    calibrating = true;
    calibSteps = 0;
    calibAmplitudes.length = 0;
    $('calibButton').textContent = 'Stop';
    $('calibButton').classList.add('active');
    speaker.speak(`Walk exactly ${fmt(d, 0)} metres at your normal pace, then tap stop.`);
    logger.log('calib_start', null, heading, `distance=${d}`);
    return;
  }
  calibrating = false;
  $('calibButton').textContent = 'Calibrate step';
  $('calibButton').classList.remove('active');
  if (calibSteps < 5) {
    speaker.speak(`Only ${calibSteps} steps detected. Calibration not saved.`);
    return;
  }
  const len = d / calibSteps;
  settings.stepLengthM = len;
  stepModel.fixedM = len;
  const k = StepLengthModel.calibrateK(d, calibAmplitudes);
  if (k != null) { settings.weinbergK = k; stepModel.k = k; }
  settings.save();
  logger.log('calib_adaptive', null, heading, `k=${k != null ? fmt(k, 4) : 'not enough bounce data'}`);
  $('stepLength').value = fmt(len, 3);
  if (engine) engine.config = currentConfig();
  speaker.speak(`Step length ${fmt(len, 2)} metres from ${calibSteps} steps.` +
    (k != null ? ' Adaptive step length calibrated.' : ' Not enough movement data for adaptive steps; using a fixed length.'));
  logger.log('calib_done', null, heading, `distance=${d} steps=${calibSteps} stepLength=${fmt(len, 3)}`);
}

function calibratePlate() {
  const d = Number($('plateDistance').value);
  if (!d || lastMatchHeight <= 0) {
    toast('Point the camera at a route plate first');
    return;
  }
  const calib = d * lastMatchHeight;
  settings.plateSizeCalib = calib;
  settings.save();
  $('plateCalib').value = fmt(calib, 4);
  if (engine) engine.config = currentConfig();
  logger.log('plate_calib', snap(), heading, `plate=${lastMatchText} distance=${d} height=${fmt(lastMatchHeight, 4)} calib=${fmt(calib, 4)}`);
  toast(`Plate calibration = ${fmt(calib, 4)}`);
}

function surveyMark() {
  const detail = `counterSteps=${counterSteps} distance_est=${fmt(counterDistanceM, 2)} accel=${accelStepsSeen} lastOcr=${lastOcrText}`;
  logger.log('survey_mark', snap(), heading, detail);
  logger.flush();
  toast(`Marked at ${counterSteps} steps`);
}

function fillSettingsFields() {
  $('stepLength').value = fmt(settings.stepLengthM, 3);
  $('sightingDistance').value = fmt(settings.sightingDistanceM, 2);
  $('plateCalib').value = fmt(settings.plateSizeCalib, 4);
  $('maxSigma').value = fmt(settings.maxSigmaM, 2);
  $('drift').value = fmt(settings.driftFraction, 3);
  $('speechRate').value = fmt(settings.speechRate, 1);
  $('ocrEngine').value = settings.ocrEngine;
  $('dimCheck').checked = settings.dimWhileNavigating;
  $('doubleTapCheck').checked = settings.doubleTapControl;
  $('adaptiveStepCheck').checked = settings.adaptiveSteps;
}

function saveSettings() {
  const num = (id) => { const v = Number($(id).value); return $(id).value !== '' && Number.isFinite(v) ? v : null; };
  settings.stepLengthM = num('stepLength') ?? settings.stepLengthM;
  settings.sightingDistanceM = num('sightingDistance') ?? settings.sightingDistanceM;
  settings.plateSizeCalib = num('plateCalib') ?? settings.plateSizeCalib;
  settings.maxSigmaM = num('maxSigma') ?? settings.maxSigmaM;
  settings.driftFraction = num('drift') ?? settings.driftFraction;
  settings.speechRate = Math.min(2, Math.max(0.5, num('speechRate') ?? settings.speechRate));
  const ocrChanged = settings.ocrEngine !== $('ocrEngine').value;
  settings.ocrEngine = $('ocrEngine').value;
  settings.dimWhileNavigating = $('dimCheck').checked;
  settings.doubleTapControl = $('doubleTapCheck').checked;
  settings.adaptiveSteps = $('adaptiveStepCheck').checked;
  settings.save();
  speaker.rate = settings.speechRate;
  stepModel.fixedM = settings.stepLengthM;
  stepModel.adaptive = settings.adaptiveSteps;
  if (engine) engine.config = currentConfig();
  logger.log('settings_saved', snap(), heading, JSON.stringify(settings).replace(/,/g, ';'));
  toast(ocrChanged && armed ? 'Saved. Reload the page to switch the OCR engine.' : 'Saved');
  updateUi(true);
}

function fillLogList() {
  const sel = $('logSelect');
  const names = NavLogger.list().slice().reverse();
  sel.length = 0;
  for (const n of names) sel.add(new Option(n === logger.name ? `${n} (current)` : n, n));
  if (!names.length) sel.add(new Option('No logs yet', ''));
}

async function loadRouteFile(file) {
  if (isNavigating()) { toast('Stop navigation before changing the route.'); return; }
  try {
    const text = await file.text();
    RouteLoader.setOverride(file.name, text);
    await loadRoute();
    logger.log('route_loaded', null, heading, `file=${file.name}`);
    toast(`Route loaded from ${file.name}`);
  } catch (e) {
    toast(`Route file not used: ${e.message}`);
  }
  updateUi(true);
}

function openTools(open) {
  $('toolsPanel').hidden = !open;
  if (open) fillLogList();
  updateUi(true);
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3000);
}

function bindViews() {
  const on = (id, fn, ev = 'click') => $(id).addEventListener(ev, fn);
  on('startOverlay', (e) => { if (e.target === $('overlayToolsButton')) return; primaryAction(); });
  on('startOverlay', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); primaryAction(); } }, 'keydown');
  on('overlayToolsButton', () => openTools(true));
  on('toolsButton', () => openTools(true));
  on('closeToolsButton', () => openTools(false));
  on('stopButton', stopNavigation);
  on('continueButton', () => { engine?.continueAfterArrival(); updateUi(true); });
  on('repeatButton', () => {
    if (!armed) arm();
    else if (engine?.state === NavState.IDLE) speaker.speak('Press start to begin navigation.');
    else engine?.repeatInstruction();
  });
  on('overviewButton', () => { map.overview = !map.overview; });
  on('calibButton', toggleCalibration);
  on('plateCalibButton', calibratePlate);
  on('markButton', surveyMark);
  on('resetStepsButton', () => {
    counterSteps = 0; counterDistanceM = 0; accelStepsSeen = 0;
    logger.log('counter_reset', snap(), heading);
    updateUi(true);
  });
  on('shareButton', () => { logger.flush(); shareOrDownload(logger.name, logger.text); });
  on('downloadLogButton', () => {
    const n = $('logSelect').value;
    if (!n) return;
    if (n === logger.name) logger.flush();
    shareOrDownload(n, NavLogger.read(n));
  });
  on('diagButton', toggleDiagnostics);
  on('saveButton', saveSettings);
  on('routeFile', (e) => { const f = e.target.files?.[0]; if (f) loadRouteFile(f); e.target.value = ''; }, 'change');
  on('builtInRouteButton', async () => {
    if (isNavigating()) { toast('Stop navigation before changing the route.'); return; }
    RouteLoader.clearOverride();
    await loadRoute();
    toast('Using the built-in route');
    updateUi(true);
  });
  on('simCheck', (e) => setSimMode(e.target.checked), 'change');
  $('simPad').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sim]');
    if (b) simAction(b.dataset.sim);
  });
  on('simSign', (e) => { simSign(e.target.value); e.target.value = ''; }, 'change');
  setupTouchShield();
}

// ------------------------------------------------------------------ UI

function updateOverlay() {
  $('startTitle').innerHTML = armed ? 'Tap anywhere<br>to start' : 'Tap anywhere<br>to begin';
  $('startHelp').textContent = armed ? HELP_ARMED : HELP_UNARMED;
  $('startOverlay').setAttribute('aria-label', armed ? 'Start navigation' : 'Turn on camera, sensors and speech');
}

function updateUi(force = false) {
  const now = performance.now();
  if (!force && now - lastUiUpdate < 200) return;
  lastUiUpdate = now;
  const e = engine;
  const s = snap();
  const navigating = isNavigating();
  $('startOverlay').hidden = navigating || toolsOpen() || !e;
  const shield = $('touchShield');
  shield.hidden = !(navigating && !shieldUnlocked && !toolsOpen() && !simMode);
  shield.classList.toggle('dim', settings.dimWhileNavigating);
  $('stopButton').hidden = !navigating;
  $('continueButton').hidden = e?.state !== NavState.AWAITING_CONTINUE;
  $('app').classList.toggle('awaiting-continue', e?.state === NavState.AWAITING_CONTINUE);
  if (e && route && s) {
    map.update(s);
    updateBanner(route, s);
  }
  if (toolsOpen()) $('debugText').textContent = debugText(s, now);
}

function debugText(s, now) {
  const lines = [];
  if (s) {
    lines.push(`State    ${s.state}${s.offCourse ? ' (OFF COURSE)' : ''}${s.turnPending ? ' (turn pending)' : ''}${s.awaitingStartTurn ? ' (awaiting start turn)' : ''}`);
    lines.push(`Segment  ${s.segmentIndex + 1}: ${s.segmentFrom} -> ${s.segmentTo}`);
    lines.push(`Position ${fmt(s.positionM, 1)} / ${fmt(s.segmentLengthM, 1)} m   ±${fmt(s.sigmaM, 2)} m  ${s.confidence}`);
    lines.push(`Net turn ${fmt(s.netTurnDeg, 0)}°   Last landmark ${s.lastLandmark ?? '-'}`);
  }
  const sinceStep = lastStepMs === 0 ? 'never' : `${Math.floor((now - lastStepMs) / 1000)}s ago`;
  lines.push(`Steps    counter=${counterSteps}  accel=${accelStepsSeen}  using=${simMode ? 'SIMULATOR' : 'ACCEL'}  last=${sinceStep}`);
  lines.push(`Distance ${fmt(counterDistanceM, 1)} m  last step ${fmt(lastStepLengthM, 2)} m  ` +
    (stepModel.isAdaptiveActive ? `adaptive (K=${fmt(stepModel.k, 3)})` : `fixed ${fmt(settings.stepLengthM, 3)} m`) +
    (calibrating ? `  CALIBRATING (${calibSteps})` : ''));
  lines.push(`Motion   ${motion ? `${motion.motionSamples} samples, ${fmt(motion.motionHz, 0)} Hz` : 'not started (tap the start screen)'}`);
  lines.push(`Heading  ${heading != null ? `${fmt(heading, 0)}°` : '-'} (${simMode ? 'simulator' : motion?.headingSource ?? '-'})`);
  const ocrAge = lastOcrMs === 0 ? '-' : `${Math.floor((now - lastOcrMs) / 1000)}s ago`;
  lines.push(`OCR      ${scanner ? `${scanner.engineName}, ${cameraStatus}` : 'not started'}${scanner?.avgCycleMs ? `, ${Math.round(scanner.avgCycleMs)} ms/frame` : ''}`);
  lines.push(`Read     ${lastOcrText.slice(0, 60)} (${ocrAge})`);
  if (lastMatchText) lines.push(`Plate    ${lastMatchText}  h=${fmt(lastMatchHeight, 4)}`);
  lines.push(`Confirm  2 readings within ${currentConfig().landmarkWindowMs} ms`);
  if (diagnostics.running) lines.push(`Diag     RUNNING steps=${diagnostics.steps} samples=${diagnostics.rows.length}`);
  if (diagnostics.report) lines.push(diagnostics.report);
  return lines.join('\n');
}

/** Instruction banner + bottom ETA bar, from the same guidance the voice uses. */
function updateBanner(r, s) {
  const g = buildGuidance(r, s, currentConfig().arrivalToleranceM);
  $('maneuverIcon').innerHTML = maneuverSvg(g.maneuver);
  const dist = $('distanceText');
  dist.hidden = g.distanceM == null;
  dist.textContent = g.distanceM != null ? distanceLabel(g.distanceM) : '';
  $('titleText').textContent = g.title;
  const sub = $('subtitleText');
  sub.textContent = g.subtitle ?? '';
  sub.hidden = !g.subtitle;
  const banner = $('banner');
  banner.classList.toggle('warning', g.warning);
  banner.setAttribute('aria-label', [g.distanceM != null ? `In ${distanceLabel(g.distanceM)}` : null, g.title, g.subtitle].filter(Boolean).join('. '));
  $('thenChip').hidden = !(g.then != null && !g.warning);
  if (g.then != null) $('thenIcon').innerHTML = maneuverSvg(g.then);

  if (s.state === NavState.IDLE || s.state === NavState.FINISHED) {
    $('etaText').textContent = minutesLabel(r.totalLengthM);
    $('etaDetail').textContent = `${Math.trunc(r.totalLengthM)} m · ${r.name}`;
  } else {
    $('etaText').textContent = minutesLabel(g.remainingToDestinationM);
    const at = new Date(Date.now() + (g.remainingToDestinationM / WALK_SPEED_MPS) * 1000);
    const hhmm = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    $('etaDetail').textContent = `${Math.trunc(g.remainingToDestinationM)} m · ${hhmm}\nto ${g.destination}`;
  }
}

/** Live distance walked (sum of estimated step lengths); stays on screen after the run ends. */
function updateWalked() {
  $('walkedBox').hidden = false;
  $('walkedText').textContent = `${fmt(walkedM, 1)} m`;
  $('walkedDetail').textContent = `walked · ${walkedSteps} ${walkedSteps === 1 ? 'step' : 'steps'}`;
}

const distanceLabel = (m) => (m < 1.5 ? 'Now' : `${Math.trunc(m)} m`);
const minutesLabel = (m) => `${Math.max(1, Math.ceil(m / WALK_SPEED_MPS / 60))} min`;

init();
