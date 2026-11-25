"""Microphones: the list for the UI, and a live level meter."""

import json
import math
import struct
import subprocess
import threading
import time

from gi.repository import GLib

from ..config import log


def list_mics():
    try:
        out = subprocess.run(["pactl", "-f", "json", "list", "sources"], capture_output=True, text=True, timeout=3)
        sources = json.loads(out.stdout)
        default = subprocess.run(["pactl", "get-default-source"], capture_output=True, text=True, timeout=3).stdout.strip()
    except Exception as e:
        log("list-mics failed:", e)
        return [], None
    mics = []
    for s in sources:
        if s.get("monitor_of_sink") not in (None, "n/a") or s["name"].endswith(".monitor"):
            continue
        mics.append({"id": s["name"], "label": s.get("description") or s["name"]})
    return mics, default


class LevelMonitor:
    """Streams a mic's loudness (0..1) for the UI meters."""

    def __init__(self, post):
        self.post = post
        self.proc = None
        self.source = None

    def set(self, source):
        if source == self.source:
            return
        self.stop()
        self.source = source
        if not source:
            return
        try:
            self.proc = subprocess.Popen(
                ["parec", f"--device={source}", "--format=s16le", "--rate=16000", "--channels=1", "--latency-msec=40", "--raw"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        except OSError as e:
            log("parec failed:", e)
            return
        threading.Thread(target=self._run, args=(self.proc,), daemon=True).start()

    def _run(self, proc):
        chunk = 800 * 2  # 50 ms
        last = 0
        while proc.poll() is None:
            data = proc.stdout.read(chunk)
            if not data:
                break
            n = len(data) // 2
            samples = struct.unpack(f"<{n}h", data[: n * 2])
            rms = math.sqrt(sum(s * s for s in samples) / max(1, n)) / 32768
            v = min(1.0, (rms * 6) ** 0.7)
            now = time.monotonic()
            if now - last > 0.045:
                last = now
                GLib.idle_add(self.post, {"type": "mic-level", "v": round(v, 3)})

    def stop(self):
        if self.proc:
            self.proc.terminate()
            self.proc = None
        self.source = None
