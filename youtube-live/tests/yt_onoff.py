"""Screenshot the same moment with the script on and off. Usage: yt_onoff.py content.js URL WAIT_S OUTDIR"""
import sys, time, os
from playwright.sync_api import sync_playwright
script = open(sys.argv[1]).read(); url = sys.argv[2]; wait = float(sys.argv[3]); out = sys.argv[4]
EXE = os.path.expanduser("~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell")
V = "document.querySelector('video.html5-main-video')"
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    pg = b.new_context(viewport={"width": 1920, "height": 1200}, locale="en-US").new_page()
    pg.goto(url, wait_until="domcontentloaded", timeout=60000)
    for label in ["Reject all", "Accept all"]:
        btn = pg.locator(f"button:has-text('{label}')")
        if btn.count(): btn.first.click(); time.sleep(2); break
    pg.wait_for_selector("video.html5-main-video", timeout=30000)
    pg.evaluate(f"(() => {{ const v = {V}; v.muted = true; v.play(); }})()"); time.sleep(2)
    for _ in range(60):
        if not pg.evaluate("!!document.querySelector('.ad-showing')"): break
        time.sleep(1)
    for attempt in range(4):
        if pg.evaluate("!!document.fullscreenElement && document.querySelector('#movie_player').clientHeight > 1100"): break
        if pg.evaluate("!!document.fullscreenElement"): pg.keyboard.press("f"); time.sleep(1.5)
        pg.locator("#movie_player").click(position={"x": 50, "y": 50}); pg.keyboard.press("f"); time.sleep(2)
    pg.evaluate(script)
    pg.evaluate(f"(async () => {{ const v = {V}; v.muted = true; await v.play(); }})()")
    pg.mouse.move(1900, 10)
    time.sleep(wait)
    pg.evaluate(f"{V}.pause()"); time.sleep(1)
    st = pg.evaluate("window.__smart1610.state")
    print("t", pg.evaluate(f"{V}.currentTime"), "crop", st['trimL'], st['trimR'], "layers", [r for r in st['rects'] if r['present'] and r['confirmed']])
    pg.screenshot(path=os.path.join(out, "on.png"))
    pg.keyboard.press("Alt+KeyZ"); time.sleep(1)
    pg.screenshot(path=os.path.join(out, "off.png"))
    b.close()
