const MAX_INFERENCE_EDGE = 518;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// One depth pass per still photo. All later slider updates only rebuild a mask,
// so the browser never has to run inference while the user drags the control.
export async function createDepthEffect(photoCanvas, blurredPhoto, stage, getDiopters, onStatus = () => {}, signal) {
  const worker = new Worker(new URL("./depth-worker.js", import.meta.url), { type: "module" });
  const scale = Math.min(1, MAX_INFERENCE_EDGE / Math.max(photoCanvas.width, photoCanvas.height));
  const width = Math.max(14, Math.round(photoCanvas.width * scale / 14) * 14);
  const height = Math.max(14, Math.round(photoCanvas.height * scale / 14) * 14);
  const input = document.createElement("canvas"); input.width = width; input.height = height;
  const inputContext = input.getContext("2d", { willReadFrequently: true });
  inputContext.drawImage(photoCanvas, 0, 0, width, height);
  const pixels = inputContext.getImageData(0, 0, width, height).data;
  const maskCanvas = document.createElement("canvas");
  const maskContext = maskCanvas.getContext("2d");
  const featherCanvas = document.createElement("canvas");
  const featherContext = featherCanvas.getContext("2d");
  let maskPixels = null; let maskWidth = 0; let maskHeight = 0; let maskUrl = null; let stopped = false;
  let diopters = Number(getDiopters()) || 0; let version = 0; let maskTimer = 0;
  const report = (message) => { if (!stopped) onStatus(message); };
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => { stopped = true; worker.terminate(); rejectAbort(new Error("Photo processing cancelled")); };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  const depthReady = new Promise((resolve, reject) => {
    const onError = (event) => { cleanup(); reject(new Error(event.message || "Depth worker failed")); };
    const cleanup = () => { worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); };
    const onMessage = (event) => {
      const message = event.data;
      if (message.type === "status") report(message.message);
      if (message.type === "progress") report(`Loading depth model… ${Math.round(message.progress)}%`);
      if (message.type === "error") { cleanup(); reject(new Error(message.message)); }
      if (message.type === "depth") { cleanup(); maskPixels = new Uint8Array(message.pixels); maskWidth = message.width; maskHeight = message.height; resolve(); }
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError, { once: true });
  });

  worker.postMessage({ type: "init", preferWebGPU: Boolean(navigator.gpu) });
  report("Loading depth model on this device…");
  await Promise.race([new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.data.type === "ready") { worker.removeEventListener("message", onMessage); resolve(); }
      if (event.data.type === "error") { worker.removeEventListener("message", onMessage); reject(new Error(event.data.message)); }
    };
    worker.addEventListener("message", onMessage);
  }), aborted]);
  if (stopped) { worker.terminate(); throw new Error("Photo was discarded"); }
  report("Estimating scene depth…");
  worker.postMessage({ type: "frame", pixels: pixels.buffer, width, height }, [pixels.buffer]);
  await Promise.race([depthReady, aborted]);

  function updateMask() {
    if (stopped || !maskPixels) return;
    const amount = Math.abs(diopters) / 10;
    // Blur strength increases nonlinearly with refractive error, like the
    // growing circle of confusion away from a chosen focus distance.
    stage.style.setProperty("--depth-blur", `${(Math.pow(amount, 1.35) * 30).toFixed(1)}px`);
    if (amount === 0) { stage.style.setProperty("--depth-mask", "none"); return; }
    const image = maskContext.createImageData(maskWidth, maskHeight);
    // Use a narrow depth transition to avoid ghosting from a broad blend of
    // sharp and blurred copies. Spatial feathering below softens object edges.
    // Expand the affected depth band on both sides of zero so near blur for
    // positive values and far blur for negative values do not become thin,
    // isolated strips beside abruptly sharp areas.
    const depthShift = 75 * Math.pow(amount, 0.7);
    const cutoff = diopters < 0 ? 96 + depthShift : 159 - depthShift;
    const feather = 10 + amount * 10;
    for (let i = 0; i < maskPixels.length; i++) {
      const near = maskPixels[i];
      const focus = smoothstep(cutoff - feather, cutoff + feather, near);
      const alpha = diopters < 0 ? 1 - focus : focus;
      const o = i * 4; image.data[o] = image.data[o + 1] = image.data[o + 2] = 255;
      image.data[o + 3] = Math.round(alpha * 255);
    }
    maskCanvas.width = maskWidth; maskCanvas.height = maskHeight;
    maskContext.putImageData(image, 0, 0);
    // Upscale the soft depth edge to the captured photo's full resolution
    // before applying a small spatial feather, avoiding stair-stepped halos.
    const outputScale = Math.min(1, 1024 / Math.max(photoCanvas.width, photoCanvas.height));
    featherCanvas.width = Math.round(photoCanvas.width * outputScale);
    featherCanvas.height = Math.round(photoCanvas.height * outputScale);
    featherContext.clearRect(0, 0, featherCanvas.width, featherCanvas.height);
    featherContext.filter = `blur(${Math.max(2, Math.round(featherCanvas.width / 360))}px)`;
    featherContext.drawImage(maskCanvas, 0, 0, featherCanvas.width, featherCanvas.height);
    featherContext.filter = "none";
    const current = ++version;
    featherCanvas.toBlob((blob) => {
      if (!blob || stopped || current !== version) return;
      const next = URL.createObjectURL(blob); const previous = maskUrl; maskUrl = next;
      stage.style.setProperty("--depth-mask", `url("${next}")`);
      if (previous) URL.revokeObjectURL(previous);
    }, "image/png");
  }

  return {
    setDiopters(value) {
      diopters = Number(value) || 0;
      clearTimeout(maskTimer);
      if (diopters === 0) updateMask();
      else maskTimer = window.setTimeout(updateMask, 45);
    },
    stop() { stopped = true; clearTimeout(maskTimer); signal?.removeEventListener("abort", abort); worker.terminate(); stage.style.setProperty("--depth-mask", "none"); if (maskUrl) URL.revokeObjectURL(maskUrl); },
  };
}
