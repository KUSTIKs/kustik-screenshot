The README's clips, recorded from the showcase (`site/`), which runs the real
UI in a browser with a scripted cursor. One GIF per step in
`site/js/flows-data.js`:

```sh
./ui/build.sh
python3 site/tools/serve.py &           # from the repo root
node site/tools/record.mjs              # every step → docs/media/<step>.gif
node site/tools/record.mjs trim/gif     # just one
```

It drives a headless Chromium (`CHROME=/usr/bin/chromium` to pick one) with a
throwaway profile and the DevTools screencast, then ffmpeg.
