"""Serve the showcase while you work on it: the same layout `site/build.sh`
publishes (the page at /, the app's UI under /ui/, the icon at /icon.svg),
read straight from the source folders and never cached, so a reload always
runs the latest files. Rebuild the UI bundle (ui/build.sh) after UI changes.

    python3 site/tools/serve.py [port]      # then open http://127.0.0.1:5182/
"""
import http.server
import posixpath
import sys
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# URL prefix → source (the same mapping as site/build.sh)
MOUNTS = [
    ("/ui/", ROOT / "ui"),
    ("/icon.svg", ROOT / "flatpak" / "xyz.kustik.Screenshot.svg"),
    ("/", ROOT / "site"),
]


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        url = urllib.parse.unquote(path.split("?", 1)[0].split("#", 1)[0])
        for prefix, src in MOUNTS:
            if url == prefix or (prefix.endswith("/") and url.startswith(prefix)):
                if src.is_file():
                    return str(src)
                rest = posixpath.normpath(url[len(prefix):]).lstrip("/")
                if rest == ".." or rest.startswith("../"):
                    break
                return str(src if rest == "." else src / rest)
        return str(ROOT / "site" / "404")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 5182
print(f"http://127.0.0.1:{port}/")
http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
