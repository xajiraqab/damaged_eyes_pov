import { env, pipeline, RawImage } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";

const MODEL_ID = "onnx-community/depth-anything-v2-small";
let estimator = null;
let frameBusy = false;

env.backends.onnx.wasm.numThreads = 1;

function reportProgress(event) {
  if (event.status === "progress" && Number.isFinite(event.progress)) {
    self.postMessage({ type: "progress", progress: event.progress });
  }
}

async function loadEstimator(preferWebGPU) {
  if (preferWebGPU) {
    self.postMessage({ type: "status", message: "Loading the smaller GPU model…" });
    try {
      estimator = await pipeline("depth-estimation", MODEL_ID, {
        device: "webgpu",
        dtype: "q4f16",
        progress_callback: reportProgress,
      });
    } catch (error) {
      console.warn("WebGPU model unavailable; falling back to WASM.", error);
    }
  }
  if (!estimator) {
    self.postMessage({ type: "status", message: "Loading the compatible CPU model…" });
    estimator = await pipeline("depth-estimation", MODEL_ID, {
      dtype: "q8",
      progress_callback: reportProgress,
    });
  }
  self.postMessage({ type: "ready" });
}

async function estimateFrame({ pixels, width, height }) {
  if (!estimator || frameBusy) return;
  frameBusy = true;
  try {
    const rgba = new Uint8ClampedArray(pixels);
    const image = new RawImage(rgba, width, height, 4).rgb();
    const { depth } = await estimator(image);
    const source = depth.data;
    let data;
    if (source instanceof Uint8Array || source instanceof Uint8ClampedArray) {
      data = new Uint8Array(source);
    } else {
      let min = Infinity;
      let max = -Infinity;
      for (const value of source) { min = Math.min(min, value); max = Math.max(max, value); }
      const range = Math.max(1e-6, max - min);
      data = new Uint8Array(source.length);
      for (let i = 0; i < source.length; i += 1) data[i] = Math.round(((source[i] - min) / range) * 255);
    }
    self.postMessage({
      type: "depth",
      pixels: data.buffer,
      width: depth.width,
      height: depth.height,
      channels: depth.channels || 1,
    }, [data.buffer]);
  } catch (error) {
    self.postMessage({ type: "frame-error", message: error?.message || "Depth estimation failed" });
  } finally {
    frameBusy = false;
  }
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "init") {
    loadEstimator(message.preferWebGPU).catch((error) => {
      self.postMessage({ type: "error", message: error?.message || "Could not load the depth model" });
    });
  } else if (message.type === "frame") {
    void estimateFrame(message);
  }
});
