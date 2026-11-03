const slider = document.querySelector("#diopter");
const sliderVisual = document.querySelector("#sliderVisual");
const sliderThumb = document.querySelector("#sliderThumb");
const valueLabel = document.querySelector("#diopterValue");
const stage = document.querySelector("#cameraStage");
const video = document.querySelector("#camera");
const blurVideo = document.querySelector("#blurCamera");
const depthStatus = document.querySelector("#depthStatus");
const startButton = document.querySelector("#startCamera");
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
let depthFailed = false;
let toastTimer;

function updateSimulation() {
  const diopters = Number(slider.value);
  const formattedDiopters = Math.abs(diopters).toFixed(2);
  valueLabel.textContent = diopters < 0 ? `−${formattedDiopters}` : diopters > 0 ? `+${formattedDiopters}` : "0.00";
  const position = ((diopters + 10) / 20) * 100;
  const fillStart = diopters < 0 ? position : 50;
  const fillSize = Math.abs(position - 50);
  sliderVisual.style.setProperty("--fill-start", `${fillStart}%`);
  sliderVisual.style.setProperty("--fill-size", `${fillSize}%`);
  sliderVisual.style.setProperty("--thumb-position", `${position}%`);

  depthController?.setDiopters(diopters);
  if (depthController) stage.classList.toggle("is-depth-active", diopters !== 0);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 10000);
}

async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showToast("Camera access needs HTTPS, or localhost on this device.");
    return;
  }
  startButton.disabled = true;
  startButton.textContent = "Starting camera…";
  depthController?.stop();
  depthController = null;
  stage.classList.remove("is-depth-active", "is-live");
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  depthFailed = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = stream;
    blurVideo.srcObject = stream;
    await Promise.all([video.play(), blurVideo.play()]);
    stage.classList.add("is-live");
    stage.classList.toggle("is-front-camera", facingMode === "user");
    if (Number(slider.value) !== 0) ensureDepthSimulation();
    else depthStatus.textContent = "Set a diopter value to enable depth-aware blur";
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    const message = error.name === "NotAllowedError"
      ? "Camera access was denied. Allow camera access in your browser settings."
      : error.name === "NotFoundError"
        ? "No camera was found on this device."
        : "Could not start the camera. Please try again.";
    showToast(message);
  } finally {
    startButton.disabled = false;
    startButton.textContent = "Turn on camera";
  }
}

async function startDepthSimulation(cameraStream) {
  depthStatus.textContent = "Loading depth model… first use downloads it";
  try {
    const { createDepthEffect } = await import("./depth-effect.js");
    const controller = await createDepthEffect(
      video,
      blurVideo,
      stage,
      () => Number(slider.value),
      (message) => { depthStatus.textContent = message; },
    );
    if (stream !== cameraStream) {
      controller.stop();
      return;
    }
    depthController = controller;
    const currentDiopters = Number(slider.value);
    depthController.setDiopters(currentDiopters);
    stage.classList.toggle("is-depth-active", currentDiopters !== 0);
  } catch (error) {
    console.error("Depth estimation could not start:", error);
    if (stream === cameraStream) {
      depthFailed = true;
      depthStatus.textContent = "Depth model unavailable — check your internet connection";
    }
  }
}

function ensureDepthSimulation() {
  if (!stream || depthController || depthPromise || depthFailed) return;
  const cameraStream = stream;
  depthPromise = startDepthSimulation(cameraStream).finally(() => {
    depthPromise = null;
    if (stream && stream !== cameraStream && Number(slider.value) !== 0) ensureDepthSimulation();
  });
}

slider.addEventListener("input", () => {
  updateSimulation();
  if (Number(slider.value) !== 0) ensureDepthSimulation();
  try {
    localStorage.setItem(diopterStorageKey, slider.value);
  } catch {
    // Keep the live control working when storage is unavailable.
  }
});
function setSliderFromPointer(event) {
  const bounds = sliderVisual.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const min = Number(slider.min);
  const max = Number(slider.max);
  const step = Number(slider.step) || 0.05;
  const value = min + Math.round((ratio * (max - min)) / step) * step;
  slider.value = String(Number(value.toFixed(2)));
  slider.dispatchEvent(new Event("input", { bubbles: true }));
}

sliderThumb.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  sliderThumb.setPointerCapture(event.pointerId);
  setSliderFromPointer(event);
});
sliderThumb.addEventListener("pointermove", (event) => {
  if (sliderThumb.hasPointerCapture(event.pointerId)) setSliderFromPointer(event);
});
let wheelRemainder = 0;
slider.parentElement.addEventListener("wheel", (event) => {
  if (!matchMedia("(pointer: fine)").matches) return;
  event.preventDefault();
  wheelRemainder += event.deltaY;
  const wheelSteps = Math.trunc(wheelRemainder / 100);
  if (wheelSteps === 0) return;
  wheelRemainder -= wheelSteps * 100;
  const step = Number(slider.step) || 0.05;
  slider.value = String(Number((Number(slider.value) - wheelSteps * step).toFixed(2)));
  slider.dispatchEvent(new Event("input", { bubbles: true }));
}, { passive: false });
startButton.addEventListener("click", startCamera);
cameraSwitch.addEventListener("click", () => {
  if (!stream) return;
  facingMode = facingMode === "environment" ? "user" : "environment";
  startCamera();
});
githubButton.addEventListener("click", () => showToast("GitHub link coming soon."));
function setTheme(theme) {
  const isLight = theme === "light";
  document.documentElement.dataset.theme = isLight ? "light" : "dark";
  const nextTheme = isLight ? "dark" : "light";
  themeToggle.setAttribute("aria-label", `Switch to ${nextTheme} mode`);
  themeToggle.title = `Switch to ${nextTheme} mode`;
  themeToggle.setAttribute("aria-pressed", String(isLight));
}

themeToggle.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  setTheme(nextTheme);
  try {
    localStorage.setItem(themeStorageKey, nextTheme);
  } catch {
    // Theme switching still works for this session without storage.
  }
});
window.addEventListener("pagehide", () => {
  depthController?.stop();
  stream?.getTracks().forEach((track) => track.stop());
});

try {
  const savedTheme = localStorage.getItem(themeStorageKey);
  if (savedTheme === "light" || savedTheme === "dark") setTheme(savedTheme);
  const savedDiopters = Number(localStorage.getItem(diopterStorageKey));
  if (localStorage.getItem(diopterStorageKey) !== null && Number.isFinite(savedDiopters) && savedDiopters >= -10 && savedDiopters <= 10) {
    slider.value = String(savedDiopters);
  }
} catch {
  // Use the default value when storage is unavailable.
}
updateSimulation();
