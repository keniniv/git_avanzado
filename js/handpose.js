/**
 * js/handpose.js — Hand pose sensor (owner: handpose).
 *
 * Responsibility: camera capture + ml5.js hand landmark detection + skeleton rendering.
 * This module is the ONLY place that knows about the webcam or the model.
 *
 * Public contract (read by gamelogic.js / ui.js / sketch.js):
 *   const tracker = new Handpose.HandPoseTracker({ maxHands: 2, mirror: true });
 *   tracker.start();          // async, idempotent. Resolves when the model is ready.
 *   tracker.getStatus();      // "idle" | "loading" | "ready" | "error"
 *   tracker.getHands();       // normalized hand data (see _toPublicHand)
 *   tracker.render();         // draws the skeleton. Call ONLY inside p5 draw().
 *   tracker.stop();           // releases camera + detection loop
 *
 * Coordinates: normalized 0..1 in SCREEN space (already mirrored when mirror=true),
 * so consumers never deal with pixels or video dimensions.
 */
(function () {
  "use strict";

  /** MediaPipe landmark order. ml5 exposes the same names on each hand object. */
  const KEYPOINT_NAMES = [
    "wrist",
    "thumb_cmc",
    "thumb_mcp",
    "thumb_ip",
    "thumb_tip",
    "index_finger_mcp",
    "index_finger_pip",
    "index_finger_dip",
    "index_finger_tip",
    "middle_finger_mcp",
    "middle_finger_pip",
    "middle_finger_dip",
    "middle_finger_tip",
    "ring_finger_mcp",
    "ring_finger_pip",
    "ring_finger_dip",
    "ring_finger_tip",
    "pinky_mcp",
    "pinky_pip",
    "pinky_dip",
    "pinky_tip",
  ];

  /** Bones as index pairs into KEYPOINT_NAMES. */
  const CONNECTIONS = [
    // palm
    [0, 1], [0, 5], [0, 17], [5, 9], [9, 13], [13, 17],
    // thumb
    [1, 2], [2, 3], [3, 4],
    // index
    [5, 6], [6, 7], [7, 8],
    // middle
    [9, 10], [10, 11], [11, 12],
    // ring
    [13, 14], [14, 15], [15, 16],
    // pinky
    [17, 18], [18, 19], [19, 20],
  ];

  /** Fingertip indexes get a bigger joint dot. */
  const TIP_INDEXES = { 4: true, 8: true, 12: true, 16: true, 20: true };

  /** Indexes used to estimate hand span, for scale-independent measurements. */
  const WRIST = 0;
  const MIDDLE_MCP = 9;
  const THUMB_TIP = 4;
  const INDEX_TIP = 8;

  const HAND_COLORS = {
    left: [74, 222, 128],
    right: [96, 165, 250],
    unknown: [226, 232, 240],
  };

  const DEFAULT_STYLE = {
    boneWeight: 5,
    boneAlpha: 210,
    jointRadius: 5,
    tipRadius: 9,
  };

  class HandPoseTracker {
    constructor(options = {}) {
      this.maxHands = options.maxHands ?? 2;
      this.mirror = options.mirror ?? true;
      this.modelType = options.modelType ?? "lite";
      this.debug = options.debug ?? false;
      this.runtime = options.runtime ?? null;
      this.style = Object.assign({}, DEFAULT_STYLE, options.style);

      this.status = "idle";
      this.errorMessage = "";

      this._hands = [];
      this._video = null;
      this._stream = null;
      this._model = null;
      this._detecting = false;
      this._startPromise = null;
      this._resultsReceived = 0;
    }

    /** Starts camera + model once. Safe to call repeatedly. */
    start() {
      if (!this._startPromise) {
        this._startPromise = this._start();
      }
      return this._startPromise;
    }

    async _start() {
      this.status = "loading";
      this.errorMessage = "";

      try {
        if (typeof ml5 === "undefined") {
          throw new Error(
            "ml5.js no está cargado. Revisá la etiqueta <script> de ml5 en index.html."
          );
        }

        await this._startCamera();
        await this._startModel();
        this.status = "ready";
      } catch (error) {
        this.status = "error";
        this.errorMessage = error && error.message ? error.message : String(error);
        console.error("[handpose] no se pudo iniciar:", error);
      }
    }

    async _startCamera() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
          "El navegador no expone getUserMedia. Serví la página por http://localhost, no por file://."
        );
      }

      const stream = await this._withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: "user",
            width: { ideal: 640 },
            height: { ideal: 480 },
            // The model never needs more than ~30fps, and decoding 60fps frames
            // steals main-thread time from the render loop.
            frameRate: { ideal: 30 },
          },
        }),
        15000,
        "No se pudo abrir la cámara: el navegador no respondió. Revisá el permiso de cámara " +
          "para este origen (y que no la esté usando otra aplicación)."
      );

      // Kept inside the viewport, 1px and transparent — never display:none and never
      // off-screen: some browsers throttle frame decoding for hidden/off-screen videos,
      // and the model would then keep seeing the same black frame forever.
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      video.setAttribute("playsinline", "");
      video.style.cssText =
        "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;";
      video.srcObject = stream;
      document.body.appendChild(video);

      await this._withTimeout(
        video.play(),
        8000,
        "La cámara se abrió pero el video no arrancó. Cerrá otras apps que la estén usando y recargá."
      );
      await this._waitForMetadata(video);
      await this._waitForFirstFrame(video);

      // ml5/tfjs maps landmark coordinates through the element's width/height ATTRIBUTES.
      // A native <video> built with createElement has width=0 and height=0, so every
      // keypoint comes back as NaN and nothing can be drawn. p5's createCapture hides
      // this by setting the attributes for you; we must do it ourselves.
      video.width = video.videoWidth;
      video.height = video.videoHeight;

      this._video = video;
      this._stream = stream;
      this._debug(
        "cámara lista: video " + video.videoWidth + "x" + video.videoHeight +
          ", readyState=" + video.readyState
      );
    }

    /** Rejects after `ms` so a stuck browser API becomes a visible error, never a silent black screen. */
    _withTimeout(promise, ms, message) {
      let timer;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
        }),
      ]).finally(() => clearTimeout(timer));
    }

    _waitForMetadata(video, timeoutMs = 5000) {
      if (video.videoWidth > 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const onLoaded = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          video.removeEventListener("loadedmetadata", onLoaded);
          reject(new Error("La cámara no reporta el tamaño de imagen en " + timeoutMs / 1000 + "s."));
        }, timeoutMs);
        video.addEventListener("loadedmetadata", onLoaded, { once: true });
      });
    }

    /**
     * Waits for a real decoded frame. A camera that "opens" but never delivers pixels
     * is the classic silent failure: status would be ready and nothing would ever draw.
     */
    _waitForFirstFrame(video, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(
          () =>
            finish(
              new Error(
                "La cámara abrió pero no entrega imágenes. Probá otra app de cámara para " +
                  "descartar un problema de permisos o de hardware."
              )
            ),
          timeoutMs
        );

        if (typeof video.requestVideoFrameCallback === "function") {
          video.requestVideoFrameCallback(() => finish());
          return;
        }
        if (video.readyState >= 2) finish();
        else video.addEventListener("loadeddata", () => finish(), { once: true });
      });
    }

    async _startModel() {
      const modelOptions = { maxHands: this.maxHands, modelType: this.modelType };
      // "mediapipe" uses the MediaPipe Hands solution instead of tfjs; it is often
      // faster. Left unset (ml5 default = "tfjs") unless the caller opts in.
      if (this.runtime) modelOptions.runtime = this.runtime;

      this._model = await ml5.handPose(modelOptions);
      this._debug("modelo listo: modelType=" + this.modelType + ", runtime=" + (this.runtime || "default"));

      if (this._detecting) return;
      this._detecting = true;
      this._model.detectStart(this._video, (results) => this._onResults(results));
    }

    _onResults(results) {
      this._resultsReceived += 1;
      const list = Array.isArray(results) ? results : [];
      this._hands = list.map((hand) => this._toPublicHand(hand)).filter(Boolean);

      if (this.debug) {
        const now = performance.now();
        if (!this._lastLogAt || now - this._lastLogAt > 1000) {
          this._lastLogAt = now;
          const first = this._hands[0];
          this._debug(
            "manos detectadas: " + this._hands.length + " / crudas: " + list.length,
            first ? "| primer keypoint: x=" + first.keypoints[0].x.toFixed(3) + " y=" + first.keypoints[0].y.toFixed(3) : ""
          );
        }
      }
    }

    _debug(...args) {
      if (this.debug) console.log("[handpose]", ...args);
    }

    /**
     * Converts one ml5 result into the public, normalized shape.
     * Everything downstream depends on this shape, so keep it stable.
     */
    _toPublicHand(hand) {
      const raw = hand && Array.isArray(hand.keypoints) ? hand.keypoints : null;
      if (!raw || raw.length < KEYPOINT_NAMES.length) return null;

      const videoWidth = this._video.videoWidth || this._video.width || 1;
      const videoHeight = this._video.videoHeight || this._video.height || 1;

      const keypoints = raw.slice(0, KEYPOINT_NAMES.length).map((keypoint, index) => {
        const x = keypoint.x / videoWidth;
        return {
          name: keypoint.name || KEYPOINT_NAMES[index],
          x: this.mirror ? 1 - x : x,
          y: keypoint.y / videoHeight,
          z: keypoint.z ?? keypoint.z3D ?? 0,
        };
      });

      // A NaN here means ml5 could not map coordinates (typically because the <video>
      // has no width/height attributes). Drawing NaN would paint nothing at all.
      if (!Number.isFinite(keypoints[0].x) || !Number.isFinite(keypoints[0].y)) {
        if (!this._warnedNaN) {
          this._warnedNaN = true;
          console.warn(
            "[handpose] keypoints NaN: el modelo detectó una mano pero no pudo mapear coordenadas. " +
              "Revisá los atributos width/height del <video>."
          );
        }
        return null;
      }

      const span = Math.hypot(
        keypoints[WRIST].x - keypoints[MIDDLE_MCP].x,
        keypoints[WRIST].y - keypoints[MIDDLE_MCP].y
      );
      const pinchDistance = Math.hypot(
        keypoints[THUMB_TIP].x - keypoints[INDEX_TIP].x,
        keypoints[THUMB_TIP].y - keypoints[INDEX_TIP].y
      );

      return {
        handedness: this._readHandedness(hand),
        confidence: typeof hand.confidence === "number" ? hand.confidence : null,
        keypoints,
        wrist: keypoints[WRIST],
        indexTip: keypoints[INDEX_TIP],
        thumbTip: keypoints[THUMB_TIP],
        /** Normalized distance between thumb tip and index tip. */
        pinchDistance,
        /** pinchDistance / hand span: scale-independent, use this for gestures. */
        pinchRatio: span > 0 ? pinchDistance / span : 0,
      };
    }

    _readHandedness(hand) {
      const value = hand && hand.handedness;
      if (typeof value === "string") return value.toLowerCase();
      if (value && typeof value.label === "string") return value.label.toLowerCase();
      return "unknown";
    }

    getStatus() {
      return this.status;
    }

    getError() {
      return this.errorMessage;
    }

    /** Latest hand data. Never returns internal references. */
    getHands() {
      return { count: this._hands.length, hands: this._hands };
    }

    /** Draws bones + joints. Must run inside p5 draw(). */
    render() {
      if (this.status === "loading") {
        this._drawMessage("Cargando modelo de manos…");
        return;
      }
      if (this.status === "error") {
        this._drawMessage("No se pudo iniciar la cámara:\n" + this.errorMessage);
        return;
      }
      if (this.status !== "ready") return;

      const scale = Math.min(width, height) / 700;
      for (const hand of this._hands) {
        this._drawHand(hand, scale);
      }

      // Never leave the screen as a silent black void: say what the sensor is doing.
      if (this._hands.length === 0) {
        this._drawHint(
          this._resultsReceived === 0
            ? "Cámara activa · el modelo todavía no entrega resultados…"
            : "Cámara activa · esperando una mano frente al lente…"
        );
      }
    }

    _drawHand(hand, scale) {
      const points = hand.keypoints;
      const color = HAND_COLORS[hand.handedness] || HAND_COLORS.unknown;
      const toX = (point) => point.x * width;
      const toY = (point) => point.y * height;

      // Bones
      noFill();
      stroke(color[0], color[1], color[2], this.style.boneAlpha);
      strokeWeight(this.style.boneWeight * scale);
      strokeCap(ROUND);
      for (const [from, to] of CONNECTIONS) {
        line(toX(points[from]), toY(points[from]), toX(points[to]), toY(points[to]));
      }

      // Joints
      noStroke();
      fill(color[0], color[1], color[2]);
      for (let index = 0; index < points.length; index += 1) {
        const radius = (TIP_INDEXES[index] ? this.style.tipRadius : this.style.jointRadius) * scale;
        circle(toX(points[index]), toY(points[index]), radius * 2);
      }
    }

    _drawMessage(message) {
      // p5 2.x treats the 4th argument as a text box, not as a center point: with
      // textAlign(CENTER) the text centers inside [x, x + width]. So offset the box
      // by half its width to get true centering on screen.
      const boxWidth = Math.min(width * 0.8, 640);
      noStroke();
      fill(226, 232, 240);
      textAlign(CENTER, CENTER);
      textSize(16);
      text(message, width / 2 - boxWidth / 2, height / 2, boxWidth);
    }

    _drawHint(message) {
      noStroke();
      fill(148, 163, 184, 220);
      textAlign(CENTER, BOTTOM);
      textSize(14);
      text(message, 0, height - 18, width);
    }

    stop() {
      if (this._model && typeof this._model.detectStop === "function") {
        this._model.detectStop();
      }
      this._detecting = false;

      if (this._stream) {
        for (const track of this._stream.getTracks()) track.stop();
        this._stream = null;
      }
      if (this._video && this._video.parentNode) {
        this._video.parentNode.removeChild(this._video);
      }
      this._video = null;
      this._hands = [];
      this._resultsReceived = 0;
      this._startPromise = null;
      this.status = "idle";
    }
  }

  window.Handpose = { HandPoseTracker, CONNECTIONS, KEYPOINT_NAMES };
})();
