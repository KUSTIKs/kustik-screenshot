"""Recording indicator in the system tray (StatusNotifierItem + DBusMenu).

Used for full-screen recordings, where an on-screen control would end up in the
video. Works with any tray host that speaks the StatusNotifierItem protocol
(KDE, waybar, noctalia/Quickshell, GNOME with the AppIndicator extension).

Left click stops the recording; the menu has Pause/Resume, Stop and Discard.
"""

import math
import os

from gi.repository import Gio, GLib

SNI_XML = """
<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
    <signal name="NewTitle"/>
    <signal name="NewIcon"/>
    <signal name="NewToolTip"/>
    <signal name="NewStatus"><arg name="status" type="s"/></signal>
  </interface>
</node>
"""

MENU_XML = """
<node>
  <interface name="com.canonical.dbusmenu">
    <property name="Version" type="u" access="read"/>
    <property name="TextDirection" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconThemePath" type="as" access="read"/>
    <method name="GetLayout">
      <arg name="parentId" type="i" direction="in"/>
      <arg name="recursionDepth" type="i" direction="in"/>
      <arg name="propertyNames" type="as" direction="in"/>
      <arg name="revision" type="u" direction="out"/>
      <arg name="layout" type="(ia{sv}av)" direction="out"/>
    </method>
    <method name="GetGroupProperties">
      <arg name="ids" type="ai" direction="in"/>
      <arg name="propertyNames" type="as" direction="in"/>
      <arg name="properties" type="a(ia{sv})" direction="out"/>
    </method>
    <method name="GetProperty">
      <arg name="id" type="i" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="value" type="v" direction="out"/>
    </method>
    <method name="Event">
      <arg name="id" type="i" direction="in"/>
      <arg name="eventId" type="s" direction="in"/>
      <arg name="data" type="v" direction="in"/>
      <arg name="timestamp" type="u" direction="in"/>
    </method>
    <method name="EventGroup">
      <arg name="events" type="a(isvu)" direction="in"/>
      <arg name="idErrors" type="ai" direction="out"/>
    </method>
    <method name="AboutToShow">
      <arg name="id" type="i" direction="in"/>
      <arg name="needUpdate" type="b" direction="out"/>
    </method>
    <method name="AboutToShowGroup">
      <arg name="ids" type="ai" direction="in"/>
      <arg name="updatesNeeded" type="ai" direction="out"/>
      <arg name="idErrors" type="ai" direction="out"/>
    </method>
    <signal name="LayoutUpdated"><arg name="revision" type="u"/><arg name="parent" type="i"/></signal>
    <signal name="ItemsPropertiesUpdated">
      <arg name="updatedProps" type="a(ia{sv})"/>
      <arg name="removedProps" type="a(ias)"/>
    </signal>
  </interface>
</node>
"""

ITEM_PATH = "/StatusNotifierItem"
MENU_PATH = "/MenuBar"

# Menu item ids
STOP, PAUSE, SEP, DISCARD = 1, 2, 3, 4


def _pixmap(size, rgb, halo=0.0, halo_a=0.0):
    """ARGB32 (network byte order) for IconPixmap: a solid dot plus an optional
    soft halo ring around it (radius `halo` as a fraction of size, alpha `halo_a`)."""
    r0, g0, b0 = rgb
    data = bytearray()
    c = (size - 1) / 2
    rad = size * 0.30
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - c, y - c)
            dot = max(0.0, min(1.0, rad + 0.5 - d))
            ring = 0.0
            if halo_a > 0:
                # filled disc from the dot out to the halo edge, antialiased
                ring = max(0.0, min(1.0, size * halo + 0.5 - d)) * halo_a
            a = dot + ring * (1 - dot)
            if a <= 0.003:
                data += b"\x00\x00\x00\x00"
                continue
            data += bytes([int(a * 255), r0, g0, b0])
    return (size, size, bytes(data))


SIZES = (16, 22, 32, 48)
PULSE_FRAMES = 14  # one beat ≈ 1.4 s at 100 ms per frame


def _icon_variant(pixmaps):
    """a(iiay) built from raw bytes in one go. Building it from Python values
    packs every byte separately, which is far too slow to do on each refetch."""
    return GLib.Variant.new_array(GLib.VariantType("(iiay)"), [
        GLib.Variant.new_tuple(GLib.Variant("i", w), GLib.Variant("i", h),
                               GLib.Variant.new_from_bytes(GLib.VariantType("ay"), GLib.Bytes.new(data), True))
        for w, h, data in pixmaps])


def _pulse_frames():
    """A 'live' beacon: the halo swells out of the dot and fades, then rests."""
    frames = []
    for i in range(PULSE_FRAMES):
        t = i / PULSE_FRAMES
        k = min(1.0, t / 0.75)                  # swell during the first 3/4, rest after
        ease = 1 - (1 - k) ** 3                 # ease-out: quick start, soft landing
        halo = 0.30 + 0.20 * ease               # dot edge → icon edge
        alpha = 0.55 * (1 - ease) if t < 0.75 else 0.0
        frames.append(_icon_variant([_pixmap(s, (255, 59, 48), halo, alpha) for s in SIZES]))
    return frames


class RecordingTray:
    def __init__(self, on_action):
        self.on_action = on_action  # called with 'stop' | 'pause' | 'resume' | 'discard'
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.sni_info = Gio.DBusNodeInfo.new_for_xml(SNI_XML).interfaces[0]
        self.menu_info = Gio.DBusNodeInfo.new_for_xml(MENU_XML).interfaces[0]
        self.reg_ids = []
        self.name_id = 0
        self.visible = False
        self.paused = False
        self.time = "0:00"
        self.revision = 1
        # PID-ID per the spec. Inside a sandbox (Flatpak) PIDs are tiny and shared
        # between apps, so the ID part comes from our unique bus name (":1.234").
        conn = "".join(ch for ch in (self.bus.get_unique_name() or "") if ch.isdigit()) or "1"
        self.service = f"org.kde.StatusNotifierItem-{os.getpid()}-{conn}"
        self._frames = None  # pulse frames, built on first show
        self._pix_pause = None
        self._frame = 0
        self._timer = 0

    # ---- availability

    def available(self):
        try:
            res = self.bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                                     "NameHasOwner", GLib.Variant("(s)", ("org.kde.StatusNotifierWatcher",)),
                                     GLib.VariantType("(b)"), Gio.DBusCallFlags.NONE, 500, None)
            if not res.unpack()[0]:
                return False
            hosts = self.bus.call_sync("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
                                       "org.freedesktop.DBus.Properties", "Get",
                                       GLib.Variant("(ss)", ("org.kde.StatusNotifierWatcher", "IsStatusNotifierHostRegistered")),
                                       GLib.VariantType("(v)"), Gio.DBusCallFlags.NONE, 500, None)
            return bool(hosts.unpack()[0])
        except GLib.Error:
            return False

    # ---- show / hide

    def show(self):
        if self.visible:
            return True
        if not self.available():
            return False
        if self._frames is None:
            self._frames = _pulse_frames()
            self._pix_pause = _icon_variant([_pixmap(s, (160, 160, 170)) for s in SIZES])
        self.paused, self.time, self._frame = False, "0:00", 0
        self.reg_ids = [
            self.bus.register_object(ITEM_PATH, self.sni_info, self._sni_call, self._sni_prop, None),
            self.bus.register_object(MENU_PATH, self.menu_info, self._menu_call, self._menu_prop, None),
        ]
        try:
            # Own the name synchronously: the watcher looks it up right away.
            self.bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
                               GLib.Variant("(su)", (self.service, 4)), GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, 1000, None)
            self.name_id = 1
            self.bus.call_sync("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.kde.StatusNotifierWatcher",
                               "RegisterStatusNotifierItem", GLib.Variant("(s)", (self.service,)),
                               None, Gio.DBusCallFlags.NONE, 1000, None)
        except GLib.Error as e:
            print("tray: register failed:", e.message)
            self.hide()
            return False
        self.visible = True
        self._pulse(True)
        return True

    def hide(self):
        self._pulse(False)
        for rid in self.reg_ids:
            self.bus.unregister_object(rid)
        self.reg_ids = []
        if self.name_id:
            try:  # the watcher drops the item when the name goes
                self.bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ReleaseName",
                                   GLib.Variant("(s)", (self.service,)), GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, 1000, None)
            except GLib.Error:
                pass
            self.name_id = 0
        self.visible = False

    def update(self, time=None, paused=None):
        if not self.visible:
            return
        changed_menu = paused is not None and paused != self.paused
        if time is not None:
            self.time = time
        if paused is not None:
            self.paused = paused
        self._emit(ITEM_PATH, "org.kde.StatusNotifierItem", "NewToolTip")
        self._emit(ITEM_PATH, "org.kde.StatusNotifierItem", "NewTitle")
        if changed_menu:
            self._pulse(not self.paused)
            self._emit(ITEM_PATH, "org.kde.StatusNotifierItem", "NewIcon")
            self.revision += 1
            self._emit(MENU_PATH, "com.canonical.dbusmenu", "LayoutUpdated", GLib.Variant("(ui)", (self.revision, 0)))

    def _pulse(self, on):
        """Animate the icon (hosts refetch IconPixmap on NewIcon)."""
        if self._timer:
            GLib.source_remove(self._timer)
            self._timer = 0
        if on:
            self._frame = 0
            self._timer = GLib.timeout_add(100, self._step)

    def _step(self):
        self._frame = (self._frame + 1) % PULSE_FRAMES
        self._emit(ITEM_PATH, "org.kde.StatusNotifierItem", "NewIcon")
        return True

    def _emit(self, path, iface, name, params=None):
        try:
            self.bus.emit_signal(None, path, iface, name, params)
        except GLib.Error:
            pass

    # ---- StatusNotifierItem

    def _title(self):
        return f"{'Paused' if self.paused else 'Recording'} · {self.time}"

    def _sni_prop(self, conn, sender, path, iface, prop):
        pix = self._pix_pause if self.paused else self._frames[self._frame]
        return {
            "Category": GLib.Variant("s", "ApplicationStatus"),
            "Id": GLib.Variant("s", "kustik-screenshot"),
            "Title": GLib.Variant("s", self._title()),
            "Status": GLib.Variant("s", "Active"),
            "IconName": GLib.Variant("s", ""),  # empty: hosts draw the animated pixmap
            "IconPixmap": pix,
            "AttentionIconName": GLib.Variant("s", ""),
            "ToolTip": GLib.Variant("(sa(iiay)ss)", ("", [], self._title(), "Click to stop · right-click for more")),
            "ItemIsMenu": GLib.Variant("b", False),
            "Menu": GLib.Variant("o", MENU_PATH),
        }.get(prop)

    def _sni_call(self, conn, sender, path, iface, method, params, inv):
        if method == "Activate":
            GLib.idle_add(self.on_action, "stop")
        inv.return_value(None)

    # ---- DBusMenu

    def _items(self):
        return [
            (STOP, {"label": GLib.Variant("s", "Stop and copy"), "icon-name": GLib.Variant("s", "media-playback-stop")}),
            (PAUSE, {"label": GLib.Variant("s", "Resume" if self.paused else "Pause"),
                     "icon-name": GLib.Variant("s", "media-playback-start" if self.paused else "media-playback-pause")}),
            (SEP, {"type": GLib.Variant("s", "separator")}),
            (DISCARD, {"label": GLib.Variant("s", "Discard recording"), "icon-name": GLib.Variant("s", "user-trash")}),
        ]

    def _layout(self):
        children = [GLib.Variant("(ia{sv}av)", (i, props, [])) for i, props in self._items()]
        return (0, {"children-display": GLib.Variant("s", "submenu")}, children)

    def _menu_prop(self, conn, sender, path, iface, prop):
        return {
            "Version": GLib.Variant("u", 3),
            "TextDirection": GLib.Variant("s", "ltr"),
            "Status": GLib.Variant("s", "normal"),
            "IconThemePath": GLib.Variant("as", []),
        }.get(prop)

    def _menu_call(self, conn, sender, path, iface, method, params, inv):
        if method == "GetLayout":
            inv.return_value(GLib.Variant("(u(ia{sv}av))", (self.revision, self._layout())))
        elif method == "GetGroupProperties":
            ids = params.unpack()[0]
            items = dict(self._items())
            inv.return_value(GLib.Variant("(a(ia{sv}))", ([(i, items[i]) for i in ids if i in items],)))
        elif method == "GetProperty":
            i, name = params.unpack()
            props = dict(self._items()).get(i, {})
            inv.return_value(GLib.Variant("(v)", (props.get(name, GLib.Variant("s", "")),)))
        elif method == "Event":
            i, event = params.unpack()[0], params.unpack()[1]
            if event == "clicked":
                self._clicked(i)
            inv.return_value(None)
        elif method == "EventGroup":
            for i, event, _data, _ts in params.unpack()[0]:
                if event == "clicked":
                    self._clicked(i)
            inv.return_value(GLib.Variant("(ai)", ([],)))
        elif method == "AboutToShow":
            inv.return_value(GLib.Variant("(b)", (False,)))
        elif method == "AboutToShowGroup":
            inv.return_value(GLib.Variant("(aiai)", ([], [])))
        else:
            inv.return_value(None)

    def _clicked(self, i):
        action = {STOP: "stop", DISCARD: "discard", PAUSE: "resume" if self.paused else "pause"}.get(i)
        if action:
            GLib.idle_add(self.on_action, action)
