import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";

const MODEL_ID = "onnx-community/depth-anything-v2-small";
const MAX_INFERENCE_EDGE = 448;
const INFERENCE_INTERVAL_MS = 500;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (edge0, edge1, value) => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

export async function createDepthEffect(video, outputCanvas, getDiopters, isMirrored, onStatus = () => {}) {
  onStatus("Loading the on-device depth model…");

  let estimateDepth;
  if (navigator.gpu) {
    try {
      estimateDepth = await pipeline("depth-estimation", MODEL_ID, { device: "webgpu" });
    } catch (error) {
      console.warn("WebGPU depth estimation unavailable; using WASM.", error);
    }
  }
  if (!estimateDepth) estimateDepth = await pipeline("depth-estimation", MODEL_ID);

  if (!video.videoWidth || !video.videoHeight) {
    await new Promise((resolve) => video.addEventListener("loadedmetadata", resolve, { once: true }));
  }

  const maxOutputEdge = 1280;
  const outputScale = Math.min(1, maxOutputEdge / Math.max(video.videoWidth, video.videoHeight));
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
  const maskContext = maskCanvas.getContext("2d", { willReadFrequently: false });
  const inferenceCanvas = document.createElement("canvas");
  const inferenceScale = Math.min(1, MAX_INFERENCE_EDGE / Math.max(video.videoWidth, video.videoHeight));
  inferenceCanvas.width = Math.max(14, Math.round(video.videoWidth * inferenceScale / 14) * 14);
  inferenceCanvas.height = Math.max(14, Math.round(video.videoHeight * inferenceScale / 14) * 14);
  const inferenceContext = inferenceCanvas.getContext("2d", { willReadFrequently: false });

  let stopped = false;
  let frameRequest = 0;
  let lastRenderedAt = 0;
  let inferenceBusy = false;
  let lastInferenceAt = 0;
  let relativeDepth = null;
  let depthWidth = 0;
  let depthHeight = 0;
  let smoothedAlpha = null;
  let lastStatus = "";
  let diopters = getDiopters();

  const report = (message) => {
    if (message !== lastStatus) {
      lastStatus = message;
      onStatus(message);
    }
  };

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
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < count; i += 1) {
      const value = relativeDepth[i];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const span = Math.max(1, max - min);
    const image = maskContext.createImageData(depthWidth, depthHeight);
    if (!smoothedAlpha || smoothedAlpha.length !== count) smoothedAlpha = new Float32Array(count);

    const isNearBlur = diopters > 0;
    const cutoff = isNearBlur ? 0.82 - amount * 0.42 : 0.18 + amount * 0.46;
    const softness = 0.12;
    for (let i = 0; i < count; i += 1) {
      // Depth Anything V2's relative map is brighter for nearer regions.
      const nearScore = (relativeDepth[i] - min) / span;
      const nearWeight = smoothstep(cutoff - softness / 2, cutoff + softness / 2, nearScore);
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

  async function estimateFrame() {
    if (stopped || inferenceBusy || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    inferenceBusy = true;
    lastInferenceAt = performance.now();
    try {
      drawCameraFrame(inferenceContext, inferenceCanvas.width, inferenceCanvas.height);
      const result = await estimateDepth(inferenceCanvas);
      const depth = result.depth;
      const channels = depth.channels || Math.max(1, Math.floor(depth.data.length / (depth.width * depth.height)));
      const count = depth.width * depth.height;
      const values = new Uint8Array(count);
      for (let i = 0; i < count; i += 1) values[i] = depth.data[i * channels];
      relativeDepth = values;
      depthWidth = depth.width;
      depthHeight = depth.height;
      updateMask();
      report("Depth-aware blur active");
    } catch (error) {
      console.warn("Depth estimation frame failed:", error);
      report("Estimating scene depth…");
    } finally {
      inferenceBusy = false;
    }
  }

  function render(now) {
    if (stopped) return;
    if (now - lastRenderedAt >= 33 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      lastRenderedAt = now;
      drawCameraFrame(outputContext, width, height);
      if (relativeDepth && Math.abs(diopters) > 0) {
        const amount = Math.abs(diopters) / 10;
        blurredContext.clearRect(0, 0, width, height);
        blurredContext.filter = `blur(${(Math.pow(amount, 1.15) * Math.min(14, width * 0.011)).toFixed(2)}px)`;
        drawCameraFrame(blurredContext, width, height);
        blurredContext.filter = "none";
        blurredContext.globalCompositeOperation = "destination-in";
        blurredContext.drawImage(maskCanvas, 0, 0, width, height);
        blurredContext.globalCompositeOperation = "source-over";
        outputContext.drawImage(blurredCanvas, 0, 0);
      }
      if (Math.abs(diopters) > 0 && now - lastInferenceAt >= INFERENCE_INTERVAL_MS) {
        void estimateFrame();
      }
    }
    frameRequest = requestAnimationFrame(render);
  }

  report("Estimating scene depth…");
  await estimateFrame();
  if (stopped) throw new Error("Depth simulation stopped before startup finished.");
  frameRequest = requestAnimationFrame(render);

  return {
    setDiopters(value) {
      diopters = Number(value) || 0;
      updateMask();
      if (Math.abs(diopters) > 0 && !relativeDepth) void estimateFrame();
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(frameRequest);
    },
  };
}
