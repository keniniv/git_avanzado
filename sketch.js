/**
 * sketch.js — composition root (wiring only).
 *
 * This file decides WHO runs and in what order. It must stay free of game rules
 * and of feature drawing code, so the three owners never need to edit it except
 * to plug their module in.
 *
 * Data flow (one direction only):
 *   handpose (sensor) -> normalized hand data -> gamelogic (rules) -> ui (screen)
 */
const SketchConfig = {
  background: [11, 14, 19],
  handpose: {
    maxHands: 2,
    mirror: true, // mirrored = "selfie" view, data and screen agree
    modelType: "lite", // "lite" for FPS, "full" for accuracy
    runtime: null, // try "mediapipe" for another speed/accuracy point
    debug: false, // set true to log camera size, readyState and hands/second
  },
};

let handpose;

function setup() {
  createCanvas(windowWidth, windowHeight);
  // Must come AFTER createCanvas in p5 2.x, otherwise the backing store keeps the
  // screen's devicePixelRatio and every frame clears/paints 4x more pixels.
  pixelDensity(1);

  handpose = new Handpose.HandPoseTracker(SketchConfig.handpose);
  handpose.start(); // async: the canvas renders while the model loads

  // TODO(gamelogic): game = new GameLogic.Game();
  // TODO(ui): hud = new UI.Hud();
}

function draw() {
  background(...SketchConfig.background);

  // 1. Sensor: draws only the hand skeleton, never the camera image.
  handpose.render();

  // 2. Rules — read handpose.getHands() only:
  //    const input = handpose.getHands();
  //    game.update(input, deltaTime / 1000);

  // 3. Screen — read game state only:
  //    hud.render(game.state);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
