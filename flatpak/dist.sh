#!/bin/bash
# The release archive: the sources plus the generated UI bundle and vendored
# Rust crates, so a Flatpak manifest can build it offline (type: archive).
#
#   ./flatpak/dist.sh 0.2.0   → flatpak/dist/kustik-screenshot-0.2.0.tar.xz
#
# Run it on the release tag: the archive holds the committed files (git archive HEAD).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:?usage: dist.sh VERSION}"
NAME="kustik-screenshot-$VERSION"
OUT=flatpak/dist
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ui/build.sh >/dev/null
(cd helper && cargo vendor --locked --quiet vendor >/dev/null)

git archive --prefix="$NAME/" HEAD | tar -x -C "$TMP"
cp -r ui/dist "$TMP/$NAME/ui/"
cp -r helper/vendor "$TMP/$NAME/helper/"
mkdir -p "$OUT"
# Reproducible: same sources → same archive → same checksum.
tar -C "$TMP" --sort=name --mtime="@$(git log -1 --format=%ct)" --owner=0 --group=0 --numeric-owner \
  -cJf "$OUT/$NAME.tar.xz" "$NAME"
echo "$OUT/$NAME.tar.xz  sha256 $(sha256sum "$OUT/$NAME.tar.xz" | cut -d' ' -f1)"
