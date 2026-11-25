# Developing

## Run from the source tree

```sh
./install.sh                  # builds the helper and UI, registers the app for your user
kustik-screenshot             # opens the welcome pill (shortcut + start on login)
kustik-screenshot --capture   # starts a capture
kustik-screenshot --daemon    # runs in the background
kustik-screenshot --quit
```

Needs `webkitgtk-6.0`, `python-gobject`, `ffmpeg`, `libpulse` (`pactl`, `parec`),
GStreamer playback plugins (`gst-plugins-good gst-plugins-bad gst-libav`), and to
build: Rust (`cargo`) and `bun`. On wlroots compositors also
`gtk4-layer-shell` and `wl-clipboard`; on GNOME/KDE, `gst-plugin-pipewire` for
recording through the portal.

## How it fits together

```
kustik_screenshot/        the desktop app (Python package; run as python3 -m kustik_screenshot)
  app.py                  the overlay and the UI's messages; main()
  config.py               app id, paths, settings file, small helpers
  system/                 talking to the desktop
    compositor.py         niri IPC, monitors, input region, whole-desktop grabs
    clipboard.py          wl-copy, or GTK's clipboard
    portal.py             XDG portals: screenshot, screen cast, shortcuts, autostart
    tray.py               recording indicator (StatusNotifierItem)
    integration.py        shortcut, keybinding lines, start on login
  media/                  audio and video
    audio.py              mic list, level meter
    recorder.py           frames → ffmpeg; pauses make segments, joined on stop
    sources.py            where frames come from: helper, PipeWire (portal), x11grab
    ffmpeg.py             probe, editor preview frames, trim/GIF export
    playback.py           can WebKit play our recordings (GStreamer plugins)
helper/                   kustik-screenshot-helper (Rust): wlr-screencopy screenshots and frames
ui/                       the UI the app shows (HTML/CSS + ES modules in ui/js)
site/                     the website, which runs ui/ on a fake desktop (below)
flatpak/                  manifest, desktop file, icon, metadata, build.sh
kustik-screenshot         launcher: preloads gtk4-layer-shell; in Flatpak, finds the Wayland socket
install.sh                build and register from the source tree
```

`app.py` is the only module that knows about the overlay window and the UI;
`system/` and `media/` don't import it. The UI (`ui/js`) talks to the app only
through messages (`native.js` on its side, `on_<type>` handlers in `app.py`):
`main.js` (capture, editing, recording, toast), `editor.js` (trim),
`welcome.js`, `pins.js`, `annotations.js`. `ui/build.sh` bundles them into
`ui/dist/app.js` (WebKitGTK won't load ES modules from `file://`).

Backends are picked at startup and logged:

- **Overlay:** layer-shell if the compositor supports it (not GNOME, not X11),
  else a full-screen window. Force with `KUSTIK_OVERLAY=window`.
- **Capture:** `direct` if wlr-screencopy works, else `portal`, else `x11`.
  Force with `KUSTIK_BACKEND=direct|portal|x11`.

A capture: shortcut → `capture` action → the UI hides its own floating bits →
the screen is grabbed (helper, or the portal's full-desktop image cropped to
the monitor the overlay opened on) → the overlay opens on the frozen frame.
The shortcut again while recording stops it.

## Website (site/)

The website (<https://screenshot.kustik.xyz/>) is static. Its demo runs the
real UI from `ui/` in a browser, on a canvas-painted Linux desktop, driven by a
scripted cursor:

| File | |
| --- | --- |
| `site/index.html`, `site.css` | The page. |
| `site/js/shell.js` | The step switcher, caption, and one stage iframe per step. |
| `site/stage.html`, `js/stage.js` | One step: the fake desktop, the real UI on top, the step's script. |
| `site/js/flows-data.js` | The steps: labels, captions, scene, duration. |
| `site/js/host.js` | Stands in for the app: answers the UI's messages (freeze, copy, record the canvas, GIF export, tray dot). |
| `site/js/cursor.js` | Scripted pointer and keys: real pointer/keyboard events, pointer capture emulated. |
| `site/js/fake-desktop.js` | The desktop: browser, terminal, chat, top bar. |

```sh
python3 site/tools/serve.py        # work on it: http://127.0.0.1:5182/ (reads the sources, never cached)
./site/build.sh                    # → site/dist/: upload it to any static host
```

Both use one layout: the page at `/`, the app's UI under `/ui/`, the icon at
`/icon.svg`. Run `ui/build.sh` after UI changes when serving (the stage loads
`ui/dist/app.js`); `site/build.sh` bundles the UI itself (minified).

Publishing: `.github/workflows/pages.yml` builds and deploys to GitHub Pages
on every push to `main`. `site/build.sh` writes a `CNAME` with
`screenshot.kustik.xyz` (`SITE_DOMAIN=…` to change it, empty for none). For
the domain: a DNS `CNAME` record `screenshot` → `kustiks.github.io`, then
repo Settings → Pages: source "GitHub Actions", custom domain
`screenshot.kustik.xyz`, Enforce HTTPS. Any other static host works the same
with `site/dist`.

README clips come from `site/tools/record.mjs` (see `docs/media/README.md`).

## Flatpak notes

- Compositors that implement `wp_security_context_v1` (niri among them) hide
  layer-shell and screencopy from clients that connect through Flatpak's
  Wayland socket. The manifest therefore shares the session's socket
  (`xdg-run/wayland-0..2`) as a file instead of `--socket=wayland`; the
  launcher finds it. Another display name:
  `flatpak run --filesystem=xdg-run/NAME --env=KUSTIK_WAYLAND_DISPLAY=NAME xyz.kustik.Screenshot`.
- niri's IPC socket isn't reachable from the sandbox (its name changes each
  session), so click-a-window needs
  `flatpak run --filesystem=xdg-run/${NIRI_SOCKET##*/} …`; without it the app
  still finds the focused output through the compositor.
- An app that can capture the whole screen isn't meaningfully confined; the
  sandbox is about packaging and updates. The raw Wayland socket is the one
  permission Flathub reviewers may ask about: without it, wlroots compositors
  get the portal path (slower, and a window instead of an overlay).
- A source-tree install's `~/.local/share/dbus-1/services/xyz.kustik.Screenshot.service`
  takes precedence over the Flatpak's: remove it when switching.

## Releases

1. Bump the version and date in `flatpak/xyz.kustik.Screenshot.metainfo.xml`
   (add a `<release>` with a short description), commit.
2. `git tag -a v1.2.3 -m "Kustik Screenshot 1.2.3" && git push origin v1.2.3`.
   The Flatpak workflow builds and publishes the GitHub release with
   `kustik-screenshot.flatpak` and `kustik-screenshot-1.2.3.tar.xz`: the
   sources plus the UI bundle and vendored crates, so it builds offline
   (`./flatpak/dist.sh 1.2.3` makes the same archive locally, from the
   committed files). Release archives leave out `docs/media`,
   `docs/screenshots`, `site` and `.github` (`.gitattributes`).

Store screenshots are `docs/screenshots/*.png`, linked from the metainfo by
tag; `site/tools/screenshots.mjs` retakes them from the website's stage at 2x.

Flathub doesn't accept submissions, manifests or review replies made with AI
tools (see its Generative AI policy): the Flathub manifest and submission are
written by hand.

## Testing

- `KUSTIK_DEV=1` adds an `eval` D-Bus action that runs JS in the UI, and dumps
  Python stacks on crashes / `kill -USR2`. `KUSTIK_DEVTOOLS=1` enables the
  WebKit inspector.
- `KUSTIK_APP_ID=xyz.kustik.Screenshot.Test` runs a separate
  instance next to your real one.
- A nested niri (`niri -c test.kdl` inside your session) is a safe sandbox. Its
  winit backend returns frames upside down: set `KUSTIK_FLIP_Y=1` there
  (`KUSTIK_DEBUG=1` makes the helper log frame flags). It is
  throttled while not visible on your screen, so don't judge timing in it.

```sh
gdbus call --session --dest xyz.kustik.Screenshot.Test \
  --object-path /xyz/kustik/Screenshot/Test \
  --method org.gtk.Actions.Activate eval "[<'__capture.selectFull()'>]" "{}"
```
