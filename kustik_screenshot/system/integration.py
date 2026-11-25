"""Fitting into the desktop: the global shortcut, the command a keybinding
runs, config snippets for compositors without a shortcut portal, and start
on login."""

import os
from pathlib import Path

from gi.repository import GLib

from ..config import APP_ID, FLATPAK, OBJECT_PATH, ROOT

SHORTCUT = "SHIFT+LOGO+s"  # Super+Shift+S, like Windows' snipping shortcut
SHORTCUT_ID = "capture"
SHORTCUT_DESC = "Take a screenshot or recording"


def _desktop():
    return (os.environ.get("XDG_CURRENT_DESKTOP") or "").lower()


def capture_command():
    """The command a keybinding runs: asks the running app (or D-Bus starts it)."""
    return ["gdbus", "call", "--session", "--dest", APP_ID, "--object-path", OBJECT_PATH,
            "--method", "org.gtk.Actions.Activate", "capture", "[]", "{}"]


def launch_command():
    if FLATPAK:
        return ["flatpak", "run", APP_ID]
    return [str(ROOT / "kustik-screenshot")]


def snippets():
    """Config lines for compositors without a shortcut portal."""
    cmd = capture_command()
    sh = " ".join(c if c not in ("[]", "{}") else f"'{c}'" for c in cmd)
    start = launch_command() + ["--daemon"]
    desk = _desktop()
    if "niri" in desk:
        return {"name": "niri", "file": "~/.config/niri/config.kdl", "where": "binds { }",
                "bind": "Mod+Shift+S { spawn " + " ".join(f'"{c}"' for c in cmd) + "; }",
                "start": "spawn-at-startup " + " ".join(f'"{c}"' for c in start)}
    if "sway" in desk:
        return {"name": "Sway", "file": "~/.config/sway/config",
                "bind": f"bindsym $mod+Shift+s exec {sh}", "start": "exec " + " ".join(start)}
    if "hyprland" in desk:
        return {"name": "Hyprland", "file": "~/.config/hypr/hyprland.conf",
                "bind": f"bind = SUPER SHIFT, S, exec, {sh}", "start": "exec-once = " + " ".join(start)}
    if "river" in desk:
        return {"name": "river", "file": "~/.config/river/init",
                "bind": f'riverctl map normal Super+Shift S spawn "{sh}"', "start": " ".join(start) + " &"}
    return {"name": "", "file": "", "bind": sh, "start": " ".join(start)}


def has_shortcut_portal(portal):
    # wlroots compositors may list the portal without being able to serve it.
    return portal.version("GlobalShortcuts") > 0 and not any(d in _desktop() for d in ("niri", "sway", "river"))


def set_autostart(portal, on, done):
    """Start on login (or not); done(ok)."""
    if FLATPAK:
        # The portal writes the autostart entry; the command runs inside the sandbox.
        return portal.request_autostart(on, ["kustik-screenshot", "--daemon"], done)
    f = Path(GLib.get_user_config_dir()) / "autostart" / f"{APP_ID}.desktop"
    if on:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("[Desktop Entry]\nType=Application\nName=Kustik Screenshot\n"
                     f"Exec={' '.join(launch_command())} --daemon\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n")
    else:
        f.unlink(missing_ok=True)
    done(True)
