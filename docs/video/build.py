#!/usr/bin/env python3
"""Assemble the SIEGE demo: recorded frames + narration clips + burned-in captions.

Usage: build.py <take_dir> <audio_dir> <narration.json> <out.mp4> [crf]
take_dir holds frames/, frames.json and scenes.json from record.mjs; audio_dir holds <scene id>.mp3 and durations.json.
"""
import json, os, re, subprocess, sys

take, adir, narr, out = sys.argv[1:5]
crf = sys.argv[5] if len(sys.argv) > 5 else "23"
LEAD = 0.25  # the voice starts this long after a scene starts

lines = json.load(open(narr))
meta = json.load(open(os.path.join(take, "scenes.json")))
frames = json.load(open(os.path.join(take, "frames.json")))
t0, end = meta["t0"], meta["end"]
start = {s["id"]: s["start"] for s in meta["scenes"]}
durs = json.load(open(os.path.join(adir, "durations.json")))


def dur(p):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
                                capture_output=True, text=True, check=True).stdout)


# 1. Frames -> concat list with real timestamps, starting at the recording origin.
rel = [(f["name"], f["t"] - t0) for f in frames]
first = max([i for i, (_, t) in enumerate(rel) if t <= 0] or [0])
rel = rel[first:]
rel[0] = (rel[0][0], 0.0)
rel = [r for r in rel if r[1] < end]
cl = os.path.join(take, "concat.txt")
with open(cl, "w") as fh:
    fh.write("ffconcat version 1.0\n")
    for i, (n, t) in enumerate(rel):
        nxt = rel[i + 1][1] if i + 1 < len(rel) else end
        fh.write(f"file 'frames/{n}'\nduration {max(nxt - t, 0.001):.4f}\n")
    fh.write(f"file 'frames/{rel[-1][0]}'\n")


# 2. Captions: one per sentence, timed by character share of the clip.
def ts(x):
    ms = int(round(x * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


srt, k = [], 1
for ln in lines:
    d = durs[ln["id"]]
    s0 = start[ln["id"]] + LEAD
    sents = [s for s in re.split(r"(?<=[.?!])\s+(?=[A-Z])", ln.get("caption", ln["text"]).strip()) if s]
    total = sum(len(s) for s in sents)
    c = s0
    for s in sents:
        span = d * len(s) / total
        srt.append(f"{k}\n{ts(c)} --> {ts(c + span - 0.05)}\n{s}\n")
        k += 1
        c += span
srt_path = os.path.join(take, "captions.srt")
open(srt_path, "w").write("\n".join(srt))

# 3. Audio: each clip delayed to its scene start, mixed, padded to the video length.
ins, fl = [], []
for i, ln in enumerate(lines):
    ins += ["-i", os.path.join(adir, ln["id"] + ".mp3")]
    ms = int((start[ln["id"]] + LEAD) * 1000)
    fl.append(f"[{i + 1}:a]aresample=48000,adelay={ms}|{ms}[a{i}]")
mix = "".join(f"[a{i}]" for i in range(len(lines)))
fl.append(f"{mix}amix=inputs={len(lines)}:normalize=0,apad,atrim=0:{end:.3f}[aout]")

style = ("FontName=Noto Sans,FontSize=8.5,PrimaryColour=&H00FFFFFF,OutlineColour=&H55000000,BackColour=&H55000000,BorderStyle=3,"
         "Outline=5,Shadow=0,MarginV=12,Alignment=2,MarginL=60,MarginR=60")
vf = f"fps=30,format=yuv420p,subtitles={srt_path}:force_style='{style}'"
cmd = ["nice", "-n", "15", "ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", cl, *ins,
       "-filter_complex", ";".join(fl), "-map", "0:v", "-map", "[aout]", "-vf", vf,
       "-c:v", "libx264", "-preset", "slow", "-crf", crf, "-threads", "2",
       "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-t", f"{end:.3f}", out]
subprocess.run(cmd, check=True)
print(out, f"{dur(out):.2f}s", f"{os.path.getsize(out) / 1e6:.2f} MB")
