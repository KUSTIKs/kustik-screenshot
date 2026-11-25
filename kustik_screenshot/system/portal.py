"""XDG desktop portals: the standard way to capture the screen, bind a global
shortcut and start on login on desktops that don't expose wlroots protocols
(GNOME, KDE, COSMIC, X11 sessions…). Everything here is asynchronous and runs
on the GLib main loop; results come back through callbacks.
"""

import itertools
import os

from gi.repository import Gio, GLib

BUS = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"

_tokens = itertools.count(1)


def _token(prefix="kustik"):
    return f"{prefix}{os.getpid()}_{next(_tokens)}"


class Portal:
    def __init__(self, app_id):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.sender = self.bus.get_unique_name()[1:].replace(".", "_")
        self.app_id = app_id
        self._shortcut_session = None
        self._register_host_app()

    # ---- plumbing

    def _register_host_app(self):
        """Outside a sandbox the portal can't tell which app is calling; tell
        it (xdg-desktop-portal ≥ 1.19), so permissions and shortcuts stick."""
        if os.path.exists("/.flatpak-info"):
            return
        try:
            self.bus.call_sync(BUS, PATH, "org.freedesktop.host.portal.Registry", "Register",
                               GLib.Variant("(sa{sv})", (self.app_id, {})), None, Gio.DBusCallFlags.NONE, 1000, None)
        except GLib.Error:
            pass  # older portal: fine, it falls back to guessing

    def version(self, iface):
        try:
            v = self.bus.call_sync(BUS, PATH, "org.freedesktop.DBus.Properties", "Get",
                                   GLib.Variant("(ss)", (f"org.freedesktop.portal.{iface}", "version")),
                                   GLib.VariantType("(v)"), Gio.DBusCallFlags.NONE, 1000, None)
            return int(v.unpack()[0])
        except GLib.Error:
            return 0

    def request(self, iface, method, args_fmt, args, options, done, fd_list=None):
        """Call a portal method that answers with a Request/Response signal.
        `options` gets the handle token; done(ok, results) on the main loop."""
        token = _token()
        options = dict(options)
        options["handle_token"] = GLib.Variant("s", token)
        handle = f"/org/freedesktop/portal/desktop/request/{self.sender}/{token}"
        state = {}

        def on_response(_conn, _sender, _path, _iface, _signal, params):
            self.bus.signal_unsubscribe(state["sub"])
            code, results = params.unpack()
            done(code == 0, results, code)

        state["sub"] = self.bus.signal_subscribe(BUS, "org.freedesktop.portal.Request", "Response", handle, None,
                                                 Gio.DBusSignalFlags.NO_MATCH_RULE, on_response)

        def on_called(conn, res):
            try:
                conn.call_finish(res)
            except GLib.Error as e:
                self.bus.signal_unsubscribe(state["sub"])
                done(False, {"error": e.message}, -1)

        self.bus.call(BUS, PATH, f"org.freedesktop.portal.{iface}", method,
                      GLib.Variant(f"({args_fmt}a{{sv}})", (*args, options)), None,
                      Gio.DBusCallFlags.NONE, -1, None, on_called)

    # ---- screenshot

    def screenshot(self, done):
        """done(path or None, error)"""
        def cb(ok, res, code):
            if not ok:
                return done(None, res.get("error") or ("cancelled" if code == 1 else "failed"))
            uri = res.get("uri", "")
            done(Gio.File.new_for_uri(uri).get_path() if uri else None, None if uri else "no image")
        self.request("Screenshot", "Screenshot", "s", ("",), {"interactive": GLib.Variant("b", False),
                                                            "modal": GLib.Variant("b", False)}, cb)

    # ---- global shortcuts

    def bind_shortcut(self, shortcut_id, description, trigger, on_activated, done):
        """Create a session (once) and bind; done(ok, trigger_description).
        on_activated(shortcut_id) fires whenever the shortcut is pressed (the
        first call's callback: later calls reuse the session)."""
        def bind(session_handle):
            shortcut = (shortcut_id, {"description": GLib.Variant("s", description),
                                      "preferred_trigger": GLib.Variant("s", trigger)})
            self.request("GlobalShortcuts", "BindShortcuts", "oa(sa{sv})s", (session_handle, [shortcut], ""), {},
                         lambda ok, res, _c: done(ok, _describe(res, shortcut_id)))

        if self._shortcut_session:
            return bind(self._shortcut_session)

        def created(ok, res, _code):
            if not ok:
                return done(False, None)
            handle = res["session_handle"]
            self._shortcut_session = handle
            self.bus.signal_subscribe(BUS, "org.freedesktop.portal.GlobalShortcuts", "Activated", PATH, None,
                                      Gio.DBusSignalFlags.NONE,
                                      lambda *a: a[5].unpack()[0] == handle and on_activated(a[5].unpack()[1]))
            bind(handle)
        self.request("GlobalShortcuts", "CreateSession", "", (), {"session_handle_token": GLib.Variant("s", _token("s"))}, created)

    # ---- start on login

    def request_autostart(self, enable, commandline, done):
        opts = {"reason": GLib.Variant("s", "Take screenshots instantly with your shortcut"),
                "autostart": GLib.Variant("b", enable),
                "commandline": GLib.Variant("as", commandline),
                "dbus-activatable": GLib.Variant("b", False)}
        self.request("Background", "RequestBackground", "s", ("",), opts,
                     lambda ok, res, _c: done(ok and bool(res.get("autostart")) == enable))


def _describe(res, shortcut_id):
    for sid, props in res.get("shortcuts", []):
        if sid == shortcut_id:
            return props.get("trigger_description") or ""
    return ""


class ScreenCast:
    """One portal screen-cast session: the desktop asks which screen to share
    (once; the choice is remembered with a restore token) and hands us a
    PipeWire stream of it."""

    MONITOR = 1

    def __init__(self, portal):
        self.p = portal
        self.session = None
        self._closed_sub = None

    def start(self, cursor, restore_token, done, on_closed):
        """done(ok, info) with info = {fd, node, size, restore_token} or {error}."""
        p = self.p

        def fail(msg):
            self.close()
            done(False, {"error": msg})

        def created(ok, res, code):
            if not ok:
                return fail("cancelled" if code == 1 else res.get("error", "screen cast unavailable"))
            self.session = res["session_handle"]
            self._closed_sub = p.bus.signal_subscribe(BUS, "org.freedesktop.portal.Session", "Closed", self.session, None,
                                                      Gio.DBusSignalFlags.NONE, lambda *a: on_closed())
            opts = {"types": GLib.Variant("u", self.MONITOR), "multiple": GLib.Variant("b", False),
                    "persist_mode": GLib.Variant("u", 2)}
            modes = self._cursor_modes()
            want = 2 if cursor else 1  # embedded / hidden
            if modes & want:
                opts["cursor_mode"] = GLib.Variant("u", want)
            if restore_token:
                opts["restore_token"] = GLib.Variant("s", restore_token)
            p.request("ScreenCast", "SelectSources", "o", (self.session,), opts, selected)

        def selected(ok, res, code):
            if not ok:
                return fail("cancelled" if code == 1 else "no source selected")
            p.request("ScreenCast", "Start", "os", (self.session, ""), {}, started)

        def started(ok, res, code):
            if not ok or not res.get("streams"):
                return fail("cancelled" if code == 1 else "no stream")
            node, props = res["streams"][0]
            try:
                ret, fds = p.bus.call_with_unix_fd_list_sync(
                    BUS, PATH, "org.freedesktop.portal.ScreenCast", "OpenPipeWireRemote",
                    GLib.Variant("(oa{sv})", (self.session, {})), GLib.VariantType("(h)"),
                    Gio.DBusCallFlags.NONE, -1, None, None)
                fd = fds.get(ret.unpack()[0])
            except GLib.Error as e:
                return fail(e.message)
            done(True, {"fd": fd, "node": node, "size": props.get("size"), "restore_token": res.get("restore_token")})

        p.request("ScreenCast", "CreateSession", "", (), {"session_handle_token": GLib.Variant("s", _token("s"))}, created)

    def _cursor_modes(self):
        try:
            v = self.p.bus.call_sync(BUS, PATH, "org.freedesktop.DBus.Properties", "Get",
                                     GLib.Variant("(ss)", ("org.freedesktop.portal.ScreenCast", "AvailableCursorModes")),
                                     GLib.VariantType("(v)"), Gio.DBusCallFlags.NONE, 1000, None)
            return int(v.unpack()[0])
        except GLib.Error:
            return 0

    def close(self):
        if self._closed_sub:
            self.p.bus.signal_unsubscribe(self._closed_sub)
            self._closed_sub = None
        if self.session:
            try:
                self.p.bus.call(BUS, self.session, "org.freedesktop.portal.Session", "Close", None, None,
                                Gio.DBusCallFlags.NONE, -1, None, None)
            except GLib.Error:
                pass
            self.session = None
