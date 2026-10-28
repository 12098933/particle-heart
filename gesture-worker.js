let handLandmarker = null;
let detectorDelegate = "CPU";

function reportError(requestId, error) {
  self.postMessage({
    type: "detection-error",
    requestId,
    message: error instanceof Error ? error.message : String(error)
  });
}

async function initialize(message) {
  try {
    self.postMessage({ type: "init-progress", stage: "bundle" });
    const { FilesetResolver, HandLandmarker } = await import(message.bundlePath);
    self.postMessage({ type: "init-progress", stage: "runtime" });
    const visionFiles = await FilesetResolver.forVisionTasks(message.wasmPath);
    self.postMessage({ type: "init-progress", stage: "model" });
    const options = {
      baseOptions: {
        modelAssetPath: message.modelPath,
        delegate: "CPU"
      },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.2,
      minHandPresenceConfidence: 0.24,
      minTrackingConfidence: 0.18
    };

    try {
      handLandmarker = await HandLandmarker.createFromOptions(visionFiles, options);
      detectorDelegate = "CPU";
    } catch {
      options.baseOptions.delegate = "GPU";
      handLandmarker = await HandLandmarker.createFromOptions(visionFiles, options);
      detectorDelegate = "GPU";
    }

    self.postMessage({
      type: "ready",
      delegate: detectorDelegate
    });
  } catch (error) {
    self.postMessage({
      type: "init-error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

self.onmessage = (event) => {
  const message = event.data;

  if (message.type === "init") {
    initialize(message);
    return;
  }

  if (message.type === "detect") {
    const bitmap = message.bitmap;
    if (!handLandmarker) {
      bitmap?.close?.();
      reportError(message.requestId, new Error("HAND_LANDMARKER_NOT_READY"));
      return;
    }

    try {
      const result = handLandmarker.detectForVideo(bitmap, message.timestamp);
      const handedness = (result.handedness || []).map((entries) =>
        entries.map((entry) => ({
          score: entry.score,
          index: entry.index,
          categoryName: entry.categoryName,
          displayName: entry.displayName
        }))
      );
      self.postMessage({
        type: "detection-result",
        requestId: message.requestId,
        landmarks: result.landmarks || [],
        handedness,
        timestamp: message.timestamp
      });
    } catch (error) {
      reportError(message.requestId, error);
    } finally {
      bitmap?.close?.();
    }
  }
};
