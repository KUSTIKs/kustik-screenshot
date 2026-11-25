"""ffprobe/ffmpeg for finished recordings: their size and length, the
editor's preview frames, and the trim/GIF export command."""

import json
import subprocess
import time

from ..config import CACHE, file_url


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height",
                          "-of", "json", str(path)], capture_output=True, text=True)
    info = json.loads(out.stdout or "{}")
    v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
    a = any(s.get("codec_type") == "audio" for s in info.get("streams", []))
    return {"dur": float(info.get("format", {}).get("duration", 0) or 0), "w": v.get("width", 0), "h": v.get("height", 0), "audio": a}


def preview_frames(video, dur):
    """Filmstrip thumbnails (68 px tall, every 0.3 s) and a 15 fps scrub cache."""
    d = CACHE / "frames" / f"{int(time.time() * 1000)}"
    (d / "t").mkdir(parents=True, exist_ok=True)
    (d / "c").mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(video), "-filter_complex",
                    "[0:v]split[a][b];[a]fps=10/3,scale=-2:68[t];"
                    "[b]fps=15,scale='min(720,iw)':'min(400,ih)':force_original_aspect_ratio=decrease[c]",
                    "-map", "[t]", "-q:v", "5", str(d / "t" / "%04d.jpg"),
                    "-map", "[c]", "-q:v", "4", str(d / "c" / "%05d.jpg")], check=False)
    thumbs = sorted((d / "t").glob("*.jpg"))
    cache = sorted((d / "c").glob("*.jpg"))
    cache_w = 0
    if cache:
        try:
            out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width", "-of", "csv=p=0", str(cache[0])],
                                 capture_output=True, text=True)
            cache_w = int(out.stdout.strip() or 0)
        except ValueError:
            pass
    return ([file_url(t) for t in thumbs],
            [{"t": round(i / 15, 4), "url": file_url(c)} for i, c in enumerate(cache)],
            cache_w)


def export_command(src, a, b, gif, out):
    """ffmpeg for a trim (a..b seconds) or GIF, reporting progress on stdout."""
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", str(src)]
    if gif:
        cmd += ["-vf", "fps=15,scale='min(640,iw)':-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];"
                       "[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", "-loop", "0"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"]
    return cmd + ["-progress", "pipe:1", "-nostats", str(out)]
