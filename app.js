const slider = document.querySelector("#diopter");
const sliderVisual = document.querySelector("#sliderVisual");
const sliderThumb = document.querySelector("#sliderThumb");
const valueLabel = document.querySelector("#diopterValue");
const stage = document.querySelector("#cameraStage");
const video = document.querySelector("#camera");
const capturedPhoto = document.querySelector("#capturedPhoto");
const blurredPhoto = document.querySelector("#blurredPhoto");
const depthStatus = document.querySelector("#depthStatus");
const startButton = document.querySelector("#startCamera");
const captureButton = document.querySelector("#capturePhoto");
const retakeButton = document.querySelector("#retakePhoto");
const controls = document.querySelector("#diopterControls");
const cameraSwitch = document.querySelector("#cameraSwitch");
const githubButton = document.querySelector("#githubButton");
const themeToggle = document.querySelector("#themeToggle");
const toast = document.querySelector("#toast");
const diopterStorageKey = "damagedEyesPov.diopter";
const themeStorageKey = "damagedEyesPov.theme";

let stream = null;
let facingMode = "environment";
let depthController = null;
let depthPromise = null;
let depthAbort = null;
let depthFailed = false;
let photoFrame = null;
let photoUrl = null;
let captureVersion = 0;
let toastTimer;

function updateSimulation() {
  const diopters = Number(slider.value);
  const formatted = Math.abs(diopters).toFixed(2);
  valueLabel.textContent = diopters < 0 ? `−${formatted}` : diopters > 0 ? `+${formatted}` : "0.00";
  const position = ((diopters + 10) / 20) * 100;
  sliderVisual.style.setProperty("--fill-start", `${diopters < 0 ? position : 50}%`);
  sliderVisual.style.setProperty("--fill-size", `${Math.abs(position - 50)}%`);
  sliderVisual.style.setProperty("--thumb-position", `${position}%`);
  depthController?.setDiopters(diopters);
  stage.classList.toggle("is-depth-active", Boolean(photoFrame && depthController && diopters !== 0));
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 10000);
}

function stopPhotoEffect() {
  captureVersion += 1;
  depthAbort?.abort(); depthAbort = null;
  depthController?.stop(); depthController = null; depthPromise = null; depthFailed = false;
  stage.classList.remove("is-depth-active");
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null; photoFrame = null;
  capturedPhoto.removeAttribute("src"); blurredPhoto.removeAttribute("src");
}

async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showToast("Camera access needs HTTPS, or localhost on this device."); return;
  }
  startButton.disabled = true; startButton.textContent = "Starting camera…";
  stopPhotoEffect();
  controls.hidden = true;
  stage.classList.remove("is-captured", "is-live", "is-depth-active");
  stream?.getTracks().forEach((track) => track.stop()); stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    video.srcObject = stream;
    await video.play();
    stage.classList.add("is-live");
    stage.classList.toggle("is-front-camera", facingMode === "user");
    depthStatus.textContent = "Frame your shot, then take a photo";
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop()); stream = null;
    const message = error.name === "NotAllowedError"
      ? "Camera access was denied. Allow camera access in your browser settings."
      : error.name === "NotFoundError" ? "No camera was found on this device." : "Could not start the camera. Please try again.";
    showToast(message);
  } finally {
    startButton.disabled = false; startButton.textContent = "Turn on camera";
  }
}

async function capturePhoto() {
  if (!stream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  captureButton.disabled = true;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (facingMode === "user") { context.translate(canvas.width, 0); context.scale(-1, 1); }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  photoFrame = canvas;
  try {
    const blob = await new Promise((resolve, reject) => canvas.toBlob((image) => image ? resolve(image) : reject(new Error("Photo capture failed")), "image/jpeg", 0.94));
    photoUrl = URL.createObjectURL(blob);
    capturedPhoto.src = photoUrl; blurredPhoto.src = photoUrl;
    stage.classList.remove("is-live"); stage.classList.add("is-captured");
    video.srcObject = null;
    stream.getTracks().forEach((track) => track.stop()); stream = null;
    controls.hidden = false;
    depthStatus.textContent = "Estimating scene depth…";
    ensureDepthSimulation();
  } catch (error) { showToast(error.message || "Could not capture this photo."); }
  finally { captureButton.disabled = false; }
}

async function startDepthSimulation(frame, version) {
  try {
    const { createDepthEffect } = await import("./depth-effect.js");
    const controller = await createDepthEffect(frame, blurredPhoto, stage, () => Number(slider.value), (message) => { depthStatus.textContent = message; }, depthAbort?.signal);
    if (captureVersion !== version || photoFrame !== frame) { controller.stop(); return; }
    depthController = controller;
    depthController.setDiopters(Number(slider.value));
    depthStatus.textContent = "Scene depth ready — adjust the diopter";
    stage.classList.toggle("is-depth-active", Number(slider.value) !== 0);
  } catch (error) {
    console.error("Depth estimation could not start:", error);
    if (captureVersion === version) { depthFailed = true; depthStatus.textContent = "Depth estimation unavailable — check your internet connection"; }
  }
}

function ensureDepthSimulation() {
  if (!photoFrame || depthController || depthPromise || depthFailed) return;
  const frame = photoFrame; const version = captureVersion;
  depthAbort = new AbortController();
  const task = startDepthSimulation(frame, version);
  const wrapped = task.finally(() => { if (depthPromise === wrapped) depthPromise = null; });
  depthPromise = wrapped;
}

captureButton.addEventListener("click", capturePhoto);
retakeButton.addEventListener("click", startCamera);
slider.addEventListener("input", () => {
  updateSimulation();
  try { localStorage.setItem(diopterStorageKey, slider.value); } catch { /* Keep the control usable without storage. */ }
});
function setSliderFromPointer(event) {
  const bounds = sliderVisual.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const min = Number(slider.min); const max = Number(slider.max); const step = Number(slider.step) || 0.05;
  slider.value = String(Number((min + Math.round((ratio * (max - min)) / step) * step).toFixed(2)));
  slider.dispatchEvent(new Event("input", { bubbles: true }));
}
sliderThumb.addEventListener("pointerdown", (event) => { event.preventDefault(); sliderThumb.setPointerCapture(event.pointerId); setSliderFromPointer(event); });
sliderThumb.addEventListener("pointermove", (event) => { if (sliderThumb.hasPointerCapture(event.pointerId)) setSliderFromPointer(event); });
let wheelRemainder = 0;
slider.parentElement.addEventListener("wheel", (event) => {
  if (!matchMedia("(pointer: fine)").matches) return;
  event.preventDefault(); wheelRemainder += event.deltaY;
  const steps = Math.trunc(wheelRemainder / 100); if (!steps) return;
  wheelRemainder -= steps * 100;
  slider.value = String(Number((Number(slider.value) - steps * (Number(slider.step) || 0.05)).toFixed(2)));
  slider.dispatchEvent(new Event("input", { bubbles: true }));
}, { passive: false });
startButton.addEventListener("click", startCamera);
cameraSwitch.addEventListener("click", () => { if (stream) { facingMode = facingMode === "environment" ? "user" : "environment"; startCamera(); } });
githubButton.addEventListener("click", () => showToast("GitHub link coming soon."));
function setTheme(theme) {
  const light = theme === "light"; document.documentElement.dataset.theme = light ? "light" : "dark";
  const next = light ? "dark" : "light";
  themeToggle.setAttribute("aria-label", `Switch to ${next} mode`); themeToggle.title = `Switch to ${next} mode`;
  themeToggle.setAttribute("aria-pressed", String(light));
}
themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light"; setTheme(next);
  try { localStorage.setItem(themeStorageKey, next); } catch { /* Theme stays active for this session. */ }
});
window.addEventListener("pagehide", () => { depthController?.stop(); stream?.getTracks().forEach((track) => track.stop()); if (photoUrl) URL.revokeObjectURL(photoUrl); });

try {
  const savedTheme = localStorage.getItem(themeStorageKey);
  if (savedTheme === "light" || savedTheme === "dark") setTheme(savedTheme);
  const saved = Number(localStorage.getItem(diopterStorageKey));
  if (localStorage.getItem(diopterStorageKey) !== null && Number.isFinite(saved) && saved >= -10 && saved <= 10) slider.value = String(saved);
} catch { /* Use defaults when storage is unavailable. */ }
updateSimulation();
