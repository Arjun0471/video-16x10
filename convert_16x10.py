#!/usr/bin/env python3
"""
Smart 16:9 -> 16:10 video converter.

Going from 16:9 to 16:10 means the frame has to get relatively taller. There are
two honest ways to do that:

  crop  - cut ~10% off the sides (keeps full-screen, loses edge content)
  pad   - add bands above/below   (keeps everything, adds filler)

"Smart" (the default `auto` mode) decides per shot:

  1. Analysis pass at low resolution: detects shot cuts and builds a per-column
     "importance" profile for every frame from motion, edge detail and faces.
  2. For each shot it finds the best crop window (a 16:10 slice of the frame)
     over time. If that window keeps at least --threshold of the important
     content, the shot is cropped, with a smoothed pan that follows the action
     (or a locked position if the subject barely moves). Otherwise the shot is
     padded with a blurred, darkened extension of the frame.
  3. Render pass at full resolution; mode switches only happen on cuts, so they
     are not noticeable. Audio is copied from the source.

Works for any input wider than 16:10 (16:9, 2:1, 21:9, ...). Pillarboxed
content (black side bars) is cropped losslessly because the bars carry no
importance.

Requires: ffmpeg/ffprobe on PATH, numpy, opencv-python-headless.
"""

import argparse
import json
import subprocess
import sys
import time

import cv2
import numpy as np

TARGET = 16 / 10
ANALYSIS_W = 480


# --------------------------------------------------------------------------- io

def probe(path):
    cmd = ["ffprobe", "-v", "error", "-show_entries",
           "stream=index,codec_type,width,height,avg_frame_rate:"
           "stream_tags=rotate:stream_side_data=rotation:format=duration",
           "-of", "json", path]
    info = json.loads(subprocess.run(cmd, capture_output=True, text=True,
                                     check=True).stdout)
    streams = info.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    if v is None:
        sys.exit("error: no video stream found")
    w, h = int(v["width"]), int(v["height"])
    rot = int(v.get("tags", {}).get("rotate", 0) or 0)
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    if abs(rot) % 180 == 90:  # ffmpeg auto-rotates on decode
        w, h = h, w
    fps_str = v.get("avg_frame_rate", "0/0")
    num, den = (fps_str.split("/") + ["1"])[:2]
    fps = float(num) / float(den) if float(den) else 0.0
    if fps <= 0:
        fps_str, fps = "30", 30.0
    duration = float(info.get("format", {}).get("duration", 0) or 0)
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    return dict(w=w, h=h, fps=fps, fps_str=fps_str, duration=duration,
                has_audio=has_audio)


def read_frames(path, fps_str, w, h, scale=None):
    """Yield BGR frames (constant frame rate) decoded by ffmpeg."""
    vf = f"fps={fps_str}"
    if scale:
        w, h = scale
        vf += f",scale={w}:{h}:flags=area"
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-map", "0:v:0", "-vf", vf,
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    size = w * h * 3
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        proc.stdout.close()
        proc.wait()


class Progress:
    def __init__(self, label, total):
        self.label, self.total, self.t0, self.last = label, total, time.time(), 0

    def tick(self, i):
        now = time.time()
        if now - self.last < 0.5:
            return
        self.last = now
        pct = f"{100 * i / self.total:5.1f}%" if self.total else ""
        rate = i / max(now - self.t0, 1e-6)
        print(f"\r{self.label}: frame {i} {pct} ({rate:.0f} fps)",
              end="", file=sys.stderr, flush=True)

    def done(self, i):
        print(f"\r{self.label}: {i} frames in {time.time() - self.t0:.1f}s"
              + " " * 20, file=sys.stderr)


# --------------------------------------------------------------------- analysis

def analyze(path, meta, use_faces=True):
    """Return (profiles[N, AW], cut_flags[N]) from a low-res pass."""
    aw = ANALYSIS_W
    ah = int(round(aw * meta["h"] / meta["w"] / 2)) * 2
    cascade = None
    if use_faces:
        cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        if cascade.empty():
            cascade = None
    face_every = max(1, int(round(meta["fps"] / 4)))

    xs = np.arange(aw, dtype=np.float32)
    center_prior = np.exp(-0.5 * ((xs - aw / 2) / (aw * 0.35)) ** 2)
    center_prior /= center_prior.sum()

    profiles, cuts = [], []
    prev_gray, prev_hist, faces = None, None, []
    total = int(meta["duration"] * meta["fps"])
    prog = Progress("analyze", total)
    i = 0
    for frame in read_frames(path, meta["fps_str"], meta["w"], meta["h"],
                             scale=(aw, ah)):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
        cv2.normalize(hist, hist)

        cut = prev_hist is None or \
            cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL) < 0.55
        cuts.append(cut)

        # edge detail
        gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
        edge = cv2.magnitude(gx, gy).sum(axis=0)

        # motion (ignored on the first frame of a shot)
        if prev_gray is not None and not cut:
            diff = cv2.absdiff(gray, prev_gray)
            diff[diff < 18] = 0
            motion = diff.astype(np.float32).sum(axis=0)
        else:
            motion = np.zeros(aw, np.float32)

        # faces (sampled a few times per second, held in between)
        if cascade is not None and (i % face_every == 0 or cut):
            faces = cascade.detectMultiScale(gray, 1.15, 5, minSize=(20, 20))
        face_prof = np.zeros(aw, np.float32)
        for (fx, fy, fw, fh) in faces:
            m = int(fw * 0.4)
            face_prof[max(0, fx - m):min(aw, fx + fw + m)] += fw * fh

        def norm(a):
            s = a.sum()
            return a / s if s > 0 else a

        prof = (0.35 * norm(edge) + 0.65 * norm(motion)
                + 1.5 * norm(face_prof) + 0.08 * center_prior)
        profiles.append(norm(prof).astype(np.float32))

        prev_gray, prev_hist = gray, hist
        i += 1
        prog.tick(i)
    prog.done(i)
    if i == 0:
        sys.exit("error: could not decode any frames")
    return np.stack(profiles), np.array(cuts)


def gaussian_smooth(a, sigma):
    if sigma < 1 or len(a) < 3:
        return a
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    return np.convolve(np.pad(a, r, mode="edge"), k, mode="valid")


def plan(profiles, cuts, meta, mode, threshold, pan_sigma_s):
    """Per frame: ('crop', offset_fraction) or ('pad', None). Plus shot log."""
    n, aw = profiles.shape
    crop_frac = (meta["h"] * TARGET) / meta["w"]
    cw = max(1, int(round(aw * crop_frac)))
    slack = aw - cw
    fps = meta["fps"]

    # shot boundaries, merging shots shorter than 0.4s into the previous one
    min_len = max(1, int(round(0.4 * fps)))
    starts = [0]
    for i in np.flatnonzero(cuts):
        if i - starts[-1] >= min_len:
            starts.append(int(i))
    bounds = list(zip(starts, starts[1:] + [n]))

    decisions = [None] * n
    log = []
    for s, e in bounds:
        P = profiles[s:e]
        cs = np.concatenate([np.zeros((len(P), 1), np.float32),
                             np.cumsum(P, axis=1)], axis=1)
        win = cs[:, cw:] - cs[:, :slack + 1]          # (frames, slack+1)
        tot = cs[:, -1:].clip(1e-9)
        cover = win / tot

        # Feasible range per frame: every offset that keeps (nearly) the best
        # coverage. The camera only moves when it must leave that range.
        best = cover.max(axis=1, keepdims=True)
        ok = cover >= best - 0.01
        lo = ok.argmax(axis=1)
        hi = slack - ok[:, ::-1].argmax(axis=1)
        static_x = int(cover.mean(axis=0).argmax())
        moving = lo.max() > hi.min()
        if moving:
            raw = np.empty(e - s)
            p = float(np.clip(static_x, lo[0], hi[0]))
            for j in range(e - s):           # minimal-movement follow
                p = min(max(p, lo[j]), hi[j])
                raw[j] = p
            path = gaussian_smooth(raw, pan_sigma_s * fps)
            path = np.clip(np.round(path), 0, slack).astype(int)
        else:
            path = np.full(e - s, int(np.clip(static_x, lo.max(), hi.min())))
        kept = cover[np.arange(e - s), path]
        score = float(np.percentile(kept, 10))

        if mode == "crop":
            use = "crop"
        elif mode in ("pad", "bars"):
            use = "pad"
        else:
            use = "crop" if score >= threshold else "pad"

        for j in range(e - s):
            decisions[s + j] = ("crop", path[j] / slack if slack else 0.5) \
                if use == "crop" else ("pad", None)
        log.append(dict(start=s / fps, end=e / fps, mode=use, kept=score,
                        pan=bool(moving and use == "crop")))
    return decisions, log


# ----------------------------------------------------------------------- render

def render(path, out, meta, decisions, size, fill, crf, preset, audio_codec):
    w, h = meta["w"], meta["h"]
    ow, oh = size
    crop_w = h * TARGET
    scale_c = ow / crop_w                 # crop branch: crop_w x h -> ow x oh
    fg_h = int(round(h * ow / w / 2)) * 2  # pad branch: fit width
    y0 = (oh - fg_h) // 2
    interp_fg = cv2.INTER_AREA if ow < w else cv2.INTER_CUBIC

    enc = ["ffmpeg", "-v", "error", "-y",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{ow}x{oh}",
           "-r", meta["fps_str"], "-i", "-"]
    if meta["has_audio"]:
        enc += ["-i", path, "-map", "0:v", "-map", "1:a?", "-c:a", audio_codec]
    enc += ["-c:v", "libx264", "-preset", preset, "-crf", str(crf),
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-shortest", out]
    proc = subprocess.Popen(enc, stdin=subprocess.PIPE)

    prog = Progress("render ", len(decisions))
    canvas = np.zeros((oh, ow, 3), np.uint8)
    i = 0
    try:
        for frame in read_frames(path, meta["fps_str"], w, h):
            kind, f = decisions[min(i, len(decisions) - 1)]
            if kind == "crop":
                x = f * (w - crop_w)  # sub-pixel offset -> smooth pans
                M = np.float32([[scale_c, 0, -x * scale_c], [0, scale_c, 0]])
                img = cv2.warpAffine(frame, M, (ow, oh), flags=cv2.INTER_CUBIC,
                                     borderMode=cv2.BORDER_REPLICATE)
            else:
                if fill == "blur":
                    cx = int((w - crop_w) / 2)
                    core = frame[:, cx:cx + int(crop_w)]
                    tiny = cv2.resize(core, (max(8, ow // 24), max(5, oh // 24)),
                                      interpolation=cv2.INTER_AREA)
                    tiny = cv2.GaussianBlur(tiny, (0, 0), 2)
                    bg = cv2.resize(tiny, (ow, oh), interpolation=cv2.INTER_LINEAR)
                    canvas = (bg.astype(np.float32) * 0.5).astype(np.uint8)
                else:
                    canvas[:] = 0
                canvas[y0:y0 + fg_h] = cv2.resize(frame, (ow, fg_h),
                                                  interpolation=interp_fg)
                img = canvas
            proc.stdin.write(np.ascontiguousarray(img).tobytes())
            i += 1
            prog.tick(i)
    except BrokenPipeError:
        pass
    finally:
        proc.stdin.close()
        rc = proc.wait()
    prog.done(i)
    if rc != 0:
        sys.exit(f"error: encoder exited with code {rc} "
                 "(try --audio-codec aac if audio copy failed)")


# -------------------------------------------------------------------------- cli

def parse_size(s):
    try:
        a, b = s.lower().split("x")
        return int(a) // 2 * 2, int(b) // 2 * 2
    except ValueError:
        raise argparse.ArgumentTypeError("size must look like 1920x1200")


def main():
    ap = argparse.ArgumentParser(
        description="Smart 16:9 -> 16:10 video converter (content-aware crop/pad).")
    ap.add_argument("input")
    ap.add_argument("output", nargs="?",
                    help="output file (default: <input>_16x10.mp4)")
    ap.add_argument("--mode", choices=["auto", "crop", "pad", "bars"],
                    default="auto",
                    help="auto: decide per shot (default); crop: always smart-crop; "
                         "pad: always pad with blurred fill; bars: pad with black")
    ap.add_argument("--threshold", type=float, default=0.95,
                    help="auto mode: crop a shot only if the crop keeps at least "
                         "this fraction of important content (default 0.95)")
    ap.add_argument("--size", type=parse_size,
                    help="output size, e.g. 1920x1200 (default: source width x width/1.6)")
    ap.add_argument("--pan-smooth", type=float, default=0.6,
                    help="pan smoothing in seconds (default 0.6; higher = calmer)")
    ap.add_argument("--no-faces", action="store_true",
                    help="disable face detection")
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--audio-codec", default="copy",
                    help="audio codec for output (default copy; use aac if copy fails)")
    ap.add_argument("--plan-only", action="store_true",
                    help="analyze and print the per-shot plan without rendering")
    args = ap.parse_args()

    meta = probe(args.input)
    src_ar = meta["w"] / meta["h"]
    print(f"source: {meta['w']}x{meta['h']} ({src_ar:.3f}:1) @ {meta['fps']:.3f} fps, "
          f"{meta['duration']:.1f}s", file=sys.stderr)
    if src_ar <= TARGET + 0.01:
        sys.exit("error: source is already 16:10 or narrower; nothing to do")

    if args.size:
        size = args.size
    else:
        ow = meta["w"] // 2 * 2
        size = (ow, int(round(ow / TARGET / 2)) * 2)

    if args.mode in ("pad", "bars"):
        n = max(1, int(round(meta["duration"] * meta["fps"])))
        decisions = [("pad", None)] * n
        log = [dict(start=0, end=meta["duration"], mode="pad", kept=1.0, pan=False)]
    else:
        profiles, cuts = analyze(args.input, meta, use_faces=not args.no_faces)
        decisions, log = plan(profiles, cuts, meta, args.mode,
                              args.threshold, args.pan_smooth)

    print(f"\n{'shot':>4}  {'start':>8}  {'end':>8}  {'mode':<5} {'kept':>6}  pan",
          file=sys.stderr)
    for k, s in enumerate(log, 1):
        print(f"{k:>4}  {s['start']:8.2f}  {s['end']:8.2f}  {s['mode']:<5} "
              f"{100 * s['kept']:5.1f}%  {'yes' if s['pan'] else ''}",
              file=sys.stderr)
    n_crop = sum(1 for d in decisions if d[0] == "crop")
    print(f"\n{n_crop}/{len(decisions)} frames cropped, "
          f"{len(decisions) - n_crop} padded -> {size[0]}x{size[1]}\n",
          file=sys.stderr)
    if args.plan_only:
        return

    out = args.output or args.input.rsplit(".", 1)[0] + "_16x10.mp4"
    fill = "black" if args.mode == "bars" else "blur"
    render(args.input, out, meta, decisions, size, fill,
           args.crf, args.preset, args.audio_codec)
    print(f"wrote {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
