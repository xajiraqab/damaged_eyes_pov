# Damaged Eyes POV

A lightweight, full-screen vision simulation that applies an adjustable blur effect to a live camera preview.

## Run locally

Serve this folder with a local web server, then open `index.html` in a browser. For example:

```powershell
py -m http.server 8000
```

Camera access requires a secure browser context: use `localhost` on the same device or serve the site over HTTPS. Diopter and theme preferences are saved in the browser's local storage.

## Files

- `index.html` — page structure
- `style.css` — responsive layout and themes
- `app.js` — camera, slider, and saved preferences
- `favicon.svg` — site icon
