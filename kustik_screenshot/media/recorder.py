"""The recorder: frames from a source (see sources.py) piped into ffmpeg."""

import os
import queue
import shutil
import signal
import subprocess
import tempfile
import threading
from pathlib import Path

from gi.repository import GLib

from ..config import RUNTIME, VIDEOS, log, stamp, unique


class Recorder:
    """Frames from a source (see sources.py) piped straight into ffmpeg.
    Pausing closes the current segment; resuming starts a new one, and stop
    joins them, so a pause leaves no frozen stretch in the video."""

    FPS = "30"
    VAAPI = "/dev/dri/renderD128"

    def __init__(self):
        self.active = False
        self.hw = None  # None: not probed yet; then True/False
        # Every operation runs here, in order, off the UI thread: starting waits
        # for the first frame and stopping waits for ffmpeg to finish the file.
        self.jobs = queue.Queue()
        threading.Thread(target=self._worker, daemon=True).start()

    def warm(self):
        if self.hw is None:
            self.run(self._probe_hw)

    def _worker(self):
        while True:
            fn, done = self.jobs.get()
            try:
                res, err = fn(), None
            except Exception as e:
                res, err = None, e
                log("recorder:", repr(e))
            if done:
                GLib.idle_add(done, res, err)

    def run(self, fn, done=None):
        """Queue fn(); done(result, error) is called on the UI thread."""
        self.jobs.put((fn, done))

    def _probe_hw(self):
        """GPU H.264 encoding (VAAPI) keeps full-screen recording light on the CPU."""
        if not os.path.exists(self.VAAPI):
            self.hw = False
            return
        r = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-vaapi_device", self.VAAPI,
                            "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.1", "-vf", "format=nv12,hwupload",
                            "-c:v", "h264_vaapi", "-f", "null", "-"], capture_output=True, timeout=10)
        self.hw = r.returncode == 0
        log("video encoder:", "h264_vaapi (GPU)" if self.hw else "libx264 (CPU)")

    def start(self, source, mic, sys_audio):
        """source: a sources.*Source; it's released when the recording stops."""
        if self.hw is None:
            self._probe_hw()
        self.source = source
        self.mic, self.sys = mic, sys_audio
        self.dir = Path(tempfile.mkdtemp(prefix="rec-", dir=RUNTIME))
        self.segments = []
        self.ffmpeg = None
        self.active = True
        self._start_segment()

    def _start_segment(self):
        seg = self.dir / f"seg{len(self.segments):03d}.mp4"
        inp = self.source.open()
        args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
        if self.hw:
            args += ["-vaapi_device", self.VAAPI]
        args += inp["args"]
        audio = []
        if self.mic:
            audio.append(self.mic)
        if self.sys:
            audio.append("@DEFAULT_MONITOR@")
        for src in audio:
            args += ["-f", "pulse", "-i", src]
        vf = []
        if inp["crop"]:
            vf.append("crop={}:{}:{}:{}".format(*inp["crop"]))
        vf += ["format=nv12", "hwupload"] if self.hw else []
        graph = [f"[0:v]{','.join(vf)}[v]"] if vf else []
        if len(audio) == 2:
            graph.append("[1:a][2:a]amix=inputs=2:duration=longest:normalize=0[a]")
        if graph:
            args += ["-filter_complex", ";".join(graph)]
        args += ["-map", "[v]" if vf else "0:v"]
        if len(audio) == 2:
            args += ["-map", "[a]"]
        elif len(audio) == 1:
            args += ["-map", "1:a"]
        if self.hw:
            args += ["-c:v", "h264_vaapi", "-qp", "20", "-fps_mode", "vfr"]
        else:
            args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-fps_mode", "vfr"]
        if audio:
            args += ["-c:a", "aac", "-b:a", "160k"]
        args += ["-movflags", "+faststart", str(seg)]
        stdin = inp["stdin"]
        self.ffmpeg = subprocess.Popen(args, stdin=stdin if stdin is not None else subprocess.DEVNULL, stderr=subprocess.PIPE)
        if stdin is not None:  # ffmpeg has its own copy now
            stdin.close() if hasattr(stdin, "close") else os.close(stdin)
        self.segments.append(seg)
        self.has_audio = bool(audio)

    def _end_segment(self):
        # 1. End the video stream on a whole frame.
        self.source.close_segment()
        # 2. Then let ffmpeg finish the file (audio inputs never end on their own).
        if self.ffmpeg:
            self.ffmpeg.send_signal(signal.SIGINT)
            try:
                _, err = self.ffmpeg.communicate(timeout=15)
                if err and err.strip():
                    log("ffmpeg:", err.decode(errors="replace").strip()[-400:])
            except subprocess.TimeoutExpired:
                self.ffmpeg.kill()
        self.ffmpeg = None

    def pause(self):
        if self.active and self.ffmpeg:
            self._end_segment()

    def resume(self):
        if self.active and not self.ffmpeg:
            self._start_segment()

    def stop(self, discard):
        if not self.active:
            return None
        self._end_segment()
        self.source.release()
        self.active = False
        segs = [s for s in self.segments if s.exists() and s.stat().st_size > 0]
        if discard or not segs:
            shutil.rmtree(self.dir, ignore_errors=True)
            return None
        VIDEOS.mkdir(parents=True, exist_ok=True)
        final = unique(VIDEOS / f"Recording {stamp()}.mp4")
        if len(segs) == 1:
            shutil.move(str(segs[0]), final)
        else:
            lst = self.dir / "list.txt"
            lst.write_text("".join(f"file '{s}'\n" for s in segs))
            subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
                            "-i", str(lst), "-c", "copy", "-movflags", "+faststart", str(final)], check=False)
        shutil.rmtree(self.dir, ignore_errors=True)
        return final
