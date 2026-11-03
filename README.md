# Damaged Eyes POV

A lightweight, full-screen vision simulation that applies an adjustable blur effect to a live camera preview.

## Run locally

Serve this folder with a local web server, then open `index.html` in a browser. For example:

```powershell
py -m http.server 8000
```

Camera access requires a secure browser context: use `localhost` on the same device or serve the site over HTTPS. When a non-zero diopter is selected, the depth model downloads from Hugging Face on first use and runs in the browser; camera frames are not uploaded. The depth map is relative, so the near/far blur is an approximation rather than a measurement in meters. Diopter and theme preferences are saved in the browser's local storage.

## Files

- `index.html` — page structure
- `style.css` — responsive layout and themes
- `app.js` — camera, slider, and saved preferences
- `depth-effect.js` — on-device scene depth estimation and near/far blur
- `favicon.svg` — site icon
