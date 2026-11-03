const MAX_OUTPUT_EDGE = 720;
const MAX_INFERENCE_EDGE = 336;
const INFERENCE_INTERVAL_MS = 850;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (edge0, edge1, value) => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

export async function createDepthEffect(video, outputCanvas, getDiopters, isMirrored, onStatus = () => {}) {
  const worker = new Worker(new URL("./depth-worker.js", import.meta.url), { type: "module" });
  let stopped = false;
  let inferenceBusy = false;
  let lastInferenceAt = 0;
  let relativeDepth = null;
  let depthWidth = 0;
  let depthHeight = 0;
  let smoothedAlpha = null;
  let diopters = getDiopters();
  let frameRequest = 0;
  let lastRenderedAt = 0;
  let resolveFirstDepth;
  let rejectFirstDepth;
  let lastStatus = "";

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
  const modelReady = new Promise((resolve, reject) => {
    worker.addEventListener("message", function onReady(event) {
      const message = event.data;
      if (message.type === "ready") {
        worker.removeEventListener("message", onReady);
        resolve();
      } else if (message.type === "error") {
        worker.removeEventListener("message", onReady);
        reject(new Error(message.message));
      } else if (message.type === "status") {
        report(message.message);
      } else if (message.type === "progress") {
        report(`Loading depth model… ${Math.round(message.progress)}%`);
      }
    });
    worker.addEventListener("error", (event) => reject(new Error(event.message || "Depth worker failed to start")), { once: true });
  });

  if (!video.videoWidth || !video.videoHeight) {
    await new Promise((resolve) => video.addEventListener("loadedmetadata", resolve, { once: true }));
  }

  const outputScale = Math.min(1, MAX_OUTPUT_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.max(2, Math.round(video.videoWidth * outputScale));
  const height = Math.max(2, Math.round(video.videoHeight * outputScale));
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputContext = outputCanvas.getContext("2d", { alpha: false });

  const blurredCanvas = document.createElement("canvas");
  blurredCanvas.width = width;
  blurredCanvas.height = height;
  const blurredContext = blurredCanvas.getContext("2d");

  const maskCanvas = document.createElement("canvas");
  const maskContext = maskCanvas.getContext("2d");

  const inferenceScale = Math.min(1, MAX_INFERENCE_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const inferenceWidth = Math.max(14, Math.round(video.videoWidth * inferenceScale / 14) * 14);
  const inferenceHeight = Math.max(14, Math.round(video.videoHeight * inferenceScale / 14) * 14);
  const inferenceCanvas = document.createElement("canvas");
  inferenceCanvas.width = inferenceWidth;
  inferenceCanvas.height = inferenceHeight;
  const inferenceContext = inferenceCanvas.getContext("2d", { willReadFrequently: true });

  function drawCameraFrame(context, targetWidth, targetHeight) {
    context.save();
    if (isMirrored()) {
      context.translate(targetWidth, 0);
      context.scale(-1, 1);
    }
    context.drawImage(video, 0, 0, targetWidth, targetHeight);
    context.restore();
  }

  function updateMask() {
    if (!relativeDepth) return;
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
      const target = diopters < 0 ? 1 - nearWeight : diopters > 0 ? nearWeight : 0;
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
  worker.addEventListener("message", handleWorkerMessage);
  worker.postMessage({ type: "init", preferWebGPU: Boolean(navigator.gpu) });
  report("Loading the depth model on this device…");
  try {
    await modelReady;
  } catch (error) {
    worker.terminate();
    throw error;
  }
  report("Estimating scene depth…");

  function estimateFrame() {
    if (stopped || inferenceBusy || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    inferenceBusy = true;
    drawCameraFrame(inferenceContext, inferenceWidth, inferenceHeight);
    const frame = inferenceContext.getImageData(0, 0, inferenceWidth, inferenceHeight);
    lastInferenceAt = performance.now();
    worker.postMessage({ type: "frame", pixels: frame.data.buffer, width: inferenceWidth, height: inferenceHeight }, [frame.data.buffer]);
  }

  function render(now) {
    if (stopped) return;
    if (now - lastRenderedAt >= 42 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      lastRenderedAt = now;
      drawCameraFrame(outputContext, width, height);
      if (relativeDepth && Math.abs(diopters) > 0) {
        const amount = Math.abs(diopters) / 10;
        blurredContext.clearRect(0, 0, width, height);
        blurredContext.filter = `blur(${(Math.pow(amount, 1.15) * Math.min(10, width * 0.014)).toFixed(2)}px)`;
        drawCameraFrame(blurredContext, width, height);
        blurredContext.filter = "none";
        blurredContext.globalCompositeOperation = "destination-in";
        blurredContext.drawImage(maskCanvas, 0, 0, width, height);
        blurredContext.globalCompositeOperation = "source-over";
        outputContext.drawImage(blurredCanvas, 0, 0);
      }
      if (Math.abs(diopters) > 0 && !inferenceBusy && now - lastInferenceAt >= INFERENCE_INTERVAL_MS) estimateFrame();
    }
    frameRequest = requestAnimationFrame(render);
  }

  try {
    estimateFrame();
    await firstDepth;
  } catch (error) {
    worker.terminate();
    throw error;
  }
  if (stopped) {
    worker.terminate();
    throw new Error("Depth simulation stopped before startup finished.");
  }
  if (Math.abs(diopters) > 0) frameRequest = requestAnimationFrame(render);

  return {
    setDiopters(value) {
      diopters = Number(value) || 0;
      updateMask();
      if (Math.abs(diopters) === 0) {
        cancelAnimationFrame(frameRequest);
        frameRequest = 0;
        return;
      }
      if (!relativeDepth) estimateFrame();
      if (!frameRequest) frameRequest = requestAnimationFrame(render);
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(frameRequest);
      worker.terminate();
    },
  };
}
