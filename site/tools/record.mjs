// Records each step of the showcase to a GIF for the README (docs/media).
//   python3 site/tools/serve.py &           (from the repo root)
//   node site/tools/record.mjs [step ...]   e.g. screenshot/area
// Uses a headless Chromium (CHROME, default /usr/bin/brave) with a throwaway
// profile and the DevTools screencast, then ffmpeg.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STEPS } from '../js/flows-data.js';

const BASE = process.env.BASE || 'http://127.0.0.1:5182/stage.html';
const CHROME = process.env.CHROME || '/usr/bin/brave';
const OUT = process.env.OUT || new URL('../../docs/media', import.meta.url).pathname;
const TMP = process.env.TMP_DIR || '/tmp/kustik-record';
const PORT = 9339;
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const browser = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(TMP, 'profile')}`,
  '--window-size=1120,1000', '--force-device-scale-factor=1', '--hide-scrollbars', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => browser.kill());

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
}
if (!target) throw new Error('browser did not start');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const handlers = new Set();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else for (const h of handlers) h(m);
});
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });

await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1120, height: 700, deviceScaleFactor: 1, mobile: false });

for (const step of STEPS) {
  const name = step.key.replace('/', '-');
  if (only.length && !only.includes(step.key)) continue;
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  await cdp('Page.navigate', { url: `${BASE}?rec=${Date.now()}#${step.key}` });
  // wait for the stage to boot, then capture until its script says done
  for (let i = 0; i < 100; i++) {
    const r = await cdp('Runtime.evaluate', { expression: '!!window.__stage', returnByValue: true });
    if (r.result?.result?.value) break;
    await sleep(100);
  }
  const frames = [];
  const onFrame = (m) => {
    if (m.method !== 'Page.screencastFrame') return;
    const { data, metadata, sessionId } = m.params;
    const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
    cdp('Page.screencastFrameAck', { sessionId });
  };
  handlers.add(onFrame);
  await cdp('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1120, maxHeight: 1000, everyNthFrame: 1 });
  const t0 = Date.now();
  while (Date.now() - t0 < step.dur + 15000) {
    const r = await cdp('Runtime.evaluate', { expression: '!!window.__stageDone', returnByValue: true });
    if (r.result?.result?.value) break;
    await sleep(200);
  }
  await sleep(700);
  await cdp('Page.stopScreencast');
  handlers.delete(onFrame);
  if (frames.length < 2) { console.log(name, 'no frames'); continue; }
  // concat list with real frame durations → constant 30 fps
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? f.t + 0.5) - f.t).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
  writeFileSync(join(dir, 'list.txt'), list);
  const span = frames.at(-1).t - frames[0].t;
  const mp4 = join(dir, `${name}.mp4`), gif = join(OUT, `${name}.gif`);
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'),
    '-vf', 'crop=1120:700:0:0,fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', mp4]);
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', mp4, '-vf',
    'fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    '-loop', '0', gif]);
  console.log(`${name}: ${frames.length} frames over ${span.toFixed(1)}s (${(frames.length / span).toFixed(0)} fps captured) → ${gif}`);
}
ws.close();
browser.kill();
