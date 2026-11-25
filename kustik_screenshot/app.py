"""The app: one long-running process that owns an overlay hosting the web UI
(ui/index.html) in WebKitGTK, a layer-shell surface where the compositor has
one, otherwise a borderless full-screen window shown only while there's UI on
it. Outside a capture the overlay is click-through except for the toast, the
recording bar and pinned captures, and it never takes the keyboard. The
global shortcut (or the `capture` D-Bus action) freezes the screen and opens
the capture UI on the monitor the user is on.

This module wires things together and answers the UI's messages
(`on_<type>` handlers). The work lives in system/ (the desktop) and media/
(audio and video).
"""

import base64
import faulthandler
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("GdkPixbuf", "2.0")
gi.require_version("WebKit", "6.0")
from gi.repository import Gdk, GdkPixbuf, Gio, GLib, Gtk, WebKit  # noqa: E402

try:  # GLib 2.84+; older PyGObject (e.g. the GNOME 49 runtime) only has the GLib one
    gi.require_version("GLibUnix", "2.0")
    from gi.repository import GLibUnix  # noqa: E402
    unix_signal_add = GLibUnix.signal_add
except (ValueError, ImportError, AttributeError):
    unix_signal_add = GLib.unix_signal_add

try:
    gi.require_version("Gtk4LayerShell", "1.0")
    from gi.repository import Gtk4LayerShell as LayerShell  # noqa: E402
except (ValueError, ImportError):
    LayerShell = None

from .config import (APP_ID, CACHE, DEV, HELPER, PICTURES, ROOT, RUNTIME, UI, VIDEOS,  # noqa: E402
                     file_url, load_config, log, pretty_dir, save_config, stamp, unique)
from .media.audio import LevelMonitor, list_mics  # noqa: E402
from .media.ffmpeg import export_command, preview_frames, probe  # noqa: E402
from .media.playback import media_playback_ok  # noqa: E402
from .media.recorder import Recorder  # noqa: E402
from .media.sources import HelperSource, PipeWireSource, X11Source  # noqa: E402
from .system import clipboard  # noqa: E402
from .system.compositor import (InputRegion, all_monitors, crop_to_monitor, direct_capture_works,  # noqa: E402
                                focused_output, monitor_info, window_targets, x11_grab)
from .system.integration import (SHORTCUT, SHORTCUT_DESC, SHORTCUT_ID, has_shortcut_portal,  # noqa: E402
                                 set_autostart, snippets)
from .system.portal import Portal, ScreenCast  # noqa: E402
from .system.tray import RecordingTray  # noqa: E402


class CaptureApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
        self.win = None
        self.view = None
        self.ready = False
        self.pending_capture = False
        self.pending_welcome = False
        self.output = None
        self.capture_n = 0
        self.full_input = False
        self.rects = []
        self.recorder = Recorder()
        self.levels = LevelMonitor(self.post)
        self.jobs = {}  # request id → Popen (cancellable exports)
        self.input = InputRegion()
        self.tray = RecordingTray(self._on_tray)
        self.cfg = load_config()
        self.portal = None
        self.cast = None
        self.welcome = None
        self.layer = False      # overlay is a layer-shell surface (else a full-screen window)
        self.backend = "direct"  # how we capture: direct (wlr-screencopy) | portal | x11
        self.rec_hidden = False  # window mode: overlay stays hidden while recording
        self.capture_hidden = False
        self.media_ok = media_playback_ok()
        for name, fn in (("capture", lambda *_: self.trigger()),
                         ("welcome", lambda *_: self.show_welcome()),
                         ("rec-stop", lambda *_: self.post({"type": "tray", "action": "stop"})),
                         ("rec-discard", lambda *_: self.post({"type": "tray", "action": "discard"}))):
            act = Gio.SimpleAction.new(name, None)
            act.connect("activate", fn)
            self.add_action(act)
        if DEV:
            # Developer hook: run JS in the UI (gdbus … org.gtk.Actions.Activate eval ['<js>'] {}).
            ev = Gio.SimpleAction.new("eval", GLib.VariantType.new("s"))
            ev.connect("activate", lambda _a, js: self.view.call_async_javascript_function(
                f"return JSON.stringify(await (async () => {{ {js.get_string()} }})())", -1, None, None, None, None,
                lambda v, res: log("eval:", self._eval_result(v, res))))
            self.add_action(ev)
        quit_act = Gio.SimpleAction.new("quit", None)
        quit_act.connect("activate", lambda *_: self.quit())
        self.add_action(quit_act)

    # ---- lifecycle

    def do_startup(self):
        Gtk.Application.do_startup(self)
        RUNTIME.mkdir(parents=True, exist_ok=True)
        CACHE.mkdir(parents=True, exist_ok=True)
        self._detect()
        self._build_overlay()
        self._restore_shortcut()
        self.hold()  # stay alive between captures

    def _detect(self):
        """Pick the overlay kind and capture backend for this desktop.
        KUSTIK_OVERLAY=window and KUSTIK_BACKEND=portal|x11 force them (testing)."""
        display = Gdk.Display.get_default()
        x11 = type(display).__name__.startswith("X11")
        force_overlay = os.environ.get("KUSTIK_OVERLAY")
        self.layer = (not x11 and LayerShell is not None and LayerShell.is_supported() and force_overlay != "window")
        self.portal = Portal(APP_ID)
        forced = os.environ.get("KUSTIK_BACKEND")
        if forced in ("direct", "portal", "x11"):
            self.backend = forced
        elif not x11 and direct_capture_works():
            self.backend = "direct"
        elif self.portal.version("Screenshot"):
            self.backend = "portal"
        else:
            self.backend = "x11" if x11 else "portal"
        self.cast_ok = self.backend == "direct" or (self.backend == "portal" and self.portal.version("ScreenCast") > 0) or x11
        self.x11 = x11
        log(f"overlay: {'layer-shell' if self.layer else 'full-screen window'} · capture: {self.backend}"
            f"{'' if self.cast_ok else ' (no screen recording available)'}")

    def do_command_line(self, cmd):
        args = cmd.get_arguments()[1:]
        if "--quit" in args:
            self.quit()
        elif "--capture" in args:
            self.trigger()
        elif "--daemon" not in args and "--gapplication-service" not in args:
            self.show_welcome()  # opened from the app menu
        return 0

    def do_shutdown(self):
        self.levels.stop()
        self.tray.hide()
        if self.recorder.active:
            self.recorder.stop(discard=False)
        Gtk.Application.do_shutdown(self)

    @staticmethod
    def _eval_result(view, res):
        try:
            v = view.call_async_javascript_function_finish(res)
            return v.to_string() if v else None
        except GLib.Error as e:
            return f"ERR {e.message}"

    # ---- overlay

    def _build_overlay(self):
        self.recorder.warm()
        win = Gtk.Window(application=self)
        win.set_title("Kustik Screenshot")
        if self.layer:
            LayerShell.init_for_window(win)
            LayerShell.set_layer(win, LayerShell.Layer.OVERLAY)
            LayerShell.set_namespace(win, "kustik-screenshot")
            for edge in (LayerShell.Edge.LEFT, LayerShell.Edge.RIGHT, LayerShell.Edge.TOP, LayerShell.Edge.BOTTOM):
                LayerShell.set_anchor(win, edge, True)
            LayerShell.set_exclusive_zone(win, -1)
            LayerShell.set_keyboard_mode(win, LayerShell.KeyboardMode.NONE)
        else:
            # No overlay layer (GNOME, X11): a borderless full-screen window,
            # shown only while there's something on it.
            win.set_decorated(False)
            win.connect("close-request", lambda *_: self.post({"type": "key", "key": "Escape"}) or True)

        css = Gtk.CssProvider()
        css.load_from_string("window, window > * { background: transparent; }")
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        # WebKit's web process is sandboxed: <video> (GStreamer runs in there)
        # can't read files the sandbox doesn't list. Images load through
        # another process, which is why screenshots worked but recordings
        # showed black. Give it read-only access to the app's own folders.
        ctx = WebKit.WebContext.get_default()
        for d in (VIDEOS, CACHE, RUNTIME, PICTURES):
            d.mkdir(parents=True, exist_ok=True)
            ctx.add_path_to_sandbox(str(d), True)

        ucm = WebKit.UserContentManager()
        ucm.register_script_message_handler("native", None)
        ucm.connect("script-message-received::native", self._on_message)
        view = WebKit.WebView(user_content_manager=ucm)
        view.set_background_color(Gdk.RGBA(0, 0, 0, 0))
        s = view.get_settings()
        s.set_allow_file_access_from_file_urls(True)
        s.set_allow_universal_access_from_file_urls(True)
        s.set_media_playback_requires_user_gesture(False)
        s.set_enable_webgl(True)
        s.set_hardware_acceleration_policy(WebKit.HardwareAccelerationPolicy.ALWAYS)
        s.set_enable_write_console_messages_to_stdout(True)
        s.set_enable_developer_extras(bool(os.environ.get("KUSTIK_DEVTOOLS")))
        view.connect("context-menu", lambda *_: True)  # no "Reload / Inspect" menu
        # The overlay must never zoom: a touchpad pinch would scale the page and
        # every input rect we hand the compositor would stop matching the UI.
        for ctl in list(view.observe_controllers()):
            if isinstance(ctl, Gtk.GestureZoom):
                view.remove_controller(ctl)
        view.connect("notify::zoom-level", lambda v, _p: v.get_zoom_level() != 1.0 and v.set_zoom_level(1.0))
        win.set_child(view)
        self.win, self.view = win, view

        win.connect("realize", lambda *_: GLib.idle_add(self._apply_input))
        win.connect("notify::default-width", lambda *_: GLib.idle_add(self._apply_input))
        view.connect("load-changed", self._on_load)
        view.connect("load-failed", lambda _v, _e, uri, err: log("UI load failed:", uri, err.message) or False)
        view.get_context().connect("notify", lambda *_: None)
        view.connect("web-process-terminated", self._on_crash)
        view.load_uri(file_url(UI))
        if self.layer:
            win.present()
        else:
            win.realize()  # load the UI now; the window appears on the first capture

    def _on_crash(self, view, reason):
        # Recover instead of leaving a dead overlay: reload the UI.
        log("web process terminated:", reason, "- reloading UI")
        self.ready = False
        self.set_input(False, False, [])
        GLib.timeout_add(400, lambda: view.reload() or False)

    def _on_load(self, view, event):
        if event == WebKit.LoadEvent.FINISHED:
            def check():
                if not self.ready:
                    view.evaluate_javascript("JSON.stringify({native: typeof window.nativeReceive, mods: document.scripts.length, err: window.__bootError || null})",
                                             -1, None, None, None, lambda v, res: log("UI boot check:", v.evaluate_javascript_finish(res).to_string()))
                return False
            GLib.timeout_add(1500, check)

    def _apply_input(self):
        surface = self.win.get_surface() if self.win else None
        if surface:
            if self.full_input:
                self.input.apply(surface, [(0, 0, self.win.get_width() or 10000, self.win.get_height() or 10000)])
            else:
                self.input.apply(surface, self.rects)
        return False

    def set_input(self, full, keyboard, rects=()):
        self.full_input = full
        self.rects = [tuple(r) for r in rects]
        if self.layer:
            LayerShell.set_keyboard_mode(self.win, LayerShell.KeyboardMode.EXCLUSIVE if keyboard else LayerShell.KeyboardMode.NONE)
        else:
            # A window can't float click-through above the desktop forever:
            # show it while there's UI on it, hide it otherwise.
            want = (full or bool(self.rects)) and not self.rec_hidden
            if want and not self.win.get_visible():
                self.win.fullscreen()
                self.win.present()
            elif not want and self.win.get_visible():
                self.win.set_visible(False)
        if keyboard:
            self.view.grab_focus()
        self._apply_input()

    def _bind_monitor(self, name):
        if not self.layer:
            return
        for m in all_monitors():
            if m.get_connector() == name:
                if LayerShell.get_monitor(self.win) != m:
                    self.win.set_visible(False)
                    LayerShell.set_monitor(self.win, m)
                    self.win.set_visible(True)
                return

    def _surface_monitor(self):
        surface = self.win.get_surface()
        return Gdk.Display.get_default().get_monitor_at_surface(surface) if surface else None

    def _resolve_output(self, done):
        """Find the output the user is on, then done(output dict).
        niri tells us; elsewhere the compositor places a surface that names no
        output on the focused one, so re-map the overlay that way and ask GTK."""
        out = focused_output()
        if out:
            self._bind_monitor(out["name"])
            return done(out)
        if not self.layer:
            # The full-screen window lands on the compositor's choice: show it
            # (transparent: the UI is idle) and read back where it went.
            self.win.fullscreen()
            self.win.present()
        else:
            self.win.set_visible(False)
            LayerShell.set_monitor(self.win, None)
            self.win.set_visible(True)

        def placed():
            m = self._surface_monitor() or (all_monitors() or [None])[0]
            done(monitor_info(m) if m else None)
        self.after_frames(2, placed, timeout=300)

    # ---- UI messages

    def post(self, msg):
        if self.view:
            self.view.evaluate_javascript(f"window.nativeReceive && window.nativeReceive({json.dumps(msg)})", -1, None, None, None, None, None)
        return False

    def reply(self, rid, data=None, error=None):
        if rid is None:
            return False
        self.post({"type": "error", "id": rid, "error": str(error)} if error else {"type": "reply", "id": rid, "data": data or {}})
        return False

    def _on_message(self, _ucm, value):
        try:
            msg = json.loads(value.to_string())
        except ValueError:
            return
        kind, rid = msg.get("type"), msg.get("id")
        handler = getattr(self, "on_" + kind.replace("-", "_"), None)
        if not handler:
            log("unknown message", kind)
            return
        try:
            handler(msg, rid)
        except Exception as e:  # report to the UI instead of dying
            log(f"{kind} failed:", repr(e))
            self.reply(rid, error=e)

    def run_async(self, rid, fn):
        """Run fn() on a worker thread and reply with its result."""
        def work():
            try:
                data = fn()
                GLib.idle_add(self.reply, rid, data)
            except Exception as e:
                log("job failed:", repr(e))
                GLib.idle_add(self.reply, rid, None, e)
        threading.Thread(target=work, daemon=True).start()

    def on_ready(self, msg, rid):
        self.ready = True
        log("UI ready" + ("" if self.media_ok else " (no GStreamer playback plugins: previews show still frames)"))
        self.post(self._config())
        if self.backend == "direct" and self.layer:  # only an always-there overlay can be tested
            self.post({"type": "probe"})
        if self.pending_capture:
            self.pending_capture = False
            self.trigger()
        if self.pending_welcome:
            self.pending_welcome = False
            self.show_welcome()

    def _config(self):
        return {"type": "config", "mediaOk": self.media_ok, "captureHidden": self.capture_hidden,
                "overlay": "layer" if self.layer else "window", "canRecord": self.cast_ok}

    def on_probe_ready(self, msg, rid):
        """Is our overlay in screen captures? Look for the UI's magenta marker.
        Only "hidden" changes behaviour (the bar may then overlap the recording),
        so it must be certain: the marker has to be missing from three captures
        taken after the overlay has painted."""
        out = focused_output()
        if not out:
            self.reply(rid, {})
            return
        path = RUNTIME / "probe.png"

        def marker_seen():
            res = subprocess.run([str(HELPER), "screenshot", "--output", out["name"], str(path)], capture_output=True)
            if res.returncode != 0:
                return True  # can't tell: assume visible
            try:
                pb = GdkPixbuf.Pixbuf.new_from_file(str(path))
                px, rs, n = pb.get_pixels(), pb.get_rowstride(), pb.get_n_channels()
                for y in (1, pb.get_height() - 2):  # top-left, or bottom-left if the frame is flipped
                    i = y * rs + n
                    if px[i] > 200 and px[i + 1] < 60 and px[i + 2] > 200:
                        return True
                return False
            except Exception as e:
                log("probe failed:", e)
                return True
            finally:
                path.unlink(missing_ok=True)

        tries = {"n": 0}

        def attempt():
            if marker_seen():
                return finish(False)
            tries["n"] += 1
            if tries["n"] >= 3:
                return finish(True)
            GLib.timeout_add(400, lambda: self.after_frames(2, attempt, timeout=600) or False)

        def finish(hidden):
            self.capture_hidden = hidden
            log("overlay excluded from screen captures" if hidden else
                "overlay visible in screen captures (recording bar stays outside the recorded area)")
            self.post(self._config())
            self.reply(rid, {})

        self.after_frames(2, attempt, timeout=600)

    # ---- tray indicator (full-screen recordings)

    def _on_tray(self, action):
        self.post({"type": "tray", "action": action})
        return False

    def on_tray_show(self, msg, rid):
        self.reply(rid, {"ok": self.tray.show()})

    def on_tray_update(self, msg, rid):
        self.tray.update(msg.get("time"), msg.get("paused"))

    def on_tray_hide(self, msg, rid):
        self.tray.hide()

    def on_painted(self, msg, rid):
        """The UI has drawn its current state (after the window was hidden)."""
        if not self.layer:
            self.win.set_opacity(1)

    def on_log(self, msg, rid):
        log("ui:", msg.get("text"))

    def on_input(self, msg, rid):
        self.set_input(bool(msg.get("full")), bool(msg.get("keyboard")), msg.get("rects") or [])

    def on_prepared(self, msg, rid):
        # The UI hid its own floating bits; now freeze the screen.
        if msg.get("skip"):
            return
        self._take_screenshot()

    # ---- capture

    def trigger(self):
        """The shortcut: the UI hides its toast, we freeze the screen, the UI opens."""
        if not self.ready:
            self.pending_capture = True
            return
        self.post({"type": "prepare"})

    def _take_screenshot(self):
        self.capture_n += 1
        path = RUNTIME / f"screen-{self.capture_n % 2}.png"
        t0 = time.monotonic()

        def opened(out):
            # Take the keyboard right away so the first key press isn't lost.
            self.set_input(True, True)
            self.post({"type": "capture", "img": f"{file_url(path)}?{self.capture_n}",
                       "windows": window_targets(out["name"]), "output": out})
            log(f"capture in {(time.monotonic() - t0) * 1000:.0f} ms ({self.backend})")

        if self.backend == "direct":
            def got_output(out):
                if not out:
                    return log("no output to capture")
                self.output = out
                res = subprocess.run([str(HELPER), "screenshot", "--output", out["name"], str(path)], capture_output=True, text=True)
                if res.returncode != 0:
                    return log("screenshot failed:", res.stderr.strip())
                opened(out)
            return self._resolve_output(got_output)

        # Portal / X11: grab the whole desktop first (before our window can
        # cover anything), then open on the monitor the compositor picks and
        # cut that monitor out of the image.
        def got_desktop(src, err):
            if not src:
                log("screenshot failed:", err)
                return self.post({"type": "capture-failed", "error": err or "failed"})

            def got_output(out):
                if not out:
                    return log("no monitor")
                self.output = out
                try:
                    crop_to_monitor(src, out, path)
                except Exception as e:
                    return log("screenshot crop failed:", e)
                finally:
                    if self.backend == "portal":
                        Path(src).unlink(missing_ok=True)  # the portal's copy; ours is cropped
                opened(out)
            self._resolve_output(got_output)

        if self.backend == "portal":
            self.portal.screenshot(got_desktop)
        else:
            got_desktop(*x11_grab(RUNTIME / "x11.png"))

    # ---- images

    def _write_png(self, b64, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(base64.b64decode(b64))
        return path

    def on_copy_image(self, msg, rid):
        path = self._write_png(msg["png"], CACHE / "clip" / f"Screenshot {stamp()}.png")
        clipboard.copy("image/png", path.read_bytes())
        self.reply(rid, {"path": str(path)})

    def on_save_image(self, msg, rid):
        path = self._write_png(msg["png"], unique(PICTURES / f"Screenshot {stamp()}.png"))
        self.reply(rid, {"path": str(path), "dir": pretty_dir(PICTURES)})

    def on_save_file(self, msg, rid):
        src = Path(msg["path"])
        dest_dir = PICTURES if msg.get("kind") == "image" else VIDEOS
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = src if src.parent == dest_dir else unique(dest_dir / src.name)
        if dest != src:
            shutil.copy2(src, dest)
        self.reply(rid, {"path": str(dest), "dir": pretty_dir(dest_dir)})


    # ---- audio

    def on_list_mics(self, msg, rid):
        mics, default = list_mics()
        self.reply(rid, {"mics": mics, "default": default})

    def on_mic_monitor(self, msg, rid):
        self.levels.set(msg.get("source"))

    # ---- recording

    def on_record_start(self, msg, rid):
        if not self.output:
            raise RuntimeError("no output")
        self.levels.stop()  # the recorder opens the mic itself
        region, cursor = msg["region"], bool(msg.get("cursor"))
        audio = (msg.get("mic"), bool(msg.get("sys")))
        reply = lambda _r, err: self.reply(rid, {}, error=err) or False  # noqa: E731

        if self.backend == "direct":
            source = HelperSource(HELPER, self.output["name"], region, cursor, Recorder.FPS)
            # Queue the start now, so a pause/stop sent meanwhile stays behind
            # it, but let it begin only once the UI's last change (whatever it
            # hid so it isn't in the video) is on screen.
            painted = threading.Event()

            def start():
                painted.wait(1.0)
                self.recorder.start(source, *audio)
            self.recorder.run(start, reply)
            self.after_frames(2, painted.set)
            if not self.layer:
                self._recording_ui(True)
            return

        if self.backend == "x11":
            o = self.output
            r = dict(region, x=region["x"] + o["x"], y=region["y"] + o["y"])
            self._recording_ui(True)
            self.recorder.run(lambda: self.recorder.start(X11Source(r, cursor, int(Recorder.FPS)), *audio), reply)
            return

        # Portal: the desktop may ask which screen to share, so get out of the
        # way of its dialog first.
        self.win.set_visible(False)
        self.cast = ScreenCast(self.portal)

        def started(ok, info):
            if not ok:
                self.cast = None
                self.rec_hidden = False
                self.set_input(self.full_input, False, self.rects)
                if self.layer:
                    self.win.set_visible(True)
                return self.reply(rid, error=info.get("error", "failed"))
            if info.get("restore_token"):
                self.cfg["cast_token"] = info["restore_token"]
                save_config(self.cfg)
            self._recording_ui(True)
            source = PipeWireSource(info["fd"], info["node"], region, self.output["w"], int(Recorder.FPS))
            self.recorder.run(lambda: self.recorder.start(source, *audio), reply)

        def closed():  # stopped from the desktop's own screen-sharing indicator
            log("screen cast closed by the desktop")
            self.post({"type": "tray", "action": "stop"})
        self.cast.start(cursor, self.cfg.get("cast_token"), started, closed)

    def _recording_ui(self, on):
        """Layer overlay: the pill/tray stay. Window overlay: the window can't
        stay above the apps being recorded, so it hides and a notification (and
        the tray, if any) carries the controls."""
        if self.layer:
            if on:
                self.win.set_visible(True)
            return
        self.rec_hidden = on
        if on:
            self.win.set_visible(False)
            n = Gio.Notification.new("Recording")
            n.set_body("Press your shortcut again to stop and copy.")
            n.set_priority(Gio.NotificationPriority.HIGH)
            n.add_button("Stop and copy", "app.rec-stop")
            n.add_button("Discard", "app.rec-discard")
            self.send_notification("recording", n)
        else:
            self.withdraw_notification("recording")

    def after_frames(self, n, fn, timeout=200):
        clock = self.win.get_frame_clock() if self.win else None
        if not clock:
            fn()
            return
        state = {"n": n, "done": False}

        def fire():
            if not state["done"]:
                state["done"] = True
                clock.disconnect(hid)
                fn()
            return False

        def on_paint(_clock):
            state["n"] -= 1
            if state["n"] <= 0:
                fire()
        hid = clock.connect("after-paint", on_paint)
        self.win.queue_draw()
        GLib.timeout_add(timeout, fire)

    def on_record_pause(self, msg, rid):
        self.recorder.run(self.recorder.pause)

    def on_record_resume(self, msg, rid):
        self.recorder.run(self.recorder.resume)

    def on_record_stop(self, msg, rid):
        discard = bool(msg.get("discard"))
        self._recording_ui(False)
        cast, self.cast = self.cast, None

        def finish():
            final = self.recorder.stop(discard)
            if not final:
                return {}
            info = probe(final)
            clipboard.copy_file(final)
            thumbs, cache, cache_w = preview_frames(final, info["dur"])
            return {"path": str(final), "url": file_url(final), "dur": info["dur"], "w": info["w"], "h": info["h"],
                    "hasAudio": info["audio"], "size": final.stat().st_size, "thumbs": thumbs, "cache": cache, "cacheW": cache_w}
        def done(res, err):
            if cast:
                cast.close()
            if not self.layer and res and res.get("path"):
                # The result toast lives in the window: bring it back (click-
                # through until the UI says where the toast is).
                # Its last frame is from before the recording: keep it invisible
                # until the page has painted what it shows now.
                self.rects = []
                self.win.set_opacity(0)
                self.win.fullscreen()
                self.win.present()
                self._apply_input()
                GLib.timeout_add(3000, lambda: self.win.set_opacity(1) or False)  # fallback
            self.reply(rid, res, error=err)
            return False
        self.recorder.run(finish, done)

    # ---- welcome pill: shortcut, start on login

    def _restore_shortcut(self):
        if self.cfg.get("shortcut") and has_shortcut_portal(self.portal):
            self.portal.bind_shortcut(SHORTCUT_ID, SHORTCUT_DESC, SHORTCUT, lambda _id: self.trigger(),
                                      lambda ok, desc: log("shortcut:", desc if ok else "not bound"))

    def show_welcome(self):
        """Opened from the app menu: the overlay shows the welcome pill on the
        monitor the user is on."""
        if not self.ready:
            self.pending_welcome = True
            return
        info = {"shortcutPortal": has_shortcut_portal(self.portal), "shortcut": self.cfg.get("shortcut") or "",
                "autostart": self.cfg.get("autostart", False), "snippets": snippets()}

        def placed(out):
            if out:
                self.output = out
            self.post({"type": "welcome", "info": info})
        if self.layer:
            self._resolve_output(placed)
        else:
            placed(None)  # the window opens where the compositor puts it
        self.cfg["welcomed"] = True
        save_config(self.cfg)

    def on_w_bind(self, msg, rid):
        def bound(ok, desc):
            if ok:
                self.cfg["shortcut"] = desc or "Super+Shift+S"
                save_config(self.cfg)
            self.reply(rid, {"ok": ok, "shortcut": self.cfg.get("shortcut", "") if ok else ""})
        self.portal.bind_shortcut(SHORTCUT_ID, SHORTCUT_DESC, SHORTCUT, lambda _id: self.trigger(), bound)

    def on_w_login(self, msg, rid):
        on = bool(msg.get("on"))

        def done(ok):
            if ok:
                self.cfg["autostart"] = on
                save_config(self.cfg)
            self.reply(rid, {"ok": ok, "on": self.cfg.get("autostart", False)})
        set_autostart(self.portal, on, done)

    def on_w_copy(self, msg, rid):
        clipboard.copy("text/plain;charset=utf-8", msg.get("text", "").encode())
        self.reply(rid, {})

    def on_w_try(self, msg, rid):
        GLib.timeout_add(200, lambda: self.trigger() or False)  # let the pill leave the screen first

    # ---- export (trim / GIF)

    def on_export(self, msg, rid):
        src = Path(msg["path"])
        a, b, fmt, action = float(msg["a"]), float(msg["b"]), msg.get("fmt", "video"), msg.get("action", "copy")
        full = a <= 0.01 and b >= float(msg.get("dur", b)) - 0.01
        gif = fmt == "gif"
        if not gif and full:
            # Nothing to re-encode: the recording itself is the result.
            if action == "copy":
                clipboard.copy_file(src)
            info = probe(src)
            self.reply(rid, {"kind": "video", "path": str(src), "url": file_url(src), "dur": info["dur"], "w": info["w"],
                             "h": info["h"], "size": src.stat().st_size, "dir": pretty_dir(VIDEOS), "trimmed": False})
            return
        ext = "gif" if gif else "mp4"
        if action == "save":
            VIDEOS.mkdir(parents=True, exist_ok=True)
            out = unique(VIDEOS / f"{src.stem}{' (trimmed)' if not gif else ''}.{ext}")
        else:
            (CACHE / "exports").mkdir(parents=True, exist_ok=True)
            out = CACHE / "exports" / f"{src.stem}{' (trimmed)' if not gif else ''}.{ext}"
        cmd = export_command(src, a, b, gif, out)
        total = max(0.01, b - a)

        def work():
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.jobs[rid] = proc
            for line in proc.stdout:
                if line.startswith("out_time_us="):
                    try:
                        p = int(line.split("=")[1]) / 1e6 / total
                        GLib.idle_add(self.post, {"type": "progress", "id": rid, "p": round(min(1, p), 3)})
                    except ValueError:
                        pass
            proc.wait()
            self.jobs.pop(rid, None)
            if proc.returncode != 0:
                raise RuntimeError(proc.stderr.read().strip()[-300:] or "cancelled")
            if action == "copy":
                clipboard.copy_file(out)
            info = probe(out)
            return {"kind": "gif" if gif else "video", "path": str(out), "url": file_url(out), "dur": info["dur"] or total,
                    "w": info["w"], "h": info["h"], "size": out.stat().st_size, "dir": pretty_dir(out.parent), "trimmed": not full}
        self.run_async(rid, work)

    def on_cancel(self, msg, rid):
        proc = self.jobs.pop(msg.get("target"), None)
        if proc:
            proc.terminate()


def detach_stdin():
    """A background job that reads the terminal gets suspended by the shell
    (SIGTTIN), and so would we, with every child that inherits stdin. The
    app never reads the terminal: point stdin at /dev/null for good."""
    fd = os.open(os.devnull, os.O_RDONLY)
    os.dup2(fd, 0)
    os.close(fd)


def main():
    if DEV:
        faulthandler.enable(all_threads=True)  # native crashes → Python stacks in the log
        faulthandler.register(signal.SIGUSR2, all_threads=True)  # kill -USR2 → stacks in the log
    detach_stdin()
    if not HELPER.exists():
        log(f"note: kustik-screenshot-helper isn't built ({ROOT / 'helper'}); using the desktop portal")
    for tool in ("ffmpeg", "ffprobe", "pactl", "parec"):
        if not shutil.which(tool):
            log(f"warning: {tool} not found; some features won't work")
    app = CaptureApp()

    # Ctrl+C, kill, logout: quit like `--quit` does (a recording in progress is
    # finished and saved, the tray icon goes), without a traceback.
    def stop(signame):
        log(f"{signame}: quitting")
        app.quit()
        return GLib.SOURCE_REMOVE
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        unix_signal_add(GLib.PRIORITY_HIGH, sig, stop, sig.name)
    return app.run(sys.argv)
