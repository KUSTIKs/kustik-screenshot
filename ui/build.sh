#!/bin/bash
# Bundle the UI modules into one classic script: WebKitGTK won't load ES
# modules from file:// pages. Needs bun (or swap in esbuild/npx esbuild).
set -e
cd "$(dirname "$0")"
bun build js/main.js --outfile dist/app.js --format iife --target browser --minify-whitespace --sourcemap=inline
