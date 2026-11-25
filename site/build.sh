#!/bin/bash
# Build the showcase as a static site: plain files, no server-side anything.
# Upload the output folder to any static host (GitHub Pages, Cloudflare
# Pages, Netlify, your own nginx...).
#
#   ./site/build.sh [out-dir]                  # default: site/dist
#   SITE_DOMAIN=example.com ./site/build.sh    # custom domain (default: screenshot.kustik.xyz)
#
# Layout (the same one site/tools/serve.py serves while you work):
#   /            the page (site/)
#   /ui/         the app's real UI, which the demo runs (ui/, bundled)
#   /icon.svg    the app icon (favicon)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-site/dist}"
DOMAIN="${SITE_DOMAIN-screenshot.kustik.xyz}"

rm -rf "$OUT"
mkdir -p "$OUT/ui/dist"
cp site/index.html site/stage.html site/site.css site/stage.css "$OUT/"
cp -r site/js "$OUT/"
cp ui/index.html ui/styles.css "$OUT/ui/"
cp -r ui/fonts "$OUT/ui/"
# The UI bundle, minified and without the debug source map ui/build.sh adds.
bun build ui/js/main.js --outfile "$OUT/ui/dist/app.js" --format iife --target browser --minify >/dev/null
cp flatpak/io.github.KUSTIKs.KustikScreenshot.svg "$OUT/icon.svg"
# GitHub Pages reads the custom domain from this file; other hosts ignore it.
[ -n "$DOMAIN" ] && echo "$DOMAIN" > "$OUT/CNAME"
echo "built $OUT ($(du -sh "$OUT" | cut -f1))"
