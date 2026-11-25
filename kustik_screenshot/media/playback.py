"""Can WebKit play our recordings? It plays <video> through GStreamer."""

import shutil
import subprocess


def gst_has(*elements):
    return all(subprocess.run(["gst-inspect-1.0", "--exists", e]).returncode == 0 for e in elements)


def media_playback_ok():
    """WebKit plays the recordings through GStreamer; without a demuxer, an
    H.264 decoder and an audio sink, <video> crashes the web process."""
    return (shutil.which("gst-inspect-1.0") is not None and gst_has("qtdemux", "autoaudiosink")
            and any(gst_has(d) for d in ("avdec_h264", "vah264dec", "openh264dec")))
