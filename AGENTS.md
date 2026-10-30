# AGENTS.md

Static p5.js sandbox (hand-tracking game WIP). No build, no package manager, no tests.

`js/gamelogic.js` and `js/ui.js` are still empty stubs — they are reserved for the other two owners, so an empty file there is expected, not a broken checkout. `sketch.js` already wires `js/handpose.js`, which is the only implemented feature.

## Do not invent a toolchain

There is no `package.json`, bundler, test runner, linter, or CI. Never add or run `npm install`, `npm test`, `vite`, or similar. Every change ships as plain files loaded by `index.html`.

## Run it

Serve from the repository root — never open `index.html` via `file://`:

```powershell
python -m http.server 8000      # or: npx serve .
```

Two reasons this is mandatory:

1. Camera access needs a secure context. `http://localhost` qualifies; `file://` does not — `getUserMedia` simply fails there.
2. Camera permissions are per-origin, so a different port means granting permission again. Stick to one port.

## Script architecture

Classic scripts, p5 **global mode**. No `type="module"`, no `import`/`export`, no `require`, no bundler. `setup`, `draw`, and the p5 API (`createCanvas`, `background`, `random`, `dist`, …) are bare globals — adding ESM syntax silently breaks the sketch.

Load order in `index.html` is the dependency graph. Keep it:

```
p5 → ml5 → js/gamelogic.js → js/handpose.js → js/ui.js → sketch.js
```

`sketch.js` is the **composition root** and loads last on purpose: it is the only file that instantiates the feature modules, and it must stay wiring-only (no game rules, no feature drawing). Libraries are pinned CDN URLs (p5 2.3.3, ml5 1.4.0), so the page needs network access.

### Module contract (three owners, three files)

Each owner edits only their own file and exposes **one** namespace on `window`. Never declare a bare top-level `const`/`let`/`class` in one of these files: classic scripts share the global scope, so a duplicated name like `CONFIG` throws a redeclaration error at load time and takes the whole page down.

| File | Owner | Namespace | Rule |
|---|---|---|---|
| `js/handpose.js` | handpose | `window.Handpose` | Only place that touches the webcam or the ml5 model |
| `js/gamelogic.js` | gamelogic | `window.GameLogic` | Pure rules; reads normalized hand data, never p5 or DOM |
| `js/ui.js` | ui | `window.UI` | Screen only; reads game state, never detection internals |

Data flows one way: `handpose` → normalized hand data → `gamelogic` → `ui`. Publish a new module method as a documented contract in this file before another owner depends on it.

### Hand data contract (`Handpose.HandPoseTracker`)

- `new Handpose.HandPoseTracker({ maxHands, mirror, modelType, debug })` — `modelType: "lite"` (default, faster) or `"full"` (more accurate); `debug` logs camera size / readyState / detected hands once per second.
- `start()` — async and idempotent; the canvas keeps rendering while the model loads.
- `getStatus()` — `"idle" | "loading" | "ready" | "error"`; `getError()` for the message.
- `getHands()` — `{ count, hands: [...] }`, where each hand carries `handedness`, `confidence`, `keypoints[21]` (`{ name, x, y, z }`), `wrist`, `indexTip`, `thumbTip`, `pinchDistance`, `pinchRatio`.
- `render()` — draws bones + joints; call it **only inside p5 `draw()`** because it uses p5 globals.
- `stop()` — releases camera tracks and detection.

Coordinates are normalized `0..1` in **screen space** (already mirrored when `mirror: true`), so consumers never handle pixels or video dimensions. Keypoints follow MediaPipe's 21-landmark order (`wrist`, `thumb_*`, `index_finger_*`, …), and `pinchRatio` is distance divided by hand span — use it for gestures, because `pinchDistance` alone changes with distance to the camera.

### Camera gotchas

- The `<video>` element is 1px, `opacity: 0`, pinned at the top-left **inside** the viewport. It is deliberately not `display: none` and not off-screen: some browsers throttle frame decoding for hidden or off-screen videos, and the model then keeps seeing the same black frame forever (camera "open", zero hands, no error).
- **The `<video>` must have `width`/`height` attributes set to `videoWidth`/`videoHeight`.** ml5/tfjs maps landmark coordinates through those attributes; a native `<video>` from `createElement` has both at `0`, so every keypoint comes back `NaN` and the canvas stays black with the model reporting a hand. p5's `createCapture` sets them for you — a plain element does not. This was the real cause of the "detected but nothing drawn" bug.
- Startup is timeout-guarded: `getUserMedia` (15s), `play()` (8s), metadata (5s) and first decoded frame (8s). Any stall becomes `status === "error"` with a specific message instead of an endless "loading".
- The camera image is never drawn. If you see the webcam on screen, someone called `image(video, …)` — remove it.
- Never ship a state that renders nothing: `loading`, `error`, and `ready` with zero hands each draw a centered message (and a bottom hint while waiting for a hand). A black screen with no text is a bug, not a normal state.
- `getUserMedia` failures land in `status === "error"`; the message is rendered on the canvas.

## Expected console noise — do NOT "fix" it

Firefox always prints these three lines in this project. They come from the libraries and from DevTools, never from this repo, and silencing them by patching CDN files or filtering `console` is out of bounds:

| Message | Source | Why it is not fixable here |
|---|---|---|
| `Use of the orientation sensor is deprecated` | p5 2.3.3 `presetup` (`src/events/acceleration.js`) | p5 registers `deviceorientation` + `devicemotion` listeners unconditionally for its acceleration API, on every sketch instance. Our code calls no sensor API. p5 2.3.4 still ships the same code, so a patch upgrade does not silence it |
| `Use of the motion sensor is deprecated` | same hook, second listener | same |
| `Source map error … URL constructor: is not a valid URL`, resource `wasm:…ml5.min.js…WebAssembly.Module` | Firefox DevTools source-map worker | every stack frame is `resource://devtools/…`, i.e. DevTools' own code failing on the WebAssembly module ml5 compiles internally. It only appears with DevTools open; `ml5.min.js.map` itself resolves fine (HTTP 200) |

The real signal for detection failures is the `[handpose]` line from `console.error` plus the message drawn on the canvas.

### p5 2.3.3 ↔ ml5 1.4.0 compatibility

They do not couple in this project, and no version swap is needed to make them work:

- ml5 1.4.0 declares **no** `peerDependencies` on p5 and never touches `p5.prototype` (0 references in the bundle). Its only p5 awareness is feature-detecting `p5.Image` / `p5.Graphics` / `p5.Video` when an input happens to be a p5 element.
- This project passes a native `HTMLVideoElement` to `ml5.handPose().detectStart()`, so no p5 object ever crosses the boundary.
- p5 stays in global mode: 2.3.3 still mirrors instance properties (`width`, `height`, `ROUND`, `circle`, …) onto `window`, which is what `js/handpose.js` `render()` relies on.

## CSS baseline (already done)

`style.css` holds a reset — do not layer another one on top. Consequences to respect:

- `box-sizing: border-box` and `margin/padding: 0` are global.
- `html`/`body` are 100% with `overflow: hidden` because the canvas fills the viewport. Any scrollable HTML overlay requires changing that rule first.
- `font: inherit` on `h1`–`h4`, `p`, and form controls: headings have **no** size hierarchy. Style sizes explicitly.
- `canvas { display: block }` is what removes p5's inline-canvas bottom gap.

## Git

git-flow is configured in `.git/config`: `main` (master) and `develop`, with `feature/`, `bugfix/`, `release/`, `hotfix/` prefixes. Work on `feature/*`, integrate through `develop`.

- No remote is configured. Do not `git push`.
- Commit messages in existing history are short Spanish lowercase descriptions (`se poblo sketch.js`). Match the surrounding style.
- The repo lives under a OneDrive folder, so file-lock/sync noise during git operations is expected — not a repo bug.
