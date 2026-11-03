# Damaged Eyes POV

A full-screen camera vision simulator that uses on-device relative depth estimation to apply adjustable near/far blur.

## Run locally

Serve this folder with a local web server, then open `index.html` in a browser. For example:

```powershell
py -m http.server 8000
```

Camera access requires a secure browser context: use `localhost` on the same device or serve the site over HTTPS. When a non-zero diopter is selected, a quantized depth model downloads from Hugging Face on first use and runs in a web worker; camera frames are not uploaded. Depth masks update periodically while the camera itself stays on the browser's video compositor. The depth map is relative, so the near/far blur is an approximation rather than a measurement in meters. Diopter and theme preferences are saved in the browser's local storage.

## Files

- `index.html` — page structure
- `style.css` — responsive layout and themes
- `app.js` — camera, slider, and saved preferences
- `depth-effect.js` — on-device scene depth estimation and near/far blur
- `depth-worker.js` — background depth model loading and inference
- `favicon.svg` — site icon
