#!/bin/bash
# Build Kustik Screenshot from source and register it for this user. Touches no config files.
set -euo pipefail
APP="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

echo "• Building kustik-screenshot-helper (Rust)…"
(cd "$APP/helper" && cargo build --release --quiet)

echo "• Bundling the UI…"
"$APP/ui/build.sh" >/dev/null

echo "• Registering the D-Bus service (the shortcut can start it on demand)…"
mkdir -p "$HOME/.local/share/dbus-1/services"
cat > "$HOME/.local/share/dbus-1/services/xyz.kustik.Screenshot.service" <<SVC
[D-BUS Service]
Name=xyz.kustik.Screenshot
Exec=$APP/kustik-screenshot --gapplication-service
SVC

mkdir -p "$HOME/.local/bin"
ln -sf "$APP/kustik-screenshot" "$HOME/.local/bin/kustik-screenshot"

echo "• Adding it to your app menu…"
mkdir -p "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/scalable/apps"
sed "s#^Exec=kustik-screenshot#Exec=$APP/kustik-screenshot#" "$APP/flatpak/xyz.kustik.Screenshot.desktop" \
  > "$HOME/.local/share/applications/xyz.kustik.Screenshot.desktop"
cp "$APP/flatpak/xyz.kustik.Screenshot.svg" "$HOME/.local/share/icons/hicolor/scalable/apps/"

missing=()
for e in qtdemux avdec_h264 autoaudiosink; do gst-inspect-1.0 --exists "$e" || missing+=("$e"); done
python3 -c 'import gi; gi.require_version("WebKit", "6.0")' 2>/dev/null || missing+=("webkitgtk-6.0")
if ((${#missing[@]})); then
  echo
  echo "! Missing: ${missing[*]} (see docs/DEVELOPING.md)"
fi

echo
echo "Done. Open Kustik Screenshot from your app menu (or run: kustik-screenshot) to set up the shortcut."
