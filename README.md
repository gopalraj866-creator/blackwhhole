# Black Hole Simulator — Technical Talk India

Real-time Schwarzschild ray-tracer (Three.js + GLSL). Default target: **Sagittarius A\*** (preset: **M87\***).

## Run (needs a GPU PC)
```bash
python3 -m http.server 8000   # in this folder
```
Open http://localhost:8000 in Chrome → F11 → capture with OBS (Browser/Window capture) → YouTube.
Controls: drag = rotate · wheel/pinch = zoom · L labels · D data · S stars · A auto-orbit · Space pause.
Bottom bar: preset, view angle, disk speed, brightness, quality. URL: `?q=low|med|high`, `?inc=<deg>`, `?dist=<r_s>`.

## Measured / derived / simulated
- **Measured** (green): mass, distance, EHT ring size, with the source shown on screen
  (GRAVITY Collab. and EHT Sgr A* Paper I (2022) for Sgr A*; EHT M87* Paper VI (2019) for M87*).
- **Derived** (cyan): r_s = 2GM/c², shadow size (3√3/2 · r_s), ISCO, light-crossing time, ISCO period, computed from the measured mass/distance.
- **Simulated** (amber): camera, inclination, disk speed, colours, turbulence, glow.

## Honest limits
Non-rotating (Schwarzschild) metric; real holes spin, and EHT disfavours zero spin for Sgr A*.
Disk is a thin Novikov–Thorne-like model; colours are illustrative, not a spectrum fit.
Software WebGL (GitHub Actions) takes ~10 s/frame, so live streaming from Actions is not practical; use a GPU PC or pre-render a loop.

## 24/7 from GitHub Actions (pre-rendered loop)
GitHub runners have no GPU, so the scene is rendered frame by frame into a seamless 120 s MP4 and that loop is streamed with `-c:v copy` (almost no CPU).
1. Push this folder to a GitHub repo (keep `.github/workflows/`).
2. Actions → **Render Black Hole loop** → Run workflow (inputs: `preset` sgra|m87, `quality` low|med|high). 40 shards render in parallel, then are joined and published to the release `blackhole-loop`.
3. Add secret `YOUTUBE_RTMP_URL` = `rtmp://a.rtmp.youtube.com/live2/YOUR_KEY` (optional: `AUDIO_URL` = http(s) mp3 link, `VIDEO_URL` = your own mp4).
4. Actions → **Black Hole Live Stream** → Run workflow (restarts every 5 h).

Local test: `python render_loop.py --out test.mp4 --first 0 --count 30 --quality low`
