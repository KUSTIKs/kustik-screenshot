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
cat > "$HOME/.local/share/dbus-1/services/io.github.KUSTIKs.KustikScreenshot.service" <<SVC
[D-BUS Service]
Name=io.github.KUSTIKs.KustikScreenshot
Exec=$APP/kustik-screenshot --gapplication-service
SVC

mkdir -p "$HOME/.local/bin"
ln -sf "$APP/kustik-screenshot" "$HOME/.local/bin/kustik-screenshot"

echo "• Adding it to your app menu…"
mkdir -p "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/scalable/apps"
sed "s#^Exec=kustik-screenshot#Exec=$APP/kustik-screenshot#" "$APP/flatpak/io.github.KUSTIKs.KustikScreenshot.desktop" \
  > "$HOME/.local/share/applications/io.github.KUSTIKs.KustikScreenshot.desktop"
cp "$APP/flatpak/io.github.KUSTIKs.KustikScreenshot.svg" "$HOME/.local/share/icons/hicolor/scalable/apps/"

missing=()
for e in qtdemux avdec_h264 autoaudiosink; do gst-inspect-1.0 --exists "$e" || missing+=("$e"); done
python3 -c 'import gi; gi.require_version("WebKit", "6.0")' 2>/dev/null || missing+=("webkitgtk-6.0")
if ((${#missing[@]})); then
  echo
  echo "! Missing: ${missing[*]} (see docs/DEVELOPING.md)"
fi

echo
echo "Done. Open Kustik Screenshot from your app menu (or run: kustik-screenshot) to set up the shortcut."
