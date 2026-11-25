"""Where recorded frames come from. The recorder asks a source to open() a
stream for each segment (a pause ends a segment) and gets back ffmpeg input
arguments; the source decides how frames reach ffmpeg.

- HelperSource: wlr-screencopy through kustik-screenshot-helper (niri, Sway,
  Hyprland, river, …): raw frames on the helper's stdout.
- PipeWireSource: a portal screen-cast stream (GNOME, KDE, COSMIC, …), read
  with GStreamer and written to ffmpeg at a steady rate.
- X11Source: ffmpeg's own x11grab, for X11 sessions without a screen-cast portal.
"""

import json
import os
import subprocess
import threading
import time


def _even(v):
    return max(2, int(v) // 2 * 2)


class HelperSource:
    def __init__(self, helper, output, region, cursor, fps):
        self.cmd = [str(helper), "record", "--output", output, "--region",
                    f"{region['x']},{region['y']},{region['w']},{region['h']}", "--fps", str(fps)]
        if cursor:
            self.cmd.append("--cursor")
        self.proc = None

    def open(self):
        self.proc = subprocess.Popen(self.cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        hdr = json.loads(self.proc.stderr.readline() or "{}")
        if not hdr.get("width"):
            raise RuntimeError("capture helper did not start: " + self.proc.stderr.read().decode(errors="replace"))
        return {"args": ["-f", "rawvideo", "-pix_fmt", "bgr0", "-video_size", f"{hdr['width']}x{hdr['height']}",
                         "-use_wallclock_as_timestamps", "1", "-i", "pipe:0"],
                "stdin": self.proc.stdout, "crop": None}

    def close_segment(self):
        # The helper finishes the frame it's writing on SIGTERM, so the stream
        # ends on a whole frame.
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
            self.proc = None

    def release(self):
        self.close_segment()


class PipeWireSource:
    """GStreamer pulls the portal's PipeWire stream; the latest frame is
    written to ffmpeg at a fixed rate (a still screen sends no new frames)."""

    def __init__(self, fd, node, region, monitor_w, fps):
        import gi
        gi.require_version("Gst", "1.0")
        from gi.repository import Gst
        Gst.init(None)
        self.Gst = Gst
        self.region, self.monitor_w, self.fps = region, monitor_w, fps
        self.latest = None
        self.size = None
        self.lock = threading.Lock()
        self.got_frame = threading.Event()
        self.pipeline = Gst.parse_launch(
            f"pipewiresrc fd={fd} path={node} do-timestamp=true keepalive-time=500 always-copy=true ! "
            "videoconvert ! video/x-raw,format=BGRx ! appsink name=sink max-buffers=1 drop=true sync=false")
        self.sink = self.pipeline.get_by_name("sink")
        self.running = True
        self.pipeline.set_state(Gst.State.PLAYING)
        threading.Thread(target=self._pull, daemon=True).start()
        self.writer = None
        self.wfd = None

    def _pull(self):
        Gst = self.Gst
        while self.running:
            sample = self.sink.emit("try-pull-sample", 200 * Gst.MSECOND)
            if not sample:
                continue
            s = sample.get_caps().get_structure(0)
            w, h = s.get_value("width"), s.get_value("height")
            buf = sample.get_buffer()
            ok, info = buf.map(Gst.MapFlags.READ)
            if not ok:
                continue
            data = bytes(info.data)
            buf.unmap(info)
            stride = len(data) // h if h else w * 4
            if stride != w * 4:  # drop row padding
                data = b"".join(data[r * stride:r * stride + w * 4] for r in range(h))
            with self.lock:
                self.latest, self.size = data, (w, h)
            self.got_frame.set()

    def open(self):
        if not self.got_frame.wait(5):
            raise RuntimeError("no frames from the screen-cast stream")
        w, h = self.size
        rfd, self.wfd = os.pipe()
        self.writing = True
        self.writer = threading.Thread(target=self._write, args=(self.wfd,), daemon=True)
        self.writer.start()
        # The selection is in the monitor's logical pixels; the stream is in
        # physical ones.
        k = w / self.monitor_w if self.monitor_w else 1
        r = self.region
        x, y = int(round(r["x"] * k)), int(round(r["y"] * k))
        cw, ch = _even(min(r["w"] * k, w - x)), _even(min(r["h"] * k, h - y))
        return {"args": ["-f", "rawvideo", "-pix_fmt", "bgr0", "-video_size", f"{w}x{h}",
                         "-use_wallclock_as_timestamps", "1", "-i", "pipe:0"],
                "stdin": rfd, "crop": (cw, ch, x, y)}

    def _write(self, fd):
        interval = 1 / self.fps
        nxt = time.monotonic()
        while self.writing:
            with self.lock:
                frame = self.latest
            try:
                _write_all(fd, frame)
            except OSError:
                break
            nxt += interval
            now = time.monotonic()
            if nxt > now:
                time.sleep(nxt - now)
            else:
                nxt = now

    def close_segment(self):
        self.writing = False
        if self.writer:
            self.writer.join(timeout=2)
            self.writer = None
        if self.wfd is not None:
            os.close(self.wfd)
            self.wfd = None

    def release(self):
        self.close_segment()
        self.running = False
        self.pipeline.set_state(self.Gst.State.NULL)


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        view = view[n:]


class X11Source:
    def __init__(self, region, cursor, fps):
        self.region, self.cursor, self.fps = region, cursor, fps

    def open(self):
        r = self.region
        disp = os.environ.get("DISPLAY", ":0")
        return {"args": ["-f", "x11grab", "-framerate", str(self.fps), "-draw_mouse", "1" if self.cursor else "0",
                         "-video_size", f"{_even(r['w'])}x{_even(r['h'])}", "-i", f"{disp}+{int(r['x'])},{int(r['y'])}"],
                "stdin": None, "crop": None}

    def close_segment(self):
        pass

    def release(self):
        pass
