"""The clipboard. wl-copy where it exists (the clipboard outlives our
focus); otherwise GTK's, served by this long-running process."""

import os
import shutil
import subprocess
import threading

from gi.repository import Gdk, GLib

from ..config import file_url


def copy(mime, data):
    """wl-copy keeps the clipboard after we let go of focus; GTK's
    clipboard (X11, or no wl-copy) is served by this process, which stays."""
    if os.environ.get("WAYLAND_DISPLAY") and shutil.which("wl-copy"):
        try:
            # wl-copy leaves a background process serving the clipboard; it
            # must not inherit pipes we'd wait on, or this blocks until it exits.
            r = subprocess.run(["wl-copy", "--type", mime], input=data, timeout=3,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if r.returncode == 0:
                return
        except (OSError, subprocess.TimeoutExpired):
            pass
    provider = Gdk.ContentProvider.new_for_bytes(mime, GLib.Bytes.new(data))
    Gdk.Display.get_default().get_clipboard().set_content(provider)


def copy_file(path):
    """Copy a file (as a URI list, what file managers and chats paste). Safe
    to call from a worker thread."""
    data = (file_url(path) + "\r\n").encode()
    if threading.current_thread() is threading.main_thread():
        copy("text/uri-list", data)
    else:
        GLib.idle_add(lambda: copy("text/uri-list", data) or False)
