const MAX_INFERENCE_EDGE = 336;
const INFERENCE_INTERVAL_MS = 1800;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (edge0, edge1, value) => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

export async function createDepthEffect(video, blurVideo, stage, getDiopters, onStatus = () => {}) {
  const worker = new Worker(new URL("./depth-worker.js", import.meta.url), { type: "module" });
  const inferenceScale = Math.min(1, MAX_INFERENCE_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const inferenceWidth = Math.max(14, Math.round(video.videoWidth * inferenceScale / 14) * 14);
  const inferenceHeight = Math.max(14, Math.round(video.videoHeight * inferenceScale / 14) * 14);
  const inferenceCanvas = document.createElement("canvas");
  inferenceCanvas.width = inferenceWidth;
  inferenceCanvas.height = inferenceHeight;
  const inferenceContext = inferenceCanvas.getContext("2d", { willReadFrequently: true });
  const maskCanvas = document.createElement("canvas");
  const maskContext = maskCanvas.getContext("2d");

  let stopped = false;
  let inferenceBusy = false;
  let lastInferenceAt = 0;
  let relativeDepth = null;
  let depthWidth = 0;
  let depthHeight = 0;
  let smoothedAlpha = null;
  let diopters = getDiopters();
  let firstMaskUrl = null;
  let maskVersion = 0;
  let lastStatus = "";
  let resolveFirstDepth;
  let rejectFirstDepth;
  let inferenceTimer = 0;
  let maskUpdateTimer = 0;

  const report = (message) => {
    if (message !== lastStatus) {
      lastStatus = message;
      onStatus(message);
    }
  };
  const firstDepth = new Promise((resolve, reject) => {
    resolveFirstDepth = resolve;
    rejectFirstDepth = reject;
  });

  function updateBlur() {
    const amount = Math.abs(diopters) / 10;
    const radius = Math.pow(amount, 1.15) * 7;
    stage.style.setProperty("--depth-blur", `${radius.toFixed(2)}px`);
  }

  function updateMask() {
    if (!relativeDepth || diopters === 0) {
      stage.style.setProperty("--depth-mask", "none");
      return;
    }

    const amount = Math.abs(diopters) / 10;
    const count = depthWidth * depthHeight;
    let min = 255;
    let max = 0;
    for (let i = 0; i < count; i += 1) {
      min = Math.min(min, relativeDepth[i]);
      max = Math.max(max, relativeDepth[i]);
    }
    const span = Math.max(1, max - min);
    const image = maskContext.createImageData(depthWidth, depthHeight);
    if (!smoothedAlpha || smoothedAlpha.length !== count) smoothedAlpha = new Float32Array(count);
    const cutoff = diopters > 0 ? 0.82 - amount * 0.42 : 0.18 + amount * 0.46;

    for (let i = 0; i < count; i += 1) {
      const nearScore = (relativeDepth[i] - min) / span;
      const nearWeight = smoothstep(cutoff - 0.06, cutoff + 0.06, nearScore);
      const target = diopters < 0 ? 1 - nearWeight : nearWeight;
      const alpha = smoothedAlpha[i] * 0.55 + target * 0.45;
      smoothedAlpha[i] = alpha;
      const offset = i * 4;
      image.data[offset] = 255;
      image.data[offset + 1] = 255;
      image.data[offset + 2] = 255;
      image.data[offset + 3] = Math.round(alpha * 255);
    }

    maskCanvas.width = depthWidth;
    maskCanvas.height = depthHeight;
    maskContext.putImageData(image, 0, 0);
    const version = ++maskVersion;
    maskCanvas.toBlob((blob) => {
      if (!blob || stopped || version !== maskVersion || diopters === 0) return;
      const nextUrl = URL.createObjectURL(blob);
      const previousUrl = firstMaskUrl;
      firstMaskUrl = nextUrl;
      stage.style.setProperty("--depth-mask", `url("${nextUrl}")`);
      if (previousUrl) setTimeout(() => URL.revokeObjectURL(previousUrl), 1500);
    }, "image/png");
  }

  function drawInferenceFrame() {
    inferenceContext.drawImage(video, 0, 0, inferenceWidth, inferenceHeight);
  }

  function handleWorkerMessage(event) {
    const message = event.data;
    if (message.type === "status") report(message.message);
    if (message.type === "progress") report(`Loading depth model… ${Math.round(message.progress)}%`);
    if (message.type === "depth") {
      inferenceBusy = false;
      relativeDepth = new Uint8Array(message.pixels);
      depthWidth = message.width;
      depthHeight = message.height;
      updateMask();
      lastInferenceAt = performance.now();
      report("Depth-aware blur active");
      resolveFirstDepth?.();
      resolveFirstDepth = null;
      rejectFirstDepth = null;
    }
    if (message.type === "frame-error") {
      inferenceBusy = false;
      report("Depth update paused — retrying");
      rejectFirstDepth?.(new Error(message.message));
      rejectFirstDepth = null;
      resolveFirstDepth = null;
    }
    if (message.type === "error") {
      rejectFirstDepth?.(new Error(message.message));
      rejectFirstDepth = null;
      resolveFirstDepth = null;
    }
  }

  const modelReady = new Promise((resolve, reject) => {
    worker.addEventListener("message", function onReady(event) {
      if (event.data.type === "ready") {
        worker.removeEventListener("message", onReady);
        resolve();
      } else if (event.data.type === "error") {
        worker.removeEventListener("message", onReady);
        reject(new Error(event.data.message));
      } else if (event.data.type === "status") {
        report(event.data.message);
      } else if (event.data.type === "progress") {
        report(`Loading depth model… ${Math.round(event.data.progress)}%`);
      }
    });
    worker.addEventListener("error", (event) => reject(new Error(event.message || "Depth worker failed to start")), { once: true });
  });

  worker.addEventListener("message", handleWorkerMessage);
  worker.postMessage({ type: "init", preferWebGPU: Boolean(navigator.gpu) });
  report("Loading the depth model on this device…");
  try {
    await modelReady;
  } catch (error) {
    worker.terminate();
    throw error;
  }

  function estimateFrame() {
    if (stopped || inferenceBusy || diopters === 0 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    inferenceBusy = true;
    drawInferenceFrame();
    const frame = inferenceContext.getImageData(0, 0, inferenceWidth, inferenceHeight);
    lastInferenceAt = performance.now();
    worker.postMessage({ type: "frame", pixels: frame.data.buffer, width: inferenceWidth, height: inferenceHeight }, [frame.data.buffer]);
  }

  report("Estimating scene depth…");
  estimateFrame();
  try {
    await firstDepth;
  } catch (error) {
    worker.terminate();
    throw error;
  }
  if (stopped) {
    worker.terminate();
    throw new Error("Depth simulation stopped before startup finished.");
  }

  inferenceTimer = window.setInterval(() => {
    if (diopters !== 0 && !inferenceBusy && performance.now() - lastInferenceAt >= INFERENCE_INTERVAL_MS) estimateFrame();
  }, 250);

  return {
    setDiopters(value) {
      diopters = Number(value) || 0;
      updateBlur();
      clearTimeout(maskUpdateTimer);
      if (diopters === 0) updateMask();
      else maskUpdateTimer = window.setTimeout(updateMask, 100);
      if (diopters !== 0 && !relativeDepth) estimateFrame();
      else if (diopters !== 0 && performance.now() - lastInferenceAt >= INFERENCE_INTERVAL_MS) estimateFrame();
    },
    stop() {
      stopped = true;
      clearInterval(inferenceTimer);
      clearTimeout(maskUpdateTimer);
      worker.terminate();
      stage.style.setProperty("--depth-mask", "none");
      if (firstMaskUrl) URL.revokeObjectURL(firstMaskUrl);
    },
  };
}
