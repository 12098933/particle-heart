const cameraButton = document.querySelector('[data-control="camera"]');
const video = document.getElementById("cameraFeed");
const handStage = document.getElementById("handStage");
const overlay = document.getElementById("handOverlay");
const overlayContext = overlay.getContext("2d");
const gestureState = document.getElementById("gestureState");
const cameraHud = document.getElementById("cameraHud");
const cameraStatus = document.getElementById("cameraStatus");
const cameraQuality = document.getElementById("cameraQuality");
const fxCanvas = document.getElementById("gestureFx");
const fxContext = fxCanvas.getContext("2d");
const analysisCanvas = document.createElement("canvas");
const analysisContext = analysisCanvas.getContext("2d", { willReadFrequently: false });
const WORKER_INIT_TIMEOUT_MS = 180000;
const EMBEDDED_BROWSER_PATTERN = /MicroMessenger|WeChat|QQ\/|Douyin|BytedanceWebview|FBAN|FBAV/i;
const isEmbeddedBrowser = EMBEDDED_BROWSER_PATTERN.test(navigator.userAgent);
const isHandheldDevice = window.matchMedia("(pointer: coarse)").matches
  || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17]
];

let stream = null;
let handLandmarker = null;
let landmarkerPromise = null;
let animationFrame = 0;
let cameraRunning = false;
let cameraStarting = false;
let lastVideoTime = -1;
let lastDetectionTime = 0;
let lastHandSeen = 0;
let lastPinch = false;
let pinchHoldStarted = 0;
let pinchConfirmed = false;
let lastSwipeTrigger = 0;
let baseline = null;
let swipeHistory = [];
let overlaySize = { width: 0, height: 0, ratio: 1 };
let noHandSince = 0;
let alternateCrop = false;
let recoveryPromise = null;
let detectorDelegate = "CPU";
let preferCpuDelegate = false;
let cpuFallbackAttempted = false;
let detectionWorker = null;
let workerReady = false;
let workerBusy = false;
let workerRequestId = 0;
let pendingWorkerRequest = null;
let workerInitPromise = null;
let detectionMode = "initializing";
let fxAnimationFrame = 0;
let fxCursor = { x: 0, y: 0, initialized: false };
let fxTarget = { active: false, x: 0, y: 0, pinch: 0, pointer: false, speed: 0 };
let fxTrail = [];
let fxSparks = [];
let lastFxTrailAt = 0;
let lastHandCenter = null;
let lastGalleryPinch = 0;
let lastGestureProblem = null;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

function smoothstep(minimum, maximum, value) {
  const normalized = clamp((value - minimum) / Math.max(0.0001, maximum - minimum), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

function getPalmCenter(landmarks) {
  const indices = [0, 5, 9, 13, 17];
  return {
    x: 1 - indices.reduce((sum, index) => sum + landmarks[index].x, 0) / indices.length,
    y: indices.reduce((sum, index) => sum + landmarks[index].y, 0) / indices.length,
    z: indices.reduce((sum, index) => sum + (landmarks[index].z || 0), 0) / indices.length
  };
}

function setGestureLabel(label, tracking = false) {
  gestureState.textContent = label;
  cameraHud.classList.toggle("is-tracking", tracking);
  cameraHud.classList.toggle("is-searching", !tracking);
  cameraStatus.textContent = `${label.toLowerCase()} · ${detectorDelegate.toLowerCase()}`;
}

function notify(message) {
  window.ParticleHeart?.notify(message);
}

function reportGestureProblem(title, message) {
  lastGestureProblem = { title, message };
  notify(message);
  window.dispatchEvent(new CustomEvent("particleheart:gesture-error", {
    detail: {
      title,
      message,
      linkLabel: "重新加载页面",
      linkHref: window.location.href
    }
  }));
}

async function createLandmarker() {
  const moduleUrl = new URL("./vision_bundle.mjs", import.meta.url).href;
  const wasmUrl = new URL("./wasm", import.meta.url).href;
  const modelUrl = new URL("./hand_landmarker.task", import.meta.url).href;
  const { FilesetResolver, HandLandmarker } = await import(moduleUrl);
  const visionFiles = await FilesetResolver.forVisionTasks(wasmUrl);
  const delegates = preferCpuDelegate ? ["CPU"] : ["GPU", "CPU"];
  let lastError = null;

  for (const delegate of delegates) {
    try {
      const instance = await HandLandmarker.createFromOptions(visionFiles, {
        baseOptions: {
          modelAssetPath: modelUrl,
          delegate
        },
        runningMode: "VIDEO",
        numHands: 1,
        minHandDetectionConfidence: 0.22,
        minHandPresenceConfidence: 0.25,
        minTrackingConfidence: 0.2
      });
      detectorDelegate = delegate;
      return instance;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("HAND_LANDMARKER_INIT_FAILED");
}

function ensureLandmarker() {
  if (handLandmarker) return Promise.resolve(handLandmarker);
  if (!landmarkerPromise) {
    landmarkerPromise = createLandmarker()
      .then((instance) => {
        handLandmarker = instance;
        return instance;
      })
      .catch((error) => {
        landmarkerPromise = null;
        throw error;
      });
  }
  return landmarkerPromise;
}

function ensureDetectionWorker() {
  if (workerReady && detectionWorker) return Promise.resolve();
  if (workerInitPromise) return workerInitPromise;

  workerInitPromise = new Promise((resolve, reject) => {
    if (!window.Worker || !window.createImageBitmap) {
      reject(new Error("WORKER_NOT_SUPPORTED"));
      return;
    }

    const worker = new Worker(new URL("./gesture-worker.js", import.meta.url), {
      name: "hand-tracking-worker"
    });
    detectionWorker = worker;
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      detectionWorker = null;
      workerReady = false;
      reject(new Error("WORKER_INIT_TIMEOUT"));
    }, WORKER_INIT_TIMEOUT_MS);

    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "init-progress") {
        if (settled) return;
        const progressLabels = {
          bundle: "MODEL LINK",
          runtime: "AI RUNTIME",
          model: "HAND MODEL"
        };
        setGestureLabel(progressLabels[message.stage] || "MODEL LOADING", false);
        return;
      }
      if (message.type === "ready") {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        workerReady = true;
        detectionMode = "worker";
        detectorDelegate = `${message.delegate}-worker`;
        if (!cameraStarting) {
          setGestureLabel("MODEL READY", false);
        }
        resolve();
        return;
      }
      if (message.type === "init-error") {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        worker.terminate();
        detectionWorker = null;
        workerReady = false;
        reject(new Error(message.message || "WORKER_INIT_FAILED"));
        return;
      }
      if (message.type === "detection-result") {
        handleWorkerDetectionResult(message);
        return;
      }
      if (message.type === "detection-error") {
        handleWorkerDetectionError(message);
      }
    };

    worker.onerror = (event) => {
      if (!settled) {
        settled = true;
        window.clearTimeout(timeout);
        worker.terminate();
        detectionWorker = null;
        workerReady = false;
        reject(new Error(event.message || "WORKER_RUNTIME_ERROR"));
      } else {
        handleWorkerDetectionError({ message: event.message || "WORKER_RUNTIME_ERROR" });
      }
    };

    worker.postMessage({
      type: "init",
      bundlePath: new URL("./vision_bundle.mjs", import.meta.url).href,
      wasmPath: new URL("./wasm", import.meta.url).href,
      modelPath: new URL("./hand_landmarker.task", import.meta.url).href
    });
  }).catch((error) => {
    workerInitPromise = null;
    throw error;
  });

  return workerInitPromise;
}

async function prepareDetectionEngine() {
  try {
    await ensureDetectionWorker();
    detectionMode = "worker";
  } catch (error) {
    console.warn("[gesture] Worker mode unavailable, using compatible mode.", error);
    detectionWorker?.terminate();
    detectionWorker = null;
    workerReady = false;
    workerBusy = false;
    pendingWorkerRequest = null;
    preferCpuDelegate = true;
    await ensureLandmarker();
    detectionMode = "thread";
  }
}

function ensureOverlaySize() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(handStage.clientWidth * ratio));
  const height = Math.max(1, Math.round(handStage.clientHeight * ratio));
  if (overlay.width !== width || overlay.height !== height) {
    overlay.width = width;
    overlay.height = height;
    overlaySize = { width, height, ratio };
  }
}

function clearOverlay() {
  overlayContext.clearRect(0, 0, overlay.width, overlay.height);
}

function drawGuide() {
  ensureOverlaySize();
  clearOverlay();
  const { ratio } = overlaySize;
  const width = handStage.clientWidth;
  const height = handStage.clientHeight;
  const insetX = width * 0.18;
  const insetY = height * 0.16;
  const corner = Math.min(width, height) * 0.1;

  overlayContext.save();
  overlayContext.scale(ratio, ratio);
  overlayContext.strokeStyle = "rgba(255, 196, 107, 0.42)";
  overlayContext.lineWidth = 1;
  overlayContext.shadowColor = "rgba(255, 104, 45, 0.45)";
  overlayContext.shadowBlur = 8;

  const corners = [
    [insetX, insetY, 1, 1],
    [width - insetX, insetY, -1, 1],
    [insetX, height - insetY, 1, -1],
    [width - insetX, height - insetY, -1, -1]
  ];

  corners.forEach(([x, y, directionX, directionY]) => {
    overlayContext.beginPath();
    overlayContext.moveTo(x + corner * directionX, y);
    overlayContext.lineTo(x, y);
    overlayContext.lineTo(x, y + corner * directionY);
    overlayContext.stroke();
  });
  overlayContext.restore();
}

function getCoverMetrics() {
  const viewportWidth = handStage.clientWidth;
  const viewportHeight = handStage.clientHeight;
  const sourceWidth = video.videoWidth || 1;
  const sourceHeight = video.videoHeight || 1;
  const contain = window.matchMedia("(max-width: 640px)").matches;
  const scale = contain
    ? Math.min(viewportWidth / sourceWidth, viewportHeight / sourceHeight)
    : Math.max(viewportWidth / sourceWidth, viewportHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (viewportWidth - width) / 2,
    y: (viewportHeight - height) / 2,
    width,
    height
  };
}

function drawHand(landmarks, clearBeforeDrawing = true) {
  ensureOverlaySize();
  if (clearBeforeDrawing) clearOverlay();
  const { ratio } = overlaySize;
  const viewportWidth = handStage.clientWidth;
  const viewportHeight = handStage.clientHeight;
  const cover = getCoverMetrics();
  const points = landmarks.map((point) => ({
    x: cover.x + (1 - point.x) * cover.width,
    y: cover.y + point.y * cover.height
  }));

  overlayContext.save();
  overlayContext.scale(ratio, ratio);
  overlayContext.lineCap = "round";
  overlayContext.lineJoin = "round";
  overlayContext.shadowColor = "rgba(255, 102, 48, 0.7)";
  overlayContext.shadowBlur = 7;
  overlayContext.strokeStyle = "rgba(255, 205, 132, 0.7)";
  overlayContext.fillStyle = "rgba(255, 241, 214, 0.92)";
  overlayContext.lineWidth = 1.2;

  HAND_CONNECTIONS.forEach(([start, end]) => {
    overlayContext.beginPath();
    overlayContext.moveTo(points[start].x, points[start].y);
    overlayContext.lineTo(points[end].x, points[end].y);
    overlayContext.stroke();
  });

  points.forEach((point, index) => {
    const radius = index === 4 || index === 8 ? 2.5 : 1.7;
    overlayContext.beginPath();
    overlayContext.arc(point.x, point.y, radius, 0, Math.PI * 2);
    overlayContext.fill();
  });
  overlayContext.restore();

  return {
    points,
    width: viewportWidth,
    height: viewportHeight
  };
}

function resizeFxCanvas() {
  const ratio = 1;
  const width = Math.max(1, Math.round(window.innerWidth * ratio));
  const height = Math.max(1, Math.round(window.innerHeight * ratio));
  if (fxCanvas.width !== width || fxCanvas.height !== height) {
    fxCanvas.width = width;
    fxCanvas.height = height;
  }
  fxCanvas.style.width = `${window.innerWidth}px`;
  fxCanvas.style.height = `${window.innerHeight}px`;
}

function emitSparks(count = 18) {
  if (!fxCursor.initialized) return;
  for (let index = 0; index < count; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.9 + Math.random() * 2.8;
    fxSparks.push({
      x: fxCursor.x,
      y: fxCursor.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      age: 0,
      life: 520 + Math.random() * 500,
      size: 1 + Math.random() * 2.2
    });
  }
}

function updateFxTarget(landmarks, metrics) {
  const indexTip = landmarks[8];
  const screenX = (1 - indexTip.x) * window.innerWidth;
  const screenY = indexTip.y * window.innerHeight;
  fxTarget = {
    active: true,
    x: clamp(screenX, 8, window.innerWidth - 8),
    y: clamp(screenY, 8, window.innerHeight - 8),
    pinch: metrics.pinchAmount,
    pointer: metrics.indexOnly || metrics.pinching,
    speed: metrics.speed
  };
  fxCanvas.classList.add("is-active");
}

function drawFxFrame(now) {
  fxAnimationFrame = requestAnimationFrame(drawFxFrame);
  const width = window.innerWidth;
  const height = window.innerHeight;
  const ratio = fxCanvas.width / Math.max(1, width);
  fxContext.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
  fxContext.save();
  fxContext.scale(ratio, ratio);
  fxContext.globalCompositeOperation = "lighter";

  if (fxTarget.active) {
    if (!fxCursor.initialized) {
      fxCursor.x = fxTarget.x;
      fxCursor.y = fxTarget.y;
      fxCursor.initialized = true;
    } else {
      const response = clamp(0.34 + fxTarget.speed * 8, 0.34, 0.72);
      fxCursor.x += (fxTarget.x - fxCursor.x) * response;
      fxCursor.y += (fxTarget.y - fxCursor.y) * response;
    }

    if (fxTarget.pointer && now - lastFxTrailAt > 12) {
      lastFxTrailAt = now;
      fxTrail.push({
        x: fxCursor.x,
        y: fxCursor.y,
        time: now,
        pinch: fxTarget.pinch
      });
    }
  } else {
    fxCursor.initialized = false;
  }

  fxTrail = fxTrail.filter((point) => now - point.time < 620);
  if (fxTrail.length > 1) {
    for (let index = 1; index < fxTrail.length; index += 1) {
      const previous = fxTrail[index - 1];
      const point = fxTrail[index];
      const life = 1 - (now - point.time) / 620;
      fxContext.strokeStyle = `rgba(255, 142, 75, ${Math.max(0, life) * 0.24})`;
      fxContext.lineWidth = 1 + life * 1.8;
      fxContext.beginPath();
      fxContext.moveTo(previous.x, previous.y);
      fxContext.lineTo(point.x, point.y);
      fxContext.stroke();
    }

    fxTrail.forEach((point) => {
      const life = Math.max(0, 1 - (now - point.time) / 620);
      const radius = 1.2 + life * (2.2 + point.pinch * 2.2);
      fxContext.fillStyle = `rgba(255, 190, 104, ${life * 0.46})`;
      fxContext.beginPath();
      fxContext.arc(point.x, point.y, radius, 0, Math.PI * 2);
      fxContext.fill();
    });
  }

  if (fxTarget.active && now - lastHandSeen < 420) {
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.008);
    const radius = fxTarget.pinch > 0.12
      ? 16 - fxTarget.pinch * 9
      : 12 + pulse * 2.2;
    fxContext.strokeStyle = `rgba(255, 220, 161, ${0.5 + pulse * 0.2})`;
    fxContext.lineWidth = 1.2;
    fxContext.beginPath();
    fxContext.arc(fxCursor.x, fxCursor.y, radius, 0, Math.PI * 2);
    fxContext.stroke();
    fxContext.fillStyle = "rgba(255, 116, 53, 0.88)";
    fxContext.beginPath();
    fxContext.arc(fxCursor.x, fxCursor.y, 2.2, 0, Math.PI * 2);
    fxContext.fill();

    for (let index = 0; index < 4; index += 1) {
      const angle = index * Math.PI / 2 + now * 0.0004;
      const inner = radius + 4;
      const outer = inner + 5;
      fxContext.beginPath();
      fxContext.moveTo(fxCursor.x + Math.cos(angle) * inner, fxCursor.y + Math.sin(angle) * inner);
      fxContext.lineTo(fxCursor.x + Math.cos(angle) * outer, fxCursor.y + Math.sin(angle) * outer);
      fxContext.stroke();
    }
  }

  fxSparks = fxSparks.filter((spark) => spark.age < spark.life);
  fxSparks.forEach((spark) => {
    spark.age += 16.67;
    spark.x += spark.vx;
    spark.y += spark.vy;
    spark.vx *= 0.975;
    spark.vy = spark.vy * 0.975 + 0.035;
    const life = Math.max(0, 1 - spark.age / spark.life);
    fxContext.fillStyle = `rgba(255, ${Math.round(130 + life * 100)}, 70, ${life * 0.82})`;
    fxContext.beginPath();
    fxContext.arc(spark.x, spark.y, spark.size * life, 0, Math.PI * 2);
    fxContext.fill();
  });

  fxContext.restore();
}

function startFxCanvas() {
  resizeFxCanvas();
  cancelAnimationFrame(fxAnimationFrame);
  fxAnimationFrame = requestAnimationFrame(drawFxFrame);
}

function stopFxCanvas() {
  cancelAnimationFrame(fxAnimationFrame);
  fxAnimationFrame = 0;
  fxTrail = [];
  fxSparks = [];
  fxTarget.active = false;
  fxCursor.initialized = false;
  fxCanvas.classList.remove("is-active");
  fxContext.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
}

function fingerState(landmarks) {
  const wrist = landmarks[0];
  const tips = [8, 12, 16, 20];
  const joints = [6, 10, 14, 18];
  return tips.map((tip, index) => distance(wrist, landmarks[tip]) > distance(wrist, landmarks[joints[index]]) * 1.06);
}

function pinchedFingerCount(landmarks, palmSize) {
  const thumbTip = landmarks[4];
  const tipIndices = [8, 12, 16, 20];
  return tipIndices.reduce((count, tipIndex) => {
    const ratio = distance(thumbTip, landmarks[tipIndex]) / palmSize;
    return count + (ratio < 0.34 ? 1 : 0);
  }, 0);
}

function processHand(landmarks, now, confidence = 0, options = {}) {
  const extended = fingerState(landmarks);
  const openCount = extended.filter(Boolean).length;
  const palmSize = Math.max(distance(landmarks[0], landmarks[9]), 0.001);
  const pinchRatios = [8, 12, 16, 20].map((tip) => distance(landmarks[4], landmarks[tip]) / palmSize);
  const pinchCount = pinchRatios.filter((ratio) => ratio < 0.34).length;
  const closestPinchRatio = Math.min(...pinchRatios);
  const handCenter = getPalmCenter(landmarks);
  const pinchMidpoint = {
    x: (landmarks[4].x + landmarks[8].x) / 2,
    y: (landmarks[4].y + landmarks[8].y) / 2,
    z: ((landmarks[4].z || 0) + (landmarks[8].z || 0)) / 2
  };
  const pinchAwayFromPalm = distance(pinchMidpoint, handCenter) / palmSize;
  const averageTipDistance = [8, 12, 16, 20].reduce(
    (sum, tipIndex) => sum + distance(handCenter, landmarks[tipIndex]),
    0
  ) / 4;
  const fingerSpread = smoothstep(1.0, 1.75, averageTipDistance / palmSize);
  const handOpenness = openCount === 0
    ? 0
    : clamp(fingerSpread * 0.7 + openCount / 4 * 0.3, 0, 1);
  const pinching = (pinchCount === 1 || pinchCount === 2)
    && openCount >= 2
    && pinchRatios[0] < 0.3
    && pinchAwayFromPalm > 0.52;
  const pinchAmount = pinching ? clamp((0.48 - pinchRatios[0]) / 0.3, 0, 1) : 0;
  const palmRoll = Math.atan2(
    landmarks[9].x - landmarks[0].x,
    -(landmarks[9].y - landmarks[0].y)
  );
  const movementSpeed = lastHandCenter
    ? Math.hypot(
      handCenter.x - lastHandCenter.x,
      handCenter.y - lastHandCenter.y,
      handCenter.z - lastHandCenter.z
    )
    : 0;
  lastHandCenter = handCenter;

  if (!lastHandSeen || now - lastHandSeen > 1900 || !baseline) {
    baseline = {
      x: handCenter.x,
      y: handCenter.y,
      z: handCenter.z,
      palmSize,
      roll: palmRoll
    };
    swipeHistory = [];
  }

  const normalizedX = clamp((handCenter.x - baseline.x) / 0.19, -1, 1);
  const normalizedY = clamp((handCenter.y - baseline.y) / 0.16, -1, 1);
  const normalizedZ = clamp((handCenter.z - baseline.z) / 0.12, -1, 1);
  const normalizedDepth = clamp((palmSize / baseline.palmSize - 1) / 0.28, -1, 1);
  const rollDifference = Math.atan2(
    Math.sin(palmRoll - baseline.roll),
    Math.cos(palmRoll - baseline.roll)
  );
  const normalizedRoll = clamp(rollDifference / 0.8, -1, 1);
  const openAmount = clamp((openCount - 2) / 2, 0, 1);
  const indexOnly = extended[0] && !extended[1] && !extended[2] && !extended[3];
  const fist = openCount === 0;
  let label = "TRACKING";

  if (pinching) {
    label = pinchCount > 1 ? "TWO-FINGER PINCH" : "PINCH";
  } else if (openCount >= 4) {
    label = "OPEN PALM";
  } else if (fist) {
    label = "FIST";
  } else if (indexOnly) {
    label = "POINT";
  }

  const galleryWasOpen = Boolean(window.ParticleGallery?.isOpen?.());
  const allowGalleryPinch = options.allowGalleryPinch !== false;
  if (pinching) {
    if (!lastPinch) pinchHoldStarted = now;
    if (
      allowGalleryPinch &&
      !pinchConfirmed &&
      now - pinchHoldStarted >= 90 &&
      now - lastGalleryPinch > 520
    ) {
      if (!galleryWasOpen) {
        window.ParticleGallery?.toggleByGesture();
        lastGalleryPinch = now;
        label = "GALLERY OPEN";
      } else if (pinchCount === 1) {
        window.ParticleGallery?.toggleByGesture();
        lastGalleryPinch = now;
        label = "GALLERY CLOSE";
      }
      pinchConfirmed = true;
    }
  } else {
    pinchHoldStarted = 0;
    pinchConfirmed = false;
    if (lastPinch) {
      window.ParticleGallery?.setPinch(0);
      window.ParticleHeart?.burst(0.42);
      emitSparks(16);
    }
  }
  lastPinch = pinching;

  const galleryIsOpen = Boolean(window.ParticleGallery?.isOpen?.());
  if (allowGalleryPinch && pinchConfirmed && pinching && galleryIsOpen && pinchCount === 2) {
    window.ParticleGallery?.setPinch(pinchAmount);
    label = "PHOTO ZOOM";
  }

  if (!pinching && !galleryIsOpen) {
    window.ParticleHeart?.setHandOpenness(handOpenness);
  }

  swipeHistory.push({ x: handCenter.x, time: now });
  swipeHistory = swipeHistory.filter((sample) => now - sample.time <= 330);
  if (!pinching && swipeHistory.length > 1 && now - lastSwipeTrigger > 900) {
    const first = swipeHistory[0];
    const last = swipeHistory[swipeHistory.length - 1];
    const elapsed = Math.max(1, last.time - first.time);
    const velocity = Math.abs(last.x - first.x) / (elapsed / 1000);
    if (Math.abs(last.x - first.x) > 0.09 && velocity > 0.36) {
      if (openCount >= 4) {
        const direction = last.x < first.x ? 1 : -1;
        window.ParticleGallery?.switchByGesture(direction);
        if (window.ParticleGallery?.isOpen()) {
          label = direction > 0 ? "PHOTO NEXT" : "PHOTO PREV";
        }
      }
      lastSwipeTrigger = now;
      swipeHistory = [];
    }
  }

  const metrics = {
    extended,
    openCount,
    pinchCount,
    pinchAmount,
    pinching,
    openness: handOpenness,
    indexOnly,
    fist,
    center: handCenter,
    speed: movementSpeed,
    depth: normalizedDepth,
    roll: normalizedRoll
  };

  window.ParticleHeart?.setGestureState({
    active: true,
    x: normalizedX,
    y: normalizedY,
    z: normalizedZ,
    depth: normalizedDepth,
    roll: normalizedRoll,
    pinch: pinchAmount,
    open: openAmount,
    label
  });
  setGestureLabel(label, true);
  gestureState.title = `置信度 ${Math.round(confidence * 100)}%`;
  lastHandSeen = now;
  updateFxTarget(landmarks, metrics);
  return metrics;
}

function prepareDetectionSource(useCrop) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const cropScale = useCrop ? 0.76 : 1;
  const cropWidth = Math.round(sourceWidth * cropScale);
  const cropHeight = Math.round(sourceHeight * cropScale);
  const cropX = Math.round((sourceWidth - cropWidth) / 2);
  const cropY = Math.round((sourceHeight - cropHeight) / 2);
  const baseOutputWidth = isHandheldDevice ? 384 : 512;
  const outputWidth = useCrop ? baseOutputWidth + 48 : baseOutputWidth;
  const outputHeight = Math.max(1, Math.round(outputWidth * cropHeight / cropWidth));

  if (analysisCanvas.width !== outputWidth || analysisCanvas.height !== outputHeight) {
    analysisCanvas.width = outputWidth;
    analysisCanvas.height = outputHeight;
  }
  analysisContext.drawImage(
    video,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    outputWidth,
    outputHeight
  );
  return {
    source: analysisCanvas,
    mapping: useCrop ? {
      x: cropX / sourceWidth,
      y: cropY / sourceHeight,
      width: cropWidth / sourceWidth,
      height: cropHeight / sourceHeight
    } : null
  };
}

function mapLandmarks(landmarks, mapping) {
  if (!mapping) return landmarks;
  return landmarks.map((point) => ({
    ...point,
    x: mapping.x + point.x * mapping.width,
    y: mapping.y + point.y * mapping.height
  }));
}

function handleDetectionResult(result, mapping, now) {
  if (result.landmarks?.length) {
    const landmarks = mapLandmarks(result.landmarks[0], mapping);
    const confidence = result.handedness?.[0]?.[0]?.score || 0;
    noHandSince = 0;
    alternateCrop = false;
    drawHand(landmarks);
    processHand(landmarks, now, confidence);
    return;
  }

  if (now - lastHandSeen > 260) {
    if (!noHandSince) noHandSince = now;
    if (noHandSince && now - noHandSince > 5000) {
      switchToCpuRecognition();
    }
    drawGuide();
    setGestureLabel(lastHandSeen ? "NO HAND" : "SHOW HAND", false);
    window.ParticleHeart?.setGestureState({ active: false });
    window.ParticleHeart?.setHandOpenness(0);
    window.ParticleGallery?.setPinch(0);
    fxTarget.active = false;
    lastPinch = false;
    pinchHoldStarted = 0;
    pinchConfirmed = false;
    lastHandCenter = null;
  }
}

function handleWorkerDetectionResult(message) {
  workerBusy = false;
  const request = pendingWorkerRequest;
  pendingWorkerRequest = null;
  if (!request || request.requestId !== message.requestId || !cameraRunning) return;
  handleDetectionResult(
    {
      landmarks: message.landmarks,
      handedness: message.handedness
    },
    request.mapping,
    performance.now()
  );
}

function handleWorkerDetectionError(message) {
  workerBusy = false;
  pendingWorkerRequest = null;
  if (!cameraRunning || detectionMode !== "worker") return;
  notify("手势追踪已切换至兼容模式");
  fallbackToThreadDetection();
}

async function fallbackToThreadDetection() {
  if (detectionMode === "thread") return;
  detectionMode = "initializing";
  detectionWorker?.terminate();
  detectionWorker = null;
  workerReady = false;
  workerInitPromise = null;
  preferCpuDelegate = true;
  try {
    await ensureLandmarker();
    detectionMode = "thread";
    lastVideoTime = -1;
    lastDetectionTime = 0;
  } catch {
    stopCamera(false);
    notify("手势识别初始化失败，请刷新页面");
  }
}

function recoverLandmarker() {
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = (async () => {
    try {
      preferCpuDelegate = true;
      handLandmarker?.close?.();
      handLandmarker = null;
      landmarkerPromise = null;
      lastVideoTime = -1;
      lastDetectionTime = 0;
      await ensureLandmarker();
      notify(`手势追踪已自动恢复 · ${detectorDelegate}`);
    } catch {
      stopCamera(false);
      notify("手势识别初始化失败，请刷新页面");
    } finally {
      recoveryPromise = null;
    }
  })();
  return recoveryPromise;
}

function switchToCpuRecognition() {
  if (detectionMode === "worker") {
    if (detectorDelegate.startsWith("GPU") && !cpuFallbackAttempted) {
      cpuFallbackAttempted = true;
      fallbackToThreadDetection();
    }
    return;
  }
  if (cpuFallbackAttempted || detectorDelegate === "CPU") return;
  cpuFallbackAttempted = true;
  recoverLandmarker();
}

async function requestBestCameraStream() {
  const preferred = isHandheldDevice
    ? [
        { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 } },
        { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } }
      ]
    : [
        { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 } },
        { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } }
      ];
  let lastError = null;

  for (const videoConstraints of preferred) {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "user" },
          ...videoConstraints
        }
      });
      const track = mediaStream.getVideoTracks()[0];
      if (track) {
        track.contentHint = "motion";
      }
      return mediaStream;
    } catch (error) {
      lastError = error;
      if (["NotAllowedError", "NotFoundError", "NotReadableError"].includes(error?.name)) {
        throw error;
      }
    }
  }

  throw lastError || new Error("CAMERA_CONSTRAINTS_FAILED");
}

function updateCameraQuality(track) {
  const settings = track?.getSettings?.() || {};
  const width = settings.width || video.videoWidth || 0;
  const height = settings.height || video.videoHeight || 0;
  const frameRate = Math.round(settings.frameRate || 0);
  const resolutionLabel = width >= 3200
    ? "4K"
    : width >= 1900
      ? "FHD"
      : width >= 1200
        ? "HD"
        : width
          ? `${width}×${height}`
          : "CAMERA";
  cameraQuality.textContent = `${resolutionLabel}${frameRate ? `/${frameRate}` : ""} · BEAUTY MAX`;
  cameraQuality.title = width && height
    ? `${width}×${height}${frameRate ? ` @ ${frameRate}fps` : ""} · 最高美颜`
    : "最高美颜";
}

function scheduleWorkerDetection(now) {
  if (!workerReady || workerBusy || !detectionWorker || video.readyState < 2) return;
  if (now - lastDetectionTime < 50) return;
  if (video.currentTime === lastVideoTime) return;

  lastDetectionTime = now;
  lastVideoTime = video.currentTime;
  const useCrop = Boolean(noHandSince && now - noHandSince > 850 && alternateCrop);
  alternateCrop = !alternateCrop;
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const cropScale = useCrop ? 0.76 : 1;
  const cropWidth = Math.round(sourceWidth * cropScale);
  const cropHeight = Math.round(sourceHeight * cropScale);
  const cropX = Math.round((sourceWidth - cropWidth) / 2);
  const cropY = Math.round((sourceHeight - cropHeight) / 2);
  const baseOutputWidth = isHandheldDevice ? 384 : 512;
  const outputWidth = useCrop ? baseOutputWidth + 48 : baseOutputWidth;
  const outputHeight = Math.max(1, Math.round(outputWidth * cropHeight / cropWidth));
  const mapping = useCrop ? {
    x: cropX / sourceWidth,
    y: cropY / sourceHeight,
    width: cropWidth / sourceWidth,
    height: cropHeight / sourceHeight
  } : null;
  const requestId = ++workerRequestId;

  workerBusy = true;
  pendingWorkerRequest = { requestId, mapping };
  createImageBitmap(
    video,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    {
      resizeWidth: outputWidth,
      resizeHeight: outputHeight,
      resizeQuality: "medium"
    }
  ).then((bitmap) => {
    if (!cameraRunning || detectionMode !== "worker" || !workerReady) {
      bitmap.close();
      workerBusy = false;
      pendingWorkerRequest = null;
      return;
    }
    detectionWorker.postMessage({
      type: "detect",
      requestId,
      bitmap,
      timestamp: Math.round(performance.now())
    }, [bitmap]);
  }).catch(() => {
    workerBusy = false;
    pendingWorkerRequest = null;
  });
}

function detect(now) {
  animationFrame = requestAnimationFrame(detect);
  if (!cameraRunning || video.readyState < 2) return;
  if (detectionMode === "worker") {
    scheduleWorkerDetection(now);
    return;
  }
  if (detectionMode !== "thread" || !handLandmarker) return;
  if (now - lastDetectionTime < 50) return;
  if (video.currentTime === lastVideoTime) return;

  lastDetectionTime = now;
  lastVideoTime = video.currentTime;
  try {
    const useCrop = Boolean(noHandSince && now - noHandSince > 850 && alternateCrop);
    alternateCrop = !alternateCrop;
    const { source, mapping } = prepareDetectionSource(useCrop);
    const result = handLandmarker.detectForVideo(source, Math.round(performance.now()));
    handleDetectionResult(result, mapping, now);
  } catch (error) {
    if (!recoveryPromise) {
      notify("正在重启手势追踪");
      recoverLandmarker();
    }
  }
}

async function startCamera() {
  if (cameraRunning || cameraStarting) return;
  cameraStarting = true;
  cameraButton.classList.add("is-loading");
  cameraButton.setAttribute("aria-busy", "true");
  setGestureLabel("CONNECTING", false);
  let slowNetworkTimer = 0;

  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("CAMERA_REQUIRES_LOCALHOST");
    }

    const enginePromise = prepareDetectionEngine()
      .then(() => null)
      .catch((error) => error);

    stream = await requestBestCameraStream();
    const videoTrack = stream.getVideoTracks()[0];
    video.srcObject = stream;
    await video.play();
    updateCameraQuality(videoTrack);
    handStage.classList.add("is-active");
    handStage.setAttribute("aria-hidden", "false");
    window.ParticleHeart?.setCameraActive(true);
    setGestureLabel("MODEL LOADING", false);
    slowNetworkTimer = window.setTimeout(() => {
      if (cameraStarting) {
        setGestureLabel("SLOW NETWORK", false);
        notify("首次加载手势模型约需 8MB，请保持页面打开");
      }
    }, 15000);

    const engineError = await enginePromise;
    if (engineError) throw engineError;
    cameraRunning = true;
    cameraStarting = false;
    window.clearTimeout(slowNetworkTimer);
    cameraButton.classList.remove("is-loading");
    cameraButton.removeAttribute("aria-busy");
    setGestureLabel("SHOW HAND", false);
    lastVideoTime = -1;
    lastDetectionTime = 0;
    cancelAnimationFrame(animationFrame);
    startFxCanvas();
    animationFrame = requestAnimationFrame(detect);
  } catch (error) {
    window.clearTimeout(slowNetworkTimer);
    cameraStarting = false;
    cameraButton.classList.remove("is-loading");
    cameraButton.removeAttribute("aria-busy");
    stopCamera(false);
    console.warn("[gesture] Camera or model initialization failed.", error);
    if (isEmbeddedBrowser && ["NotAllowedError", "SecurityError"].includes(error?.name)) {
      reportGestureProblem(
        "内置浏览器拦截了摄像头",
        "微信或抖音的内置浏览器可能禁止手势识别。请点右上角菜单，选择“在浏览器中打开”，再使用 Safari、Chrome 或 Edge，并允许摄像头权限。"
      );
    } else if (error?.message === "CAMERA_REQUIRES_LOCALHOST") {
      reportGestureProblem(
        "当前页面无法调用摄像头",
        "摄像头只能在 HTTPS 或 localhost 页面中启用。请确认地址以 https:// 开头，并使用系统浏览器打开。"
      );
    } else if (error?.name === "NotAllowedError") {
      reportGestureProblem(
        "摄像头权限未开启",
        "请在浏览器地址栏旁重新允许摄像头权限，然后刷新页面再点手势按钮。"
      );
    } else if (error?.name === "NotFoundError") {
      reportGestureProblem(
        "没有检测到摄像头",
        "当前设备没有可用摄像头，或摄像头正被其他应用占用。关闭其他相机应用后再试。"
      );
    } else if (["NotReadableError", "OverconstrainedError"].includes(error?.name)) {
      reportGestureProblem(
        "摄像头无法启动",
        "摄像头可能被其他应用占用，或当前浏览器不支持所选画质。关闭占用摄像头的应用后重试。"
      );
    } else {
      reportGestureProblem(
        "手势模型加载失败",
        "首次使用需要联网加载手势模型。请保持页面打开并检查网络，稍后再次点击相机按钮。"
      );
    }
  }
}

function stopCamera(notifyUser = true) {
  cameraRunning = false;
  cameraStarting = false;
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  lastHandSeen = 0;
  lastVideoTime = -1;
  lastPinch = false;
  pinchHoldStarted = 0;
  pinchConfirmed = false;
  lastGalleryPinch = 0;
  workerBusy = false;
  pendingWorkerRequest = null;
  baseline = null;
  swipeHistory = [];
  lastHandCenter = null;
  noHandSince = 0;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.pause();
  video.srcObject = null;
  clearOverlay();
  handStage.classList.remove("is-active");
  handStage.setAttribute("aria-hidden", "true");
  stopFxCanvas();
  cameraQuality.textContent = "CAMERA";
  cameraQuality.removeAttribute("title");
  cameraButton.classList.remove("is-loading");
  cameraButton.removeAttribute("aria-busy");
  setGestureLabel("STANDBY", false);
  window.ParticleHeart?.setGestureState({ active: false });
  window.ParticleHeart?.setHandOpenness(0);
  window.ParticleGallery?.setPinch(0);
  window.ParticleHeart?.setCameraActive(false);
  if (notifyUser) notify("手势控制已关闭");
}

window.addEventListener("particleheart:gesture-toggle", () => {
  if (cameraRunning || cameraStarting) {
    stopCamera();
  } else {
    startCamera();
  }
});

window.addEventListener("resize", () => {
  overlaySize = { width: 0, height: 0, ratio: 1 };
  if (cameraRunning) {
    ensureOverlaySize();
    resizeFxCanvas();
  }
});

window.addEventListener("beforeunload", () => {
  stopCamera(false);
  detectionWorker?.terminate();
});

window.__gestureModuleReady = true;
window.dispatchEvent(new CustomEvent("particleheart:gesture-ready"));

window.__particleGestureDiagnostics = () => ({
  secureContext: window.isSecureContext,
  embeddedBrowser: isEmbeddedBrowser,
  handheld: isHandheldDevice,
  cameraStarting,
  cameraRunning,
  detectionMode,
  detectorDelegate,
  workerReady,
  lastGestureProblem
});

function shouldPrewarmGestureEngine() {
  const connection = navigator.connection;
  if (connection?.saveData) return false;
  return !connection?.effectiveType || !/^(slow-2g|2g|3g)$/i.test(connection.effectiveType);
}

window.addEventListener("particleheart:unlocked", () => {
  if (!window.isSecureContext || !shouldPrewarmGestureEngine()) return;
  window.setTimeout(() => {
    if (cameraRunning || cameraStarting || workerReady) return;
    ensureDetectionWorker().catch((error) => {
      console.warn("[gesture] Background model preload failed.", error);
    });
  }, 1800);
}, { once: true });

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw-cleanup.js", { updateViaCache: "none" }).catch((error) => {
      console.warn("[gesture] Service worker registration failed.", error);
    });
  }, { once: true });
}

if (new URLSearchParams(window.location.search).has("test")) {
  window.__ParticleGestureTest = {
    processLandmarks(landmarks, now = performance.now()) {
      drawHand(landmarks);
      processHand(landmarks, now);
    },
    stopCamera
  };
}
