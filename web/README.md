# E3 Navigator: browser version

The same hybrid visual-inertial navigator as the Android app (route **Cheers → E3-06-02 → male toilet → back to E3-06-02**), running in a phone's web browser. There's nothing to install on the phone and no Android Studio needed.

The navigation logic (`NavigationEngine`, turn and step detectors, landmark matcher, guidance) is a line-by-line JavaScript port of the Kotlin `core/` package, with the same thresholds, wording and unit tests. The browser layer replaces the Android APIs: motion sensors, camera with on-device OCR, speech, vibration and logging.

Requirements: **Node.js 20+** on the laptop (only to serve the files and run the tests; there are no npm packages to install).

---

## 1. Run it on a laptop (simulator)

```bash
cd web
npm start
```

Open **http://localhost:8080/?sim** in Chrome or Edge. Click once to turn on speech (browsers need a click first), then click again to start navigating.

A laptop has no motion sensors, so the app switches to the **simulator** (the button row under the banner):

| Key | Simulates |
|---|---|
| ↑ | one step (hold to walk) |
| G | walk automatically (1.8 steps/s) |
| ← / → | turn left / right (goes through the real turn detector, so it takes ~1 s) |
| T | turn around |
| 1–9 | the camera reads route sign *n* (listed in the **Sign…** menu) |
| Space / Enter | main button: start · continue · repeat |
| W or ↓ | "Where am I?" (hold 2 s = stop) |
| Esc | stop navigation (closes the testing tools when they are open) |

**A full walk of the built-in route:** ↑ ×27 → ← → 1 (reads E3-06-02, arrives) → Space → → → ↑ ×78 → 2 (EXIT sign) → ↑ ×6 → ← → ↑ ×24 (toilet) → Space → T → ↑ ×24 → → → ↑ ×71 → → → 1 (navigation complete).

## 2. Run it on a phone

Phones only allow the camera and motion sensors on **https://** pages. For testing over Wi-Fi:

```bash
cd web
npm run start:https
```

It prints an address like `https://192.168.1.23:8443`. With the phone on the **same Wi-Fi**, open that address in **Chrome** (Android) or **Safari** (iPhone):

1. The phone warns that the connection is not private (the certificate is self-signed): tap **Advanced → Proceed**. You only do this once.
2. Windows may ask to let Node through the firewall: allow it on **private networks**.
3. Tap once to begin, allow the **camera** (and **motion** on iPhone), then tap again to start.
4. Optional: Chrome menu → **Add to Home screen** opens it full-screen like an app.

The certificate is created in `web/.cert/` (git-ignored, never served) and remade automatically if the laptop's IP changes.

Campus Wi-Fi often blocks phone-to-laptop connections. If the phone can't reach the laptop, use a phone hotspot, or use the hosted version below.

### Hosted on Render

`render.yaml` (repo root) publishes `web/` as a free Render **static site**. There's no database or server code, so nothing else needs setting up. Render provides HTTPS, so phones can use the camera and sensors.

- **First time:** Render dashboard → **New → Blueprint** → pick this GitHub repo → **Apply**.
- **After that:** every push to `main` that changes `web/` redeploys automatically (Android-only changes are skipped).

## 3. Unit tests

```bash
cd web
npm test
```

52 tests: the 24 simulated walks from `NavigationEngineTest.kt` (full route, false turns, wrong turns, missed landmarks, lost and relocalised) plus the detector, step-length, landmark-matcher and guidance tests. The 3 `StepFusionTest` cases are not ported because browsers have no hardware step detector.

---

## 4. Controls (what differs from the Android app)

Browsers do **not** pass the phone's volume keys to web pages, so the controls are:

| Control | Action |
|---|---|
| **Headset play/pause** (Bluetooth bone-conduction headset), a **remote that sends Enter**, or Space | Start · continue after a waypoint · repeat the instruction |
| **Headset next track**, W, ↓ | "Where am I?" |
| **Headset previous track**, Esc, or hold ↓ for 2 s | Stop |
| **Double-tap** the locked screen | Same as the main button (for phones with no headset or remote; can be turned off in Settings) |
| Hold a finger on the locked screen for 3 s | Unlock for a sighted tester |

Headset buttons work through the Media Session API: the app plays a silent audio track to hold the media session. **Check this on your phone and headset first**. Cheap Bluetooth camera-shutter remotes usually have an "Android" button that sends Enter; their "iOS" button sends volume-up, which browsers ignore.

## 5. What changed from the Android version

| Android | Browser |
|---|---|
| Hardware step detector + accelerometer detector, auto-switching (`StepFusion`) | Accelerometer detector only (`devicemotion`), same algorithm and thresholds |
| Game rotation vector | `RelativeOrientationSensor` (Chrome), else `deviceorientation`; same camera-direction heading |
| CameraX + ML Kit OCR (~4 frames/s) | `getUserMedia` + the browser's `TextDetector` if present, else **Tesseract.js** (on-device WebAssembly, about **1–2 s per frame**) |
| 2 OCR readings within 1.5 s confirm a sign | Same, but the window widens to 2.5 OCR frames when OCR is slower (shown in the debug panel) |
| TextToSpeech, raises media volume to 30% | Web Speech API; **set the phone's media volume yourself** (web pages can't change it) |
| Vibration | `navigator.vibrate` (Android Chrome only; iPhones don't vibrate from web pages) |
| Screen brightness to 2% | Black overlay, plus a screen wake lock so the phone doesn't sleep |
| CSV logs in `Android/data/…/logs`, Share log | Same CSV columns, kept in browser storage (last 15 runs); **Share current log** or **Download** in the testing tools |
| `route.json` copied over USB overrides the route | **Load route.json** in the testing tools (kept in the browser); **Use built-in route** to go back |
| "Press volume up to continue" | "Press the button when you are ready to continue" |

Everything else is unchanged: calibration (step length + adaptive Weinberg model), plate-size calibration, survey marks, sensor diagnostic (raw `devicemotion` CSV), the Maps-style screen, the confidence levels and all spoken cues. The route file format is identical: `web/routes/e3_route.json` is a copy of the Android asset, and the main README's survey instructions (§4) apply to it.

**Faster OCR on Android:** Chrome's built-in `TextDetector` uses the phone's own text recogniser. It's behind a flag: `chrome://flags` → **Experimental Web Platform features** → Enabled. The app uses it automatically when present (Testing tools → OCR line shows which engine is active).

## 6. Files

```
web/
  index.html, css/app.css      the screen (banner, map, buttons, testing tools)
  js/core/                     pure logic, unit-tested in Node (port of the Kotlin core/)
    route.js                   route model + JSON parsing/validation
    config.js                  EVERY tunable number (NavConfig)
    engine.js                  NavigationEngine: position estimate, state machine, fail-safe
    detectors.js               accelerometer step detector, turn detector, step-length model
    landmark.js                OCR text → landmark matching, 2-reading confirmation
    guidance.js                banner content + route geometry for the map
  js/sensing/                  devicemotion/orientation (motion.js), camera + OCR (camera.js)
  js/feedback.js               speech + vibration
  js/data/                     settings, route loading, CSV logger
  js/ui/                       map canvas, manoeuvre icons
  js/app.js                    wiring + controls + simulator + testing tools (MainActivity)
  routes/e3_route.json         the route (placeholder lengths: survey before route tests)
  server.mjs, devcert.mjs      local dev server, optional self-signed HTTPS
  test/                        node:test unit tests
```

## 7. Known limitations

- **Not yet run on a real phone.** The logic is unit-tested and the whole route has been walked in the simulator, but sensors, camera OCR, speech and headset buttons need their first on-device test. Check the debug panel first (Testing tools): motion samples should arrive at ~50–60 Hz, the heading should change by ~90° for a quarter turn, and pointing the camera at a printed `E3-06-02` should show it under **Read**.
- **Tesseract is slower and weaker than ML Kit** on corridor scenes. In synthetic tests it read dark-on-light door plates ("Tutorial Room / E3-06-02") reliably at several sizes, but **not the white-on-green EXIT sign**, even with the image inverted. If that holds on real frames, the long corridor gets no EXIT fix and its turn cue stays in the vague "coming up soon" form. Navigation still works, just less precisely. Try `TextDetector` (above) on Android, or pick dark-on-light signs as landmarks.
- The first visit needs internet to download Tesseract (a few MB, then cached by the browser). Speech uses the phone's voices; an on-device English voice works offline.
- The page must stay open in the foreground with the screen on. Browsers pause sensors and the camera in the background.
- Same limitations as the Android version: placeholder route lengths, pictogram-only signs can't be read, no lateral (sideways) tracking.
