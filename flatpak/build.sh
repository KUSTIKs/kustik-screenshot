#!/bin/bash
# Build and install the Kustik Screenshot Flatpak for the current user.
#   ./flatpak/build.sh            build + install
#   ./flatpak/build.sh bundle     also write kustik-screenshot.flatpak (single-file installer)
set -euo pipefail
cd "$(dirname "$0")"
APP=..

# 1. UI bundle (bun isn't in the Flatpak SDK).
"$APP/ui/build.sh" >/dev/null
# 2. Rust crates, vendored so the sandboxed build needs no network.
(cd "$APP/helper" && cargo vendor --locked --quiet vendor >/dev/null)

# 3. Build and install (flatpak-builder from Flathub: org.flatpak.Builder).
flatpak run org.flatpak.Builder --user --install --force-clean --ccache \
  --state-dir=.build/state --repo=.repo .build/app xyz.kustik.Screenshot.yml

if [ "${1:-}" = bundle ]; then
  flatpak build-bundle .repo kustik-screenshot.flatpak xyz.kustik.Screenshot \
    --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo
  echo "wrote $(pwd)/kustik-screenshot.flatpak"
fi
