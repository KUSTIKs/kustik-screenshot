// Store screenshots (docs/screenshots, linked from the metainfo) from the
// showcase stage at 2x: wait for a moment in each step, hide the demo's key
// hints and pointer, capture.
//   python3 site/tools/serve.py &           (from the repo root)
//   node site/tools/screenshots.mjs
// Uses a headless Chromium (CHROME, default /usr/bin/brave) with a throwaway profile.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const BASE = process.env.BASE || 'http://127.0.0.1:5182/stage.html';
const CHROME = process.env.CHROME || '/usr/bin/brave';
const OUT = process.env.OUT || new URL('../../docs/screenshots', import.meta.url).pathname;
const PROFILE = mkdtempSync(join(tmpdir(), 'kustik-shots-'));
const PORT = 9343, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const b = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=1120,1000', '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 50 && !t; i++) { await sleep(200); try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page'); } catch {} }
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await cdp('Runtime.evaluate', { expression: x, returnByValue: true })).result?.result?.value;
await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1120, height: 700, deviceScaleFactor: 2, mobile: false });
const SHOTS = [
  ['annotate', 'annotate/arrow', `(() => { const c = window.__capture?.S; return c && c.mode === 'edit' && c.anns.length >= 2 && !c.textEdit; })()`, 300],
  ['record', 'record/area', `(() => { const c = window.__capture?.S, d = window.__stage?.desk; return c && c.mode === 'recording' && d.term.lines.length >= 5; })()`, 400],
  ['trim', 'trim/gif', `!!document.querySelector('[data-fmt="gif"].on')`, 250],
  ['share', 'screenshot/area', `(() => { const d = window.__stage?.desk; return d && d.chat.messages.length >= 5; })()`, 900],
];
for (const [name, key, cond, settle] of SHOTS) {
  await cdp('Page.navigate', { url: `${BASE}?s=${Date.now()}#${key}` });
  let ok = false;
  for (let i = 0; i < 400 && !ok; i++) { await sleep(100); ok = await ev(cond); }
  await sleep(settle);
  await ev(`document.head.insertAdjacentHTML('beforeend', '<style>#hud, .demo-cursor { display: none !important; }</style>')`);
  await sleep(50);
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  console.log(name, ok ? 'ok' : 'TIMEOUT');
}
ws.close(); b.kill();
await sleep(500);
rmSync(PROFILE, { recursive: true, force: true });
process.exit(0);
