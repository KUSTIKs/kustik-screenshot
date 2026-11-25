"""Who we are, where files go, the settings file, and a few small helpers
shared by the whole app."""

import json
import os
import shutil
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path

from gi.repository import GLib

# Overridable so a test instance (nested compositor) never talks to your real one.
APP_ID = os.environ.get("KUSTIK_APP_ID", "io.github.KUSTIKs.KustikScreenshot")
OBJECT_PATH = "/" + APP_ID.replace(".", "/")
# The app's folder: this package, ui/ and (from source) helper/ live in it.
ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "ui" / "index.html"
# From the source tree, or installed (Flatpak: the helper is in /app/bin).
_BUILT = ROOT / "helper" / "target" / "release" / "kustik-screenshot-helper"
HELPER = _BUILT if _BUILT.exists() else Path(shutil.which("kustik-screenshot-helper") or _BUILT)
FLATPAK = Path("/.flatpak-info").exists()
DEV = bool(os.environ.get("KUSTIK_DEV"))

RUNTIME = Path(os.environ.get("XDG_RUNTIME_DIR", tempfile.gettempdir())) / "kustik-screenshot"
CACHE = Path(GLib.get_user_cache_dir()) / "kustik-screenshot"
CONFIG = Path(GLib.get_user_config_dir()) / "kustik-screenshot" / "config.json"


def special_dir(kind, sub, fallback):
    base = GLib.get_user_special_dir(kind) or str(Path.home() / fallback)
    return Path(base) / sub


PICTURES = special_dir(GLib.UserDirectory.DIRECTORY_PICTURES, "Screenshots", "Pictures")
VIDEOS = special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS, "Recordings", "Videos")


def load_config():
    try:
        return json.loads(CONFIG.read_text())
    except (OSError, ValueError):
        return {}


def save_config(cfg):
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(cfg, indent=2))


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, file=sys.stderr, flush=True)


def stamp():
    return time.strftime("%Y-%m-%d at %H.%M.%S")


def file_url(path):
    return "file://" + urllib.parse.quote(str(path))


def unique(path: Path) -> Path:
    if not path.exists():
        return path
    for i in range(2, 1000):
        p = path.with_name(f"{path.stem} ({i}){path.suffix}")
        if not p.exists():
            return p
    return path


def pretty_dir(path: Path) -> str:
    """'Pictures/Screenshots' style label for toasts."""
    try:
        return str(path.relative_to(Path.home()))
    except ValueError:
        return str(path)
