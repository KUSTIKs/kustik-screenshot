// The display: a calm Linux desktop with the real Kustik Screenshot UI on
// top, driven by a scripted cursor. stage.html#<step key> plays one step; the
// page loads a fresh stage for each, so state never leaks.
//
// The virtual screen is small on purpose (1120×700): shown at about its real
// size, the UI reads as it does on a laptop instead of a shrunken toy.

import { Desktop } from './fake-desktop.js';
import { Host } from './host.js';
import { Cursor, key } from './cursor.js';
import { runScript, typeDelay } from './script.js';
import { STEPS } from './flows-data.js';

export const W = 1120, H = 700;
const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
const stepKey = location.hash.slice(1) || STEPS[0].key;
const step = STEPS.find((x) => x.key === stepKey) || STEPS[0];

// ---- desktop: one focused window per step
const desk = new Desktop();
desk.scene = step.scene;
desk.canvas.id = 'desk';
document.getElementById('desk').replaceWith(desk.canvas);
desk.resize(W, H, dpr);
desk.canvas.style.width = `${W}px`;
desk.canvas.style.height = `${H}px`;
const loop = (t) => { desk.tick(t); desk.render(); requestAnimationFrame(loop); };
requestAnimationFrame(loop);

// ---- the real UI (ui/, the app's own), unmodified
const html = await (await fetch('ui/index.html')).text();
const doc = new DOMParser().parseFromString(html, 'text/html');
for (const el of [...doc.body.children].reverse()) if (el.tagName !== 'SCRIPT') desk.canvas.after(document.adoptNode(el));
const cursor = new Cursor(document.body);
const host = new Host(desk, cursor);
await new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = 'ui/dist/app.js';
  s.onload = res; s.onerror = rej;
  document.body.appendChild(s);
});
await host.ready;
await document.fonts.ready;

// ---- helpers

const hudEl = document.getElementById('hud');
let hudT;
function hud(keys) {
  hudEl.innerHTML = keys.map((k) => `<kbd>${k}</kbd>`).join('');
  hudEl.classList.add('show');
  clearTimeout(hudT);
  hudT = setTimeout(() => hudEl.classList.remove('show'), 1100);
}
async function shortcut(s) {
  hud(['Super', 'Shift', 'S']);
  await s.wait(260);
  host.trigger();
  await s.wait(650);
}
async function press(s, k, label = [k]) {
  hud(label);
  await s.wait(220);
  key(k);
  await s.wait(260);
}
async function typeIn(s, text, put) {
  for (const ch of text) { put(ch); await s.wait(typeDelay(ch)); }
}
async function select(s, x0, y0, x1, y1, dur = 650) {
  await cursor.move(x0, y0, undefined, s);
  await s.wait(140);
  await cursor.drag(x1, y1, dur, s);
}
const sel = (q) => document.querySelector(q);
const main = () => desk.win(step.scene);

/** The chat slides in beside the main window; paste what was copied. */
async function pasteInChat(s, reply) {
  const m = main(), chat = desk.win('chat');
  const overlap = m.x + m.w + 24 - chat.x;
  if (overlap > 0) desk.shift(m.id, -overlap);
  desk.reveal('chat');
  await s.wait(520);
  await cursor.move(chat.x + chat.w / 2, chat.y + chat.h - 30, undefined, s);
  await cursor.click(null, s);
  desk.chat.focused = true;
  await s.wait(250);
  hud(['Ctrl', 'V']);
  await s.wait(350);
  const clip = host.clipboard;
  if (clip?.img) {
    const w = Math.min(chat.w * 0.72, clip.w / dpr);
    desk.chatSend({ me: true, img: clip.img, w, h: (clip.h * w) / clip.w, label: clip.kind === 'gif' ? 'GIF' : '' });
  }
  desk.chat.focused = false;
  if (reply) setTimeout(() => desk.chatSend({ me: false, text: reply }), 900);
}

/** A short build in the terminal, typed while recording. */
async function build(s, cmd, lines) {
  const t = main();
  await cursor.move(t.x + t.w * 0.5, t.y + t.h * 0.6, undefined, s);
  await typeIn(s, cmd, (ch) => desk.termType(ch));
  await s.wait(250);
  desk.termRun([]);
  for (const line of lines) { await s.wait(420); desk.termPrint(line); }
}

// ---- the four steps

const SCRIPTS = {
  // Select an area, Enter, paste it.
  'screenshot/area': async (s) => {
    const { hero } = desk.spots;
    cursor.jump(W * 0.62, H * 0.82);
    await s.wait(500);
    await shortcut(s);
    await select(s, hero.x - 14, hero.y - 14, hero.x + hero.w + 14, hero.y + hero.h + 14);
    await s.wait(500);
    await press(s, 'Enter');
    await s.wait(900);
    await pasteInChat(s, 'Love it. Ship it!');
    await s.wait(2600);
  },

  // Select the page, an arrow and a label, copy.
  'annotate/arrow': async (s) => {
    const m = main(), { title, hero } = desk.spots;
    cursor.jump(W * 0.62, H * 0.82);
    await s.wait(400);
    await shortcut(s);
    await select(s, m.x + 6, m.y + 44, m.x + m.w - 6, hero.y + hero.h + 24, 700);
    await s.wait(500);
    // A label in the empty space right of the title, an arrow down into the image.
    const lx = title.x + title.w + 46, ly = title.y + 22;
    await cursor.click('#toolbar [data-tool="arrow"]', s);
    await s.wait(250);
    await cursor.move(lx + 36, ly + 14, undefined, s);
    await cursor.drag(hero.x + hero.w * 0.72, hero.y + hero.h * 0.42, 450, s);
    await s.wait(300);
    await cursor.click('#toolbar [data-tool="text"]', s);
    await s.wait(250);
    await cursor.move(lx, ly - 4, undefined, s);
    await cursor.click(null, s);
    await s.wait(250);
    for (const ch of 'Brighter!') { document.execCommand('insertText', false, ch); await s.wait(typeDelay(ch)); }
    await press(s, 'Enter');
    await s.wait(500);
    await cursor.click('#toolbar [data-act="copy"]', s);
    await s.wait(900);
    await pasteInChat(s, 'Much better');
    await s.wait(2600);
  },

  // Record the terminal: the bar stays outside; stop; copied.
  'record/area': async (s) => {
    const t = main();
    cursor.jump(W * 0.5, H * 0.9);
    await s.wait(400);
    await shortcut(s);
    await cursor.click('#modebar [data-kind="video"]', s);
    await s.wait(300);
    await select(s, t.x + 2, t.y + 2, t.x + t.w - 2, t.y + t.h - 2, 600);
    await s.wait(600);
    await cursor.click('#readybar [data-k="primary"]', s);
    await s.wait(2700); // 3, 2, 1
    await build(s, 'npm run build', [
      [['  ✓ ', '#B5E48C'], ['42 modules transformed', '#9A9DA7']],
      [['  dist/assets/app.js ', '#E6E6EA'], ['142.10 kB', '#9A9DA7']],
      [['  ✓ ', '#B5E48C'], ['built in 1.84s', '#9A9DA7']],
    ]);
    await s.wait(900);
    await cursor.click('#readybar [data-k="primary"]', s);
    await s.wait(3400);
  },

  // Record, open the preview, trim both ends, GIF, paste.
  'trim/gif': async (s) => {
    const t = main();
    cursor.jump(W * 0.5, H * 0.9);
    await s.wait(300);
    await shortcut(s);
    await cursor.click('#modebar [data-kind="video"]', s);
    await select(s, t.x + 2, t.y + 2, t.x + t.w - 2, t.y + t.h - 2, 500);
    await s.wait(400);
    await press(s, 'Enter');
    await s.wait(2700);
    await build(s, 'npm test', [
      [['  ✓ ', '#B5E48C'], ['capture  (12 tests)', '#9A9DA7']],
      [['  ✓ ', '#B5E48C'], ['editor   (9 tests)', '#9A9DA7']],
      [['  Tests  ', '#E6E6EA'], ['21 passed', '#B5E48C']],
    ]);
    await s.wait(700);
    await cursor.click('#readybar [data-k="primary"]', s);
    await s.wait(2600);
    await cursor.click('#toast .t-media', s);
    await s.wait(1100);
    const [lx, ly] = cursor.at('.ed-h.l');
    const [rx] = cursor.at('.ed-h.r');
    await cursor.move(lx, ly, undefined, s);
    await cursor.drag(lx + (rx - lx) * 0.22, ly, 600, s);
    await s.wait(300);
    const [rx2, ry2] = cursor.at('.ed-h.r');
    await cursor.move(rx2, ry2, undefined, s);
    await cursor.drag(rx2 - (rx2 - lx) * 0.12, ry2, 500, s);
    await s.wait(400);
    await cursor.click('[data-fmt="gif"]', s);
    await s.wait(400);
    await cursor.click('.ed-go', s);
    for (let i = 0; i < 60 && sel('.toast.expanded'); i++) await s.wait(100);
    await s.wait(900);
    await pasteInChat(s, 'Adding it to the PR');
    await s.wait(2600);
  },
};

// ---- playback, driven by the page

const script = SCRIPTS[step.key];
const toParent = (m) => parent !== window && parent.postMessage({ stage: true, ...m }, '*');

function play() {
  const run = runScript(script);
  run.done.then(() => { toParent({ type: 'done' }); window.__stageDone = true; });
  window.addEventListener('message', (e) => { if (e.data?.stop) run.cancel(); });
}

window.addEventListener('message', (e) => { if (e.data?.play) play(); });
toParent({ type: 'ready' });
if (parent === window) play(); // opened on its own: just play
window.__stage = { desk, host, cursor };
