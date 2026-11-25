"""Where the user is and what's on screen: niri's IPC (focused output,
clickable windows), monitors, the overlay's click-through region, and
whole-desktop grabs for the portal and X11 backends."""

import ctypes
import json
import os
import socket
import subprocess

from gi.repository import Gdk, GdkPixbuf

from ..config import HELPER


# ----------------------------------------------------------------- niri

NIRI_REQUESTS = {"focused-output": "FocusedOutput", "windows": "Windows", "workspaces": "Workspaces"}


def niri(what):
    """Ask niri over its IPC socket (one JSON request per connection). Talks to
    the socket directly, so it works without the niri binary (e.g. in Flatpak)."""
    path = os.environ.get("NIRI_SOCKET")
    if not path or what not in NIRI_REQUESTS:
        return None
    req = NIRI_REQUESTS[what]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(2)
            sock.connect(path)
            sock.sendall(json.dumps(req).encode() + b"\n")
            buf = b""
            while not buf.endswith(b"\n"):
                chunk = sock.recv(65536)
                if not chunk:
                    break
                buf += chunk
        reply = json.loads(buf)
        return reply.get("Ok", {}).get(req)
    except (OSError, ValueError, AttributeError):
        return None


def focused_output():
    """niri knows the focused output; elsewhere the overlay finds out (see
    _resolve_output in app.py)."""
    o = niri("focused-output")
    if o and o.get("logical"):
        lg = o["logical"]
        return {"name": o["name"], "x": lg["x"], "y": lg["y"], "w": lg["width"], "h": lg["height"], "scale": lg.get("scale", 1)}
    return None


def window_targets(output_name):
    """Windows the user can click to capture. niri only reports on-screen
    positions for floating windows, so tiled windows aren't offered."""
    wins = niri("windows") or []
    wss = {w["id"]: w for w in (niri("workspaces") or [])}
    out = []
    for w in wins:
        ws = wss.get(w.get("workspace_id"))
        if not ws or not ws.get("is_active") or ws.get("output") != output_name:
            continue
        lay = w.get("layout") or {}
        pos = lay.get("tile_pos_in_workspace_view")
        if not pos:
            continue
        off = lay.get("window_offset_in_tile") or [0, 0]
        ww, wh = lay.get("window_size") or lay.get("tile_size") or (0, 0)
        out.append({"x": pos[0] + off[0], "y": pos[1] + off[1], "w": ww, "h": wh, "title": w.get("title") or w.get("app_id") or "Window"})
    return out


# ----------------------------------------------------------------- monitors

def monitor_info(m):
    g = m.get_geometry()
    scale = m.get_scale() if hasattr(m, "get_scale") else m.get_scale_factor()
    return {"name": m.get_connector() or "", "x": g.x, "y": g.y, "w": g.width, "h": g.height, "scale": scale}


def all_monitors():
    mons = Gdk.Display.get_default().get_monitors()
    return [mons.get_item(i) for i in range(mons.get_n_items())]


def direct_capture_works():
    """wlr-screencopy available (niri, Sway, Hyprland, river, …)?"""
    if not HELPER.exists() or not os.environ.get("WAYLAND_DISPLAY"):
        return False
    try:
        r = subprocess.run([str(HELPER), "outputs"], capture_output=True, text=True, timeout=3)
        return r.returncode == 0 and bool(json.loads(r.stdout or "[]"))
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False


def crop_to_monitor(src, out, dest):
    """The desktop image spans all monitors (in physical pixels); keep `out`."""
    pb = GdkPixbuf.Pixbuf.new_from_file(src)
    mons = [monitor_info(m) for m in all_monitors()] or [out]
    x0, y0 = min(m["x"] for m in mons), min(m["y"] for m in mons)
    x1 = max(m["x"] + m["w"] for m in mons)
    k = pb.get_width() / max(1, x1 - x0)
    x, y = int(round((out["x"] - x0) * k)), int(round((out["y"] - y0) * k))
    w = min(int(round(out["w"] * k)), pb.get_width() - x)
    h = min(int(round(out["h"] * k)), pb.get_height() - y)
    if (x, y, w, h) != (0, 0, pb.get_width(), pb.get_height()):
        pb = pb.new_subpixbuf(x, y, w, h)
    pb.savev(str(dest), "png", ["compression"], ["1"])


def x11_grab(path):
    """The whole X11 screen into `path`: (path, None) or (None, error)."""
    mons = [monitor_info(m) for m in all_monitors()]
    w = max(m["x"] + m["w"] for m in mons)
    h = max(m["y"] + m["h"] for m in mons)
    r = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "x11grab", "-video_size", f"{w}x{h}",
                        "-i", os.environ.get("DISPLAY", ":0"), "-frames:v", "1", str(path)], capture_output=True, text=True)
    return (str(path), None) if r.returncode == 0 else (None, r.stderr.strip()[-200:] or "x11grab failed")


# ----------------------------------------------------------------- input region (no pycairo needed)

class InputRegion:
    """gdk_surface_set_input_region via ctypes, so the overlay can be
    click-through everywhere except where the UI is."""

    class Rect(ctypes.Structure):
        _fields_ = [("x", ctypes.c_int), ("y", ctypes.c_int), ("width", ctypes.c_int), ("height", ctypes.c_int)]

    def __init__(self):
        self.cairo = ctypes.CDLL("libcairo.so.2")
        self.gtk = ctypes.CDLL("libgtk-4.so.1")
        self.cairo.cairo_region_create.restype = ctypes.c_void_p
        self.cairo.cairo_region_union_rectangle.argtypes = [ctypes.c_void_p, ctypes.POINTER(self.Rect)]
        self.cairo.cairo_region_destroy.argtypes = [ctypes.c_void_p]
        self.gtk.gdk_surface_set_input_region.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        get = ctypes.pythonapi.PyCapsule_GetPointer
        get.restype = ctypes.c_void_p
        get.argtypes = [ctypes.py_object, ctypes.c_char_p]
        self._ptr = lambda obj: get(obj.__gpointer__, None)

    def apply(self, surface, rects):
        region = self.cairo.cairo_region_create()
        for x, y, w, h in rects:
            r = self.Rect(int(x), int(y), max(0, int(w)), max(0, int(h)))
            self.cairo.cairo_region_union_rectangle(region, ctypes.byref(r))
        self.gtk.gdk_surface_set_input_region(self._ptr(surface), region)
        self.cairo.cairo_region_destroy(region)
