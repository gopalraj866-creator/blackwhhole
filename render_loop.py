#!/usr/bin/env python3
"""
Render the black-hole scene frame-by-frame (deterministic) in headless Chromium
(software WebGL, no GPU) and encode MP4.

  python render_loop.py --out loop.mp4                          # whole 120 s loop (slow on one machine)
  python render_loop.py --out part.mp4 --first 0 --count 90     # one shard (frames 0..89)
  python render_loop.py --out test.mp4 --first 0 --count 6      # quick test

The camera programme is a seamless 120 s cycle, so shards can be rendered on
separate machines and joined with `ffmpeg -f concat -c copy`.
"""
import argparse, asyncio, os, subprocess, sys, time
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8765
GOP = 30  # shard sizes must be a multiple of this so shards join cleanly


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="blackhole_loop.mp4")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--first", type=int, default=0, help="first frame index of the loop")
    ap.add_argument("--count", type=int, default=0, help="number of frames (0 = to the end of the loop)")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--bitrate", default="4000k")
    ap.add_argument("--quality", default="med", help="low|med|high ray-marching steps")
    ap.add_argument("--preset", default="sgra", help="sgra|m87")
    args = ap.parse_args()

    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "-d", HERE],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(args=[
                "--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader",
                "--ignore-gpu-blocklist", "--enable-webgl", "--hide-scrollbars"])
            page = await browser.new_page(viewport={"width": args.width, "height": args.height})
            errs = []
            page.on("pageerror", lambda e: errs.append(str(e)))
            await page.goto(f"http://localhost:{PORT}/index.html?manual=1&q={args.quality}&preset={args.preset}")
            await page.wait_for_function("window.__ready===true", timeout=180000)
            total = await page.evaluate("window.__total")
            nloop = int(round(total * args.fps))
            count = args.count or (nloop - args.first)
            ff = subprocess.Popen([
                "ffmpeg", "-hide_banner", "-loglevel", "warning", "-y",
                "-f", "image2pipe", "-framerate", str(args.fps), "-c:v", "mjpeg", "-i", "-",
                "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", str(args.fps),
                "-b:v", args.bitrate, "-maxrate", args.bitrate, "-bufsize", "8000k",
                "-x264-params", f"keyint={GOP}:min-keyint={GOP}:scenecut=0",
                "-video_track_timescale", "90000", "-an", args.out], stdin=subprocess.PIPE)
            t0 = time.time()
            for i in range(count):
                f = args.first + i
                await page.evaluate(f"window.renderAt({f / args.fps})")
                ff.stdin.write(await page.screenshot(type="jpeg", quality=93))
                if i % 10 == 0:
                    el = time.time() - t0
                    print(f"frame {f} ({i + 1}/{count})  {el / (i + 1):.1f} s/frame  "
                          f"ETA {el / (i + 1) * (count - i - 1) / 60:.1f} min", flush=True)
            ff.stdin.close(); ff.wait()
            await browser.close()
        if errs:
            print("page errors:", errs[:3])
        print("wrote", args.out)
    finally:
        srv.terminate()

asyncio.run(main())
