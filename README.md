# E3 Navigator: IE3105 G03 Concept C prototype

A native Android app (Kotlin) for hybrid visual-inertial navigation along the predefined E3 route:
**Cheers → E3-06-02 → male toilet → back to Cheers**.

- **Motion sensors** count steps and detect turns between landmarks (dead reckoning).
- **Camera + on-device OCR** reads existing room plates and corrects the accumulated error.
- **Spoken cues and vibration** give the next instruction, through any Bluetooth (bone-conduction) headset.
- **Fail-safe:** when position uncertainty exceeds a limit, directions stop and the user is told localisation is lost, until a plate is recognised again.

Everything runs offline on the phone. Camera frames are processed in memory and never stored.

> 🌐 **Browser version:** the same navigator also runs in a phone's web browser, with no install and a laptop simulator for testing. Live at **https://e3-navigator.onrender.com** ([simulator](https://e3-navigator.onrender.com/?sim)). See [`web/README.md`](web/README.md).

> ⚠️ **The route distances and landmarks in `app/src/main/assets/routes/e3_route.json` are placeholders** (20 m → right turn → 12 m → E3-06-02 → 15 m → toilet). Replace them with your survey (Step 4 below) before any route test.

---

## 1. Build and install (about 30 minutes the first time)

You need a Windows/Mac laptop, an Android phone (Android 8.0+) and a USB **data** cable.

1. Install **Android Studio** (developer.android.com/studio). Accept the default SDK components.
2. Unzip this folder. In Android Studio choose **File → Open** and select the `E3Navigator` folder (the one containing `settings.gradle.kts`).
3. Wait for **Gradle sync** to finish (bottom status bar; the first sync downloads several hundred MB). If Android Studio offers to **upgrade the Android Gradle Plugin**, accept it.
4. On the phone: **Settings → About phone → tap Build number 7 times**, then **Developer options → USB debugging = on** (menu names vary by brand). Plug in and accept the "Allow USB debugging" prompt.
5. Select the phone in Android Studio's device dropdown and press the green **Run ▶** button.
6. On first launch, allow **Camera** and **Physical activity** permissions.

**Run the logic tests:** in the Project panel, right-click `app/src/test/java` → **Run 'Tests in java'**. There are 28 tests, including simulated full-route walks, false turns, wrong turns, missed landmarks, and lost-then-relocalised cases. They run on the laptop and need no phone.

---

## 2. First check: do the sensors work on *your* phone?

Open the app and scroll to the grey debug panel (under the camera preview):

| Line | What to check |
|---|---|
| `Steps counter=… hw=… accel=… using=… last=…` | Walk 10 steps. `counter` should rise by ~10 and `last` read "0s ago". `hw` (Android step detector) and `accel` (app's detector) show what each saw; `using` is the one navigation trusts. If it goes quiet while the other keeps counting, the app switches automatically. |
| `Heading` | Turn on the spot. The value should change by ~90° for a quarter turn. |
| `OCR` | Point the camera at a printed `E3-06-02`. The text should appear within a second. |

The **hw/accel side-by-side counts** are deliberate: the app logs both on every walk, so you can report which detector is more accurate for your Section 7 validation.

**If steps or distance stay at zero:** tap **Sensor diagnostic**, walk exactly 30 counted steps, and tap it again. It logs every raw step-detector, step-counter and rotation-vector event to `logs/sensors_*.csv` (a pre-flight sensor/permission check is at the top) and opens the share sheet.

| CSV shows | Meaning |
|---|---|
| No `STEP_DETECTOR` rows | Sensor missing or Physical activity permission refused; the app falls back to its accelerometer detector |
| Rows arrive in late bursts | Batching by the phone's firmware |
| `detector` ≈ 30 | Sensors are fine; check the step length in Settings |
| `detector` well below 30 | The detector misses this gait (try slower, and with the cane); compare with `accel` in the debug panel |

## 3. Calibrate step length (per tester, chest-mounted)

1. Mark a measured 10 m (or 20 m) on the floor; type the distance into *Measured walk (m)*.
2. Wear the phone in the chest harness, tap **Calibrate step**, walk the distance, tap **Stop**.
3. The step length is saved and shown in Settings. Repeat 3× and use the average if the results vary.

**Adaptive step length:** the same calibration walk also calibrates the adaptive model (Weinberg, L = K·bounce^¼). Each step's length then comes from how hard it bounces, so short shuffling steps in a crowd count as short. It's on by default once calibrated; turn it off under Settings to compare. The `step` rows in the log record each step's length and bounce for your accuracy analysis: do 10 measured walks with it on and 10 with it off, normal and stop-start.

## 4. Survey the route (fills in `e3_route.json`)

1. Stand at Cheers with the phone on the chest harness. Tap **Reset counter**.
2. Walk the route. At every junction, every plate you want as a landmark, and every waypoint, stop and tap **Survey mark**. Each mark logs step count, estimated distance, heading and the last OCR text.
3. Tap **Share log** and send the CSV to yourself. Filter `event = survey_mark`. The differences in `distance_est` give segment lengths and landmark positions. Cross-check with a measuring tape or wheel for the report.
4. Edit `app/src/main/assets/routes/e3_route.json`:
   - one **segment** per straight stretch; `endAction` is `TURN_LEFT`, `TURN_RIGHT`, `CONTINUE` or `ARRIVE`
   - `landmarks[].positionM` = distance from segment start to the point **beside** the plate
   - `text` = exactly what's printed; `confirmsArrival: true` on the destination plate
   - `announce` (optional) = what to say when passing it ("Passing E3-06-01"), which covers the "inform the user which tutorial room they are between" requirement
   - the return leg uses `"startTurn": "AROUND"`
   - `arrivalSide` (`LEFT`/`RIGHT`) on an ARRIVE segment: the app says "on your left" and, at the door, asks the user to **turn and face the door** so the camera can read the plate (E3 door plates sit in side recesses and can't be read while walking straight)
   - `sightingDistanceM` on a landmark: how far *before* the sign the user is when it's read. Use `0` for door plates read by facing the door, and ~4–6 for ceiling EXIT signs facing down the corridor
   - `maxSigmaM` on a segment: allows more uncertainty on a long corridor with no decision points before guidance stops (default 3 m)
   - a destination with no readable text (e.g. the pictogram-only toilet door) has no `confirmsArrival` landmark and is reached by step count

**Updating the route without rebuilding** (report §9.2.3): copy a `route.json` to the phone at `Android/data/com.example.e3navigator/files/route.json` over USB. It overrides the built-in file; delete it to go back.

## 5. Optional: calibrate plate range

By default the app assumes a plate is read from 2.5 m away (`Assumed sighting distance`). For better arrival accuracy: stand exactly 2.0 m from a route plate, point the camera at it until `Plate … h=` appears in the debug panel, then tap **Calibrate plate**. The app then estimates distance from the text's size in the image.

---

## 6. Using it (sighted tester first)

**The user never needs the screen.** Worn on the chest with the camera facing forward, the screen faces his body, so the app is driven entirely by buttons he can find by touch, and everything is spoken:

| Control | Action |
|---|---|
| **Volume up, tap** | Start · continue after a waypoint · repeat the current instruction |
| **Volume up, hold** | Louder |
| **Volume down, tap** | "Where am I?": destination, distance left, next manoeuvre |
| **Volume down, hold 2 s** | Stop navigation |
| **Headset play/pause button, or a Bluetooth camera-shutter remote** | Same as volume up, tap |

- When the app opens, it **speaks these controls**. Before the phone is strapped on, the **whole screen** is also a Start button and works with TalkBack.
- During navigation **all touches are ignored** (the lanyard or his chest can't press anything) and the screen is dimmed. A sighted tester can unlock it by holding a finger on the screen for 3 seconds.
- **Optional remote:** a Bluetooth camera-shutter remote (about S$5–10) clipped to the strap or cane handle gives an easy-to-find button. It sends "volume up", so it works with no setup.

**Test with real users:** ask a tester wearing a blindfold, *with a sighted team member walking alongside*, to start, check where they are, continue and stop, using only the buttons. Record how long each takes and any mistakes. That gives you usability evidence for the report.

**What he hears:**
- At a junction: *"Stop. Turn left now."* As soon as the turn is detected: *"Good. Now walk straight ahead."* Turning on the spot is easier to detect reliably than turning while walking through a crowd.
- **Distances are only exact when the app is confident** (uncertainty ±2 m or less). Otherwise it says *"The left turn is coming up soon. Slow down."* and, at the turn, *"Stop, and turn left when your cane finds the opening."* If a sign is read after a vague cue, the exact cue follows.
- On long stretches, every 15 m: *"Keep going straight. About 30 metres to the left turn."* Distances are rounded to 5 m when uncertain.

**Screen layout (Maps-style):**
- **Green banner (top):** the next manoeuvre arrow, the distance to it, and a "Then ↑" chip for the step after. The banner turns **red** when the app is lost or the user has turned off the corridor.
- **Map:** a schematic of the surveyed route, heading-up. The blue line is the leg to the next waypoint, the grey line is what you've already walked, and the red pins are waypoints. The light-blue halo around the arrow is the position uncertainty (±σ): it grows as you walk and shrinks when a sign is read.
- **Right-hand buttons:** 🔊 repeat the instruction, 🧭 toggle the whole-route overview, ⚙ testing tools (calibration, survey marks, settings, debug readout).
- **Bottom bar:** ✕ stop, ETA to the next waypoint at 0.9 m/s, and Start or Continue.
- **Bottom left:** a small camera preview.

The banner and the voice come from the same guidance logic (`core/Guidance.kt`, unit-tested), so what testers see is what the user hears.


- **START NAVIGATION** at Cheers, facing along the corridor.
- At each waypoint the app says "You have arrived…". Press **volume up** (or the CONTINUE button) to go on.
- **Volume up (short press)** at any other time repeats the current instruction. **Hold volume up** to make the speech louder; volume down works as normal.
- **Loudness:** speech plays at the phone's *media* volume. When navigation starts, the app raises media volume to 30% only if it's lower (so a muted phone still speaks) and otherwise leaves it alone; change this under Settings → "Minimum volume at start" (0 = never change it). Hold volume up to make it louder. With a Bluetooth headset, also check the headset's own volume. Measure the loudest cue at the ear and keep it within your 75 dB requirement (§5).
- **Safety:** run the first trials with sighted teammates checking every instruction (report §9.3). This is an unvalidated prototype and must not be relied on for independent navigation.

---

## 7. How it works (maps to report §8–9)

```
core/            pure Kotlin, no Android code, unit-tested
  RouteModel.kt        segments, end actions, landmarks
  NavConfig.kt         EVERY tunable number (thresholds, tolerances)
  StepDetector.kt      accelerometer peak detector (alternative to Android's)
  TurnDetector.kt      sustained heading change → turn event; ignores brief dodges
  LandmarkMatcher.kt   OCR text → landmark (O/D/0, I/1, S/5, G/6, T/7 … confusions handled; never fuzzy-matches E3-06-02 to E3-06-03)
  NavigationEngine.kt  position estimate + state machine + fail-safe
sensing/         Android sensors (F2): step detectors, game rotation vector heading, CameraX + ML Kit OCR
feedback/        TextToSpeech + vibration (F7)
data/            route JSON loader, settings, CSV logger, raw sensor diagnostic logger
MainActivity.kt  wiring + debug/testing UI
```

**Position estimate.** Position is the current segment plus the distance along it, with an uncertainty σ:
- each step: `s += step length`, `σ = σ_fix + 0.10 × distance since last fix`
- confirmed plate: 1-D Kalman update with σ_plate = 1.0 m. If the plate disagrees wildly with the step estimate, the camera wins.
- confirmed junction turn: σ is reset to ≤ 1.0 m (the junction itself is a position fix)
- `σ > 3.0 m` → **LOST**: directions stop, "Location uncertain, please stop", reminder every 8 steps, resume when a plate is confirmed

**Confidence levels** (report §7, safe localisation failure). Logged as `confidence` events on every change, and shown in the debug panel:

| Level | Condition (NavConfig) | What the user hears |
|---|---|---|
| HIGH | σ ≤ 2.0 m (`preciseCueMaxSigmaM`) | Exact distances: "In about 2 metres, turn left." / "Stop. Turn left now." |
| MEDIUM | 2.0 m < σ ≤ limit | No distances: "The left turn is coming up soon. Slow down." / "Turn left when your cane finds the opening." |
| LOW (LOST) | σ > `maxSigmaM` (3 m; 7 m on long featureless corridors) | No directions: "Location uncertain. Please stop…" until a sign is read |

The thresholds are placeholders until the drift tests in §8 are done; set them from the measured spread.

**Turn logic.** A rotation only changes the route segment if it is (1) within 4 m + σ of the expected junction, (2) in the expected direction (±45°), and (3) followed by 3 steps without being undone. A rotation ≥ 60° *away* from a junction triggers "You may have turned off the corridor" (e.g. into a seminar-room entrance). Steps still count while off course, and after 6 steps without a turn back the warning clears (the phone twisted on its mount, not the user). A wrong-direction turn at the junction triggers "Wrong way". If the gyro misses a turn but the camera reads a plate on the next segment, the turn is inferred.

**Plates.** A plate must be read in 2 frames within 1.5 s (one misread frame is not enough), and must be on the current or next segment.

**Cues** (report §5): turn announced at 2.5 m ("In about 2 metres, turn right") and again at 0.5 m ("Turn right now"). Arrival is declared within 1.0 m of the waypoint, and only if σ ≤ 1 m or the destination plate was read. Walking > 2 m + σ past a turn or destination triggers an alert.

All of these numbers are in `NavConfig.kt`; the most important are also editable in the app's Settings.

---

## 8. Validation tests for Section 5 / §9.2 (use the CSV logs)

Every action is logged to `Android/data/com.example.e3navigator/files/logs/*.csv`. New file per navigation run; use **Share log** to export. Columns: `wall_time, elapsed_ms, event, state, segment, pos_m, sigma_m, steps, heading_deg, detail`.

| Requirement (report) | Test | Log events to analyse |
|---|---|---|
| Position error ≤ ±2 m | 10× measured 20 m walks: normal, slow, stop-start, short steps, **with a cane**, and at 3 phone positions. Tap Survey mark at the finish line. Report the spread, not just the mean: it is the basis for `driftFraction`. | `survey_mark` distance_est vs true distance; compare `step` vs `step_alt` counts |
| Drift between fixes | Walk between two known plates; note σ and the correction when the second is read | `position_fix`, `large_correction` (how far dead reckoning carries before the camera must correct it) |
| Turn detection ≥ 95% | Walk the junction 20× | `turn_detected`, `turn_accepted`, `turn_committed` |
| False turns | Walk the straight with deliberate dodges and stops | `turn_ignored`, `off_course` (should be rare for small dodges) |
| Landmark recognition ≥ 90% within 5 m | Walk past each plate 10× at normal speed | `ocr`, `landmark_confirmed` (range in detail) |
| Instruction latency ≤ 1 s (§9.2) / 500 ms (§5) | Any run | `tts_latency` (request → speech start), `ocr` ms= (OCR processing time) |
| Turn cue 2–3 m before the turn | Mark the floor; note where the cue is heard | `cue_turn_soon` remaining= |
| Arrival within 0.5–1.0 m | Measure where "You have arrived" is heard vs the door | `arrived` |
| Lost alert within 5 s | Cover the camera and walk | `lost` |
| Battery ≥ 60 min | Continuous run from 100% | (note battery % at start/end) |

---

## 9. Known limitations and next steps

- **Not yet run on a real phone.** The core logic is unit-tested on a laptop, but the Android layer (camera, sensors, speech) needs its first on-device test. Expect to tune thresholds in `NavConfig.kt` (especially `TurnDetector` 60°/700 ms and the accelerometer step thresholds) after your first corridor walks.
- Placeholder route geometry (see top).
- The app must stay in the foreground with the screen on (the layout keeps the screen awake). Background camera use is out of scope for the prototype.
- OCR is Latin-script ML Kit. Pictogram-only signs (e.g. a toilet icon without words) cannot be read; pick text plates as landmarks.
- The sighting-distance assumption (2.5 m) limits arrival accuracy until the plate calibration is done.
- Lateral deviation (drifting sideways within a corridor) is not measured. Only rotations away from the corridor are detected.

## 10. Suggested team split

| Workstream | Files |
|---|---|
| Route survey and data | `assets/routes/e3_route.json`, survey procedure (§4) |
| Motion tracking | `core/StepDetector.kt`, `core/TurnDetector.kt`, `sensing/MotionSensors.kt` |
| Computer vision | `sensing/TextScanner.kt`, `core/LandmarkMatcher.kt` |
| Navigation engine | `core/NavigationEngine.kt`, `core/NavConfig.kt`, tests |
| Integration, audio and testing | `MainActivity.kt`, `feedback/`, `data/NavLogger.kt`, §8 test runs |

Put the project on GitHub (Android Studio: **Git → Share Project on GitHub**) so each person works on a branch.
