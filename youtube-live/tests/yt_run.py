"""Headless check of the 16:10 script on a real YouTube video (1920x1200 fullscreen).
Usage: python3 tests/yt_run.py content.js URL SAMPLES [OUTDIR]"""
import sys, time, os
from playwright.sync_api import sync_playwright
script = open(sys.argv[1]).read(); url = sys.argv[2]; n = int(sys.argv[3])
EXTRA_JS = os.environ.get("EXTRA_JS", "")
out = sys.argv[4] if len(sys.argv) > 4 else "."
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
    pg.evaluate(f"(() => {{ const v = {V}; v.muted = true; v.play(); }})()")
    time.sleep(2)
    for _ in range(60):
        if not pg.evaluate("!!document.querySelector('.ad-showing')"): break
        sk = pg.locator(".ytp-skip-ad-button, .ytp-ad-skip-button-modern")
        if sk.count():
            try: sk.first.click()
            except Exception: pass
        time.sleep(1)
    for attempt in range(4):
        if pg.evaluate("!!document.fullscreenElement && document.querySelector('#movie_player').clientHeight > 1100"): break
        if pg.evaluate("!!document.fullscreenElement"): pg.keyboard.press("f"); time.sleep(1.5)
        pg.locator("#movie_player").click(position={"x": 50, "y": 50}); pg.keyboard.press("f"); time.sleep(2)
    print("fullscreen:", pg.evaluate("!!document.fullscreenElement"), pg.evaluate("(() => { const p = document.querySelector('#movie_player'); return p.clientWidth + 'x' + p.clientHeight })()"))
    if os.environ.get('MODE'): pg.evaluate(f"localStorage.setItem('smart1610.mode', '{os.environ['MODE']}')")
    pg.evaluate(script)
    if EXTRA_JS: pg.evaluate(EXTRA_JS)
    pg.evaluate(f"(async () => {{ const v = {V}; v.muted = true; await v.play(); }})()")
    pg.mouse.move(1900, 10)
    if os.environ.get('DEBUG'): pg.keyboard.press('Alt+Shift+KeyZ')
    for k in range(n):
        time.sleep(2)
        st = pg.evaluate("window.__smart1610.state")
        vt = pg.evaluate(f"{V}.currentTime")
        on = [f"{r['x0']}-{r['x1']}x{r['y0']}-{r['y1']}" for r in st['rects'] if r['present'] and r['confirmed']]
        tx = st.get('text') or {}
        if st.get('fill'): print(f"t={vt:6.1f} FILL height+{st['fill']['heightAdded']*100:.1f}% width-{st['fill']['widthRemoved']*100:.1f}% (best row seam {st['fill']['costH']}, col seam {st['fill']['costV']}) cam={'moving' if st['camMoving'] else 'still'}"); pg.screenshot(path=os.path.join(out, f"yt_{k:02d}.png")); continue
        print(f"t={vt:6.1f} crop L={st['trimL']*100:.1f}% R={st['trimR']*100:.1f}% squeeze={(st['maxSqueeze']-1)*100:.1f}% hud={st['hud']} "
              f"chat L={'PROT' if tx.get('L') else '-'} R={'PROT' if tx.get('R') else '-'} seams={st['seam']['carved']}/{st['seam']['K']} mix={st['seam']['mix']:.2f} cam={'moving' if st['camMoving'] else 'still'} layers={on}")
        pg.screenshot(path=os.path.join(out, f"yt_{k:02d}.png"))
    print('seam energy log (avg seam detail / frame mean):', pg.evaluate('window.__smart1610.state.seam.log'))
    b.close()
