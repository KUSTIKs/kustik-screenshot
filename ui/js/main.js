import { native } from './native.js';
import * as Ann from './annotations.js';
import { I } from './icons.js';
import { liquidPill } from './pill.js';
import { AudioSources } from './audio.js';
import { createEditor } from './editor.js';
import { morph } from './morph.js';
import { $, $$, clamp, pad2, show, hide, isShown } from './dom.js';
import { addPin } from './pins.js';
import { initWelcome } from './welcome.js';

// ---------------------------------------------------------------- setup

const now = () => performance.now();
const TOPBAR = 0; // the real top bar is part of the frozen screenshot
const CAPTURE_MODES = ['select', 'edit', 'ready', 'countdown']; // a frozen frame is on screen

const scene = $('#scene');
const sctx = scene.getContext('2d');
const ui = {
  root: $('#ui'), modebar: $('#modebar'),
  size: $('#sizelabel'), toolbar: $('#toolbar'), pop: $('#colorPop'), ready: $('#readybar'),
  menu: $('#srcMenu'), toast: $('#toast'), tip: $('#tip'), texted: $('#texted'),
};

for (const el of $$('[data-icon]')) el.insertAdjacentHTML('afterbegin', I[el.dataset.icon]);
$('[data-act="pause"]').innerHTML = I.pause;


// Selectable windows on the captured output (from the compositor; logical px).
let windows = [];
function targetAt(x, y) {
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i];
    if (x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h) return { ...w, r: 12 };
  }
  return null;
}
function edges() {
  const xs = [0, W], ys = [0, H];
  for (const r of windows) { xs.push(r.x, r.x + r.w); ys.push(r.y, r.y + r.h); }
  return { xs, ys };
}
/** Output pixels per CSS px of the frozen screenshot (the export resolution). */
const SCALE = () => (S.frozen ? S.frozen.width / W : DPR);

let W = 0, H = 0, DPR = 1;
let dirty = true, rawDirty = true;

const S = {
  mode: 'idle',        // idle | select | edit | ready | countdown | recording
  kind: 'photo',       // photo | video
  frozen: null,
  sel: null,           // {x,y,w,h} in CSS px
  hover: null,         // window/pin under the cursor while selecting
  drag: null,          // rubber-band rect while selecting
  down: null,          // active pointer gesture
  mouse: { x: -1, y: -1, in: false },
  edges: null,
  tool: 'select', color: 0, width: 1,
  anns: [], undo: [], redo: [], selAnn: -1, drawing: null, textEdit: null,
  opts: { clicks: true }, // 'clicks' = show the pointer in recordings
  rec: null, cd: null, session: null, video: null, dimK: 0,
};

// ---------------------------------------------------------------- helpers

function normRect(x0, y0, x1, y1) {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}
function clipRect(r) {
  const x = clamp(r.x, 0, W), y = clamp(r.y, 0, H);
  return { x, y, w: clamp(r.x + r.w, 0, W) - x, h: clamp(r.y + r.h, 0, H) - y, r: r.r, title: r.title };
}
const inRect = (p, r) => r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

function snap(v, list, alt) {
  if (alt) return v;
  let best = v, bd = 7;
  for (const s of list) { const d = Math.abs(s - v); if (d < bd) { bd = d; best = s; } }
  return best;
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} at ${pad2(d.getHours())}.${pad2(d.getMinutes())}.${pad2(d.getSeconds())}`;
}
const fmt = (s) => `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`;

// ---------------------------------------------------------------- resize

function resize() {
  W = innerWidth;
  H = innerHeight;
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  for (const c of [scene]) {
    c.width = Math.round(W * DPR);
    c.height = Math.round(H * DPR);
    c.style.width = W + 'px';
    c.style.height = H + 'px';
  }
  if (CAPTURE_MODES.includes(S.mode)) cancelCapture();
  dirty = true;
  rawDirty = true;
}

// ---------------------------------------------------------------- modes

function setMode(m) {
  const prev = S.mode;
  S.mode = m;
  S.down = null;
  S.drawing = null;
  closePopover(true);
  hideTip();

  // The overlay opens from a hotkey dozens of times a day: no entrance motion.
  if (m === 'select') show(ui.modebar, true); else hide(ui.modebar, true);
  if (m === 'edit') show(ui.toolbar, prev === 'edit'); else hide(ui.toolbar, true);
  // Set up → countdown → recording is one bar that morphs between states.
  const bar = m === 'ready' || m === 'countdown' || m === 'recording';
  if (bar) {
    if (!isShown(ui.ready)) show(ui.ready);
    setBarState(m === 'countdown' ? 'counting' : m === 'recording' ? 'recording' : 'setup');
  } else {
    hide(ui.ready, true);
    ui.ready.classList.remove('paused', 'arm', 'has-mic');
    ui.ready.dataset.state = 'setup';
    Object.assign($('[data-k="primary"]', ui.ready).dataset, { act: 'start' });
  }
  if (m === 'edit' || m === 'ready') show(ui.size, true); else hide(ui.size, true);
  closeMenu(true);
  // Hold the microphone only while it can be recorded.
  if (m === 'ready' && audio.mic.on && !audio.monitoring) audio.monitor(true);
  if (m === 'idle' || m === 'select' || m === 'edit') audio.release();
  ui.modebar.classList.remove('away');

  if (m === 'select') {
    S.dimK = 1; // the overlay opens from a hotkey: no fade in
    updateSeg(true);
    S.edges = edges();
  }
  if (m === 'ready') placeFloating();
  if (m === 'edit') placeFloating();
  if (m === 'countdown') updateSizeLabel();
  if (m === 'idle') S.dimK = 0;
  dirty = true;
  rawDirty = true;
  updateCursor();
}

/** Start a capture from the host's screenshot (payload: img url, windows, size). */
async function beginCapture(kind, payload) {
  if (S.mode !== 'idle' || editor.isOpen) return;
  const img = new Image();
  img.src = payload.img;
  try { await img.decode(); } catch (err) { console.warn('screenshot decode failed', err); return; }
  if (S.mode !== 'idle') return;
  hideToast(true);
  const f = document.createElement('canvas');
  f.width = img.naturalWidth;
  f.height = img.naturalHeight;
  f.getContext('2d').drawImage(img, 0, 0);
  S.frozen = f;
  windows = payload.windows || [];
  S.kind = kind;
  S.sel = null;
  S.hover = null;
  S.drag = null;
  S.anns = [];
  S.undo = [];
  S.redo = [];
  S.selAnn = -1;
  S.tool = 'select';
  if (payload.mouse) S.mouse = { x: payload.mouse.x, y: payload.mouse.y, in: true };
  setMode('select');
  if (S.mouse.in) S.hover = targetAt(S.mouse.x, S.mouse.y);
  updateSizeLabel();
  syncInput(true);
}

function cancelCapture() {
  commitText();
  clearCountdown();
  S.sel = null;
  S.frozen = null;
  setMode('idle');
}

function finishSelect(r) {
  if (r.w < 2 || r.h < 2) return;
  S.sel = { x: r.x, y: r.y, w: r.w, h: r.h };
  S.hover = null;
  S.drag = null;
  if (S.kind === 'photo') {
    setMode('edit');
    setTool('select', true);
  } else {
    setMode('ready');
  }
}

function selectFull() {
  finishSelect({ x: 0, y: 0, w: W, h: H });
}

// ---------------------------------------------------------------- floating layout

function placeBelow(el, r, gap = 12) {
  const w = el.offsetWidth, h = el.offsetHeight;
  let y = r.y + r.h + gap, below = true;
  if (y + h > H - 12) {
    y = r.y - gap - h;
    below = false;
    if (y < TOPBAR + 8) y = Math.min(H - 12 - h, r.y + r.h - gap - h);
  }
  const x = clamp(r.x + r.w / 2 - w / 2, 12, W - 12 - w);
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.transformOrigin = `${clamp(r.x + r.w / 2 - x, 0, w)}px ${below ? '0' : '100%'}`;
  return below;
}

function placeFloating() {
  if (!S.sel) return;
  if (S.mode === 'edit') placeBelow(ui.toolbar, S.sel);
  if (S.mode === 'ready') placeBelow(ui.ready, S.sel);
  updateSizeLabel();
  if (isShown(ui.pop)) placePopover();
}

function updateSizeLabel() {
  const el = ui.size;
  let r = null, label = '';
  if (S.mode === 'select') {
    if (S.drag) r = S.drag;
    else if (!S.down && S.mouse.in) {
      r = S.hover ? clipRect(S.hover) : { x: 0, y: 0, w: W, h: H };
      label = S.hover ? S.hover.title : 'Full screen';
    }
  } else if (S.mode === 'edit' || S.mode === 'ready') r = S.sel;

  if (!r) { hide(el, true); return; }
  const dims = `${Math.round(r.w * SCALE())} × ${Math.round(r.h * SCALE())}`;
  const html = label ? `<b>${label}</b><span>${dims}</span>` : dims;
  if (el.innerHTML !== html) el.innerHTML = html;
  const w = el.offsetWidth, h = el.offsetHeight;
  const x = clamp(r.x, 8, W - w - 8);
  let y = r.y - 8 - h;
  // Stay clear of the top bar, and of the mode bar while it is showing.
  const mb = S.mode === 'select' ? ui.modebar.getBoundingClientRect() : null;
  const hitsBar = mb && y < mb.bottom + 4 && x < mb.right && x + w > mb.left;
  if (y < TOPBAR + 4 || hitsBar) y = Math.max(r.y + 8, hitsBar ? mb.bottom + 6 : 0);
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  if (!isShown(el)) show(el, true);
}

// ---------------------------------------------------------------- compose

function dim(c, hole) {
  c.save();
  c.beginPath();
  c.rect(0, 0, W, H);
  if (hole) c.roundRect(hole.x, hole.y, hole.w, hole.h, hole.r || 0);
  c.fillStyle = `rgba(6,6,10,${(0.5 * S.dimK).toFixed(3)})`;
  c.fill('evenodd');
  c.restore();
}

function border(c, r, radius = 0) {
  c.save();
  c.beginPath();
  c.roundRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1, radius);
  c.strokeStyle = 'rgba(255,255,255,.95)';
  c.lineWidth = 1;
  c.shadowColor = 'rgba(0,0,0,.5)';
  c.shadowBlur = 3;
  c.stroke();
  c.restore();
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
function handlePos(r, h) {
  const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.w : r.x + r.w / 2;
  const y = h.includes('n') ? r.y : h.includes('s') ? r.y + r.h : r.y + r.h / 2;
  return { x, y };
}
function visibleHandles(r) {
  return r.w < 48 || r.h < 48 ? ['nw', 'ne', 'se', 'sw'] : HANDLES;
}
function drawHandles(c, r) {
  c.save();
  for (const h of visibleHandles(r)) {
    const p = handlePos(r, h);
    c.beginPath();
    c.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    c.shadowColor = 'rgba(0,0,0,.45)';
    c.shadowBlur = 4;
    c.shadowOffsetY = 1;
    c.fillStyle = '#fff';
    c.fill();
  }
  c.restore();
}

function compose() {
  const c = sctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, scene.width, scene.height);
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  // During a capture the overlay shows the frozen screen; otherwise it is
  // transparent and the live desktop shows through.
  if (CAPTURE_MODES.includes(S.mode) && S.frozen) c.drawImage(S.frozen, 0, 0, W, H);

  if (S.mode === 'select') {
    const r = S.drag || (!S.down && S.hover ? clipRect(S.hover) : null);
    dim(c, r);
    if (r) border(c, r, S.drag ? 0 : r.r);
    else if (!S.down && S.mouse.in) {
      c.save();
      c.strokeStyle = 'rgba(255,255,255,.55)';
      c.lineWidth = 2;
      c.strokeRect(1, 1, W - 2, H - 2);
      c.restore();
    }
    if (!S.drag && S.mouse.in) {
      c.save();
      c.fillStyle = 'rgba(255,255,255,.22)';
      c.fillRect(0, Math.round(S.mouse.y), W, 1);
      c.fillRect(Math.round(S.mouse.x), 0, 1, H);
      c.restore();
    }
  }

  if ((S.mode === 'edit' || S.mode === 'ready' || S.mode === 'countdown') && S.sel) {
    const r = S.sel;
    dim(c, r);
    if (S.mode === 'edit') {
      c.save();
      c.beginPath();
      c.rect(r.x, r.y, r.w, r.h);
      c.clip();
      const env = { raw: S.frozen, dpr: SCALE() };
      S.anns.forEach((a, i) => { if (!(S.textEdit && S.textEdit.idx === i)) Ann.draw(c, a, env); });
      if (S.drawing) Ann.draw(c, S.drawing, env);
      c.restore();
      if (S.selAnn >= 0 && S.anns[S.selAnn]) {
        const b = Ann.bbox(S.anns[S.selAnn]);
        c.save();
        c.setLineDash([4, 3]);
        c.strokeStyle = 'rgba(255,255,255,.9)';
        c.lineWidth = 1;
        c.beginPath();
        c.roundRect(b.x, b.y, b.w, b.h, 4);
        c.stroke();
        c.restore();
      }
    }
    border(c, r);
    if ((S.mode === 'edit' && S.tool === 'select') || S.mode === 'ready') drawHandles(c, r);
  }

  // Window overlay: the window hides while recording; leave nothing drawn
  // (it's what shows for a frame when the window comes back).
  if (S.mode === 'recording' && S.sel && S.overlay !== 'window') {
    const r = S.sel, o = 3, L = 14;
    // The dim fades away as recording starts, and the corners fade in.
    if (S.dimK > 0) dim(c, r);
    c.save();
    c.globalAlpha = 1 - S.dimK * 0.8;
    c.strokeStyle = 'rgba(255,255,255,.4)';
    c.setLineDash([5, 5]);
    c.lineWidth = 1;
    c.strokeRect(r.x - o - 0.5, r.y - o - 0.5, r.w + o * 2 + 1, r.h + o * 2 + 1);
    c.setLineDash([]);
    c.strokeStyle = '#FF3B30';
    c.lineWidth = 2.5;
    c.lineCap = 'round';
    c.shadowColor = 'rgba(0,0,0,.4)';
    c.shadowBlur = 4;
    const x0 = r.x - o, y0 = r.y - o, x1 = r.x + r.w + o, y1 = r.y + r.h + o;
    c.beginPath();
    c.moveTo(x0, y0 + L); c.lineTo(x0, y0); c.lineTo(x0 + L, y0);
    c.moveTo(x1 - L, y0); c.lineTo(x1, y0); c.lineTo(x1, y0 + L);
    c.moveTo(x1, y1 - L); c.lineTo(x1, y1); c.lineTo(x1 - L, y1);
    c.moveTo(x0 + L, y1); c.lineTo(x0, y1); c.lineTo(x0, y1 - L);
    c.stroke();
    c.restore();
  }

  if (lastScrim > 0) {
    // Dim around the editor card, not under it: the card is translucent, and
    // a dimmed backdrop showing through would make it darker than the same
    // card as a toast.
    const r = ui.toast.getBoundingClientRect();
    const rad = parseFloat(getComputedStyle(ui.toast).borderTopLeftRadius) || 16;
    c.beginPath();
    c.rect(0, 0, W, H);
    if (r.width > 0 && r.height > 0) c.roundRect(r.left, r.top, r.width, r.height, Math.min(rad, r.width / 2, r.height / 2));
    c.fillStyle = `rgba(6,6,10,${(0.55 * lastScrim).toFixed(3)})`;
    c.fill('evenodd');
  }
}

// ---------------------------------------------------------------- main loop

let lastScrim = 0, lastT = 0, lastSource = null;
function frame(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0);
  lastT = t;
  const dimTarget = CAPTURE_MODES.includes(S.mode) ? 1 : 0;
  if (S.dimK !== dimTarget) {
    S.dimK = dimTarget > S.dimK ? dimTarget : Math.max(0, S.dimK - dt / 0.32);
    dirty = true;
  }
  const sc = editor.scrim();
  if (sc !== lastScrim) { lastScrim = sc; dirty = true; }
  // While the card grows or shrinks, keep the hole in the dimming on it.
  if (lastScrim > 0 && ui.toast.getAnimations().length) dirty = true;
  if (S.mode === 'ready' || S.mode === 'countdown' || S.mode === 'recording') updateMeters();
  if (dirty) compose();
  if (S.mode === 'recording') recTick();
  syncInput();
  dirty = false;
  rawDirty = false;
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- pointer: scene

function pt(e) { return { x: e.clientX, y: e.clientY }; }

scene.addEventListener('contextmenu', (e) => e.preventDefault());

scene.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const p = pt(e);
  scene.setPointerCapture(e.pointerId);
  hideTip();
  if (S.textEdit) {
    commitText();
    if (S.mode === 'edit' && S.tool === 'text') return;
  }
  if (S.mode === 'idle' || S.mode === 'recording') return;
  else if (S.mode === 'select') S.down = { type: 'select', x0: snap(p.x, S.edges.xs, e.altKey), y0: snap(p.y, S.edges.ys, e.altKey), dragging: false };
  else if (S.mode === 'edit') editDown(p, e);
  else if (S.mode === 'ready') selDown(p, e) || startNewSelection(p, e);
  dirty = true;
});

scene.addEventListener('pointermove', (e) => {
  const p = pt(e);
  S.mouse = { x: p.x, y: p.y, in: true };
  if (S.mode === 'idle' || S.mode === 'recording') return;
  else if (S.mode === 'select') selectMove(p, e);
  else if (S.mode === 'edit') editMove(p, e);
  else if (S.mode === 'ready') selMove(p, e);
  updateCursor(p);
});

scene.addEventListener('pointerup', (e) => endPointer(pt(e), e));
scene.addEventListener('pointercancel', (e) => endPointer(pt(e), e, true));
document.addEventListener('mouseout', (e) => {
  if (e.relatedTarget) return;
  S.mouse.in = false;
  updateSizeLabel();
  dirty = true;
});
document.addEventListener('pointermove', (e) => {
  if (e.target === scene) return;
  S.mouse = { x: e.clientX, y: e.clientY, in: true };
});

function endPointer(p, e, cancelled) {
  const d = S.down;
  if (S.mode === 'select' && d) {
    S.down = null;
    ui.modebar.classList.remove('away');
    if (cancelled) { S.drag = null; dirty = true; return; }
    if (d.dragging) {
      const r = S.drag;
      S.drag = null;
      if (r && r.w >= 4 && r.h >= 4) return finishSelect(r);
    } else {
      const t = targetAt(p.x, p.y);
      return finishSelect(t ? clipRect(t) : { x: 0, y: 0, w: W, h: H });
    }
    updateSizeLabel();
  } else if (S.mode === 'edit') {
    editUp(p, e);
  }
  S.down = null;
  dirty = true;
  updateCursor(p);
}

// ----- selecting

function selectMove(p, e) {
  const d = S.down;
  if (d) {
    if (!d.dragging && Math.hypot(p.x - d.x0, p.y - d.y0) > 3) {
      d.dragging = true;
      ui.modebar.classList.add('away');
    }
    if (d.dragging) {
      const x1 = clamp(snap(p.x, S.edges.xs, e.altKey), 0, W);
      const y1 = clamp(snap(p.y, S.edges.ys, e.altKey), 0, H);
      S.drag = normRect(d.x0, d.y0, x1, y1);
    }
  } else {
    S.hover = targetAt(p.x, p.y);
  }
  updateSizeLabel();
  dirty = true;
}

// ----- selection handles (edit + ready)

function hitHandle(p) {
  if (!S.sel) return null;
  for (const h of visibleHandles(S.sel)) {
    const q = handlePos(S.sel, h);
    if (Math.hypot(p.x - q.x, p.y - q.y) < 9) return h;
  }
  return null;
}

/** Start resizing or moving the selection. Returns true if it took the gesture. */
function selDown(p) {
  const h = hitHandle(p);
  if (h) { S.down = { type: 'resize', h, orig: { ...S.sel }, p0: p }; return true; }
  if (inRect(p, S.sel)) { S.down = { type: 'move', orig: { ...S.sel }, p0: p }; return true; }
  return false;
}

function selMove(p, e) {
  const d = S.down;
  if (!d) return;
  const dx = p.x - d.p0.x, dy = p.y - d.p0.y, o = d.orig;
  if (d.type === 'resize') {
    let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
    const E = edges();
    if (d.h.includes('w')) x0 = snap(x0 + dx, E.xs, e.altKey);
    if (d.h.includes('e')) x1 = snap(x1 + dx, E.xs, e.altKey);
    if (d.h.includes('n')) y0 = snap(y0 + dy, E.ys, e.altKey);
    if (d.h.includes('s')) y1 = snap(y1 + dy, E.ys, e.altKey);
    const r = normRect(clamp(x0, 0, W), clamp(y0, 0, H), clamp(x1, 0, W), clamp(y1, 0, H));
    S.sel = { x: r.x, y: r.y, w: Math.max(4, r.w), h: Math.max(4, r.h) };
  } else if (d.type === 'move') {
    S.sel = { ...o, x: clamp(o.x + dx, 0, W - o.w), y: clamp(o.y + dy, 0, H - o.h) };
  } else return;
  placeFloating();
  dirty = true;
}

function startNewSelection(p, e) {
  const keepAnns = S.anns;
  setMode('select');
  S.anns = keepAnns;
  S.down = { type: 'select', x0: snap(p.x, S.edges.xs, e.altKey), y0: snap(p.y, S.edges.ys, e.altKey), dragging: false };
}

// ----- editing

function editDown(p, e) {
  closePopover();
  if (S.tool === 'select') {
    const h = hitHandle(p);
    if (h) { selDown(p); return; }
    for (let i = S.anns.length - 1; i >= 0; i--) {
      if (Ann.hit(S.anns[i], p)) {
        S.selAnn = i;
        S.down = { type: 'moveAnn', i, p0: p, orig: S.anns[i], moved: false };
        return;
      }
    }
    S.selAnn = -1;
    if (selDown(p)) return;
    startNewSelection(p, e);
    return;
  }
  S.selAnn = -1;
  const color = Ann.COLORS[S.color], size = Ann.WIDTHS[S.width];
  switch (S.tool) {
    case 'text': {
      const idx = S.anns.findIndex((a) => a.type === 'text' && Ann.hit(a, p));
      openText(p.x, p.y, idx);
      return;
    }
    case 'num': {
      const n = S.anns.filter((a) => a.type === 'num').reduce((m, a) => Math.max(m, a.n), 0) + 1;
      commitAnn({ type: 'num', x: p.x, y: p.y, n, color, r: Ann.NUM_RADII[S.width] });
      return;
    }
    case 'arrow': S.drawing = { type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, size }; break;
    case 'rect': S.drawing = { type: 'rect', x: p.x, y: p.y, w: 0, h: 0, color, size }; break;
    case 'blur': S.drawing = { type: 'blur', x: p.x, y: p.y, w: 0, h: 0 }; break;
    case 'pen': S.drawing = { type: 'pen', pts: [p], color, size }; break;
    case 'hl': S.drawing = { type: 'hl', pts: [p], color, size }; break;
  }
  S.down = { type: 'draw', p0: p };
}

function editMove(p, e) {
  const d = S.down;
  if (!d) return;
  if (d.type === 'resize' || d.type === 'move') return selMove(p, e);
  if (d.type === 'moveAnn') {
    const dx = p.x - d.p0.x, dy = p.y - d.p0.y;
    if (!d.moved && Math.hypot(dx, dy) > 2) { d.moved = true; pushUndo(); }
    if (d.moved) {
      S.anns = S.anns.slice();
      S.anns[d.i] = Ann.moved(d.orig, dx, dy);
      dirty = true;
    }
    return;
  }
  if (d.type !== 'draw' || !S.drawing) return;
  const a = S.drawing, p0 = d.p0;
  switch (a.type) {
    case 'arrow': {
      let x = p.x, y = p.y;
      if (e.shiftKey) {
        const ang = Math.round(Math.atan2(y - p0.y, x - p0.x) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(x - p0.x, y - p0.y);
        x = p0.x + Math.cos(ang) * len;
        y = p0.y + Math.sin(ang) * len;
      }
      a.x2 = x; a.y2 = y;
      break;
    }
    case 'rect':
    case 'blur': {
      let w = p.x - p0.x, h = p.y - p0.y;
      if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      a.w = w; a.h = h;
      break;
    }
    case 'pen':
    case 'hl': {
      if (e.shiftKey) a.pts = [p0, p];
      else {
        const l = a.pts[a.pts.length - 1];
        if (Math.hypot(p.x - l.x, p.y - l.y) > 1.5) a.pts.push(p);
      }
      break;
    }
  }
  dirty = true;
}

function editUp() {
  const d = S.down;
  if (!d) return;
  if (d.type === 'draw' && S.drawing) {
    const a = S.drawing;
    S.drawing = null;
    let ok = false;
    if (a.type === 'arrow') ok = Math.hypot(a.x2 - a.x1, a.y2 - a.y1) > 6;
    else if (a.type === 'rect' || a.type === 'blur') { const r = Ann.norm(a); ok = r.w > 3 && r.h > 3; Object.assign(a, r); }
    else ok = a.pts.length > 1;
    if (ok) commitAnn(a);
  }
  if (d.type === 'resize' || d.type === 'move') placeFloating();
}

function pushUndo() {
  S.undo.push(S.anns);
  if (S.undo.length > 100) S.undo.shift();
  S.redo = [];
  syncUndo();
}
function commitAnn(a) {
  pushUndo();
  S.anns = [...S.anns, a];
  dirty = true;
}
function undo() {
  if (!S.undo.length) return;
  S.redo.push(S.anns);
  S.anns = S.undo.pop();
  S.selAnn = -1;
  syncUndo();
  dirty = true;
}
function redo() {
  if (!S.redo.length) return;
  S.undo.push(S.anns);
  S.anns = S.redo.pop();
  S.selAnn = -1;
  syncUndo();
  dirty = true;
}
function deleteSelected() {
  if (S.selAnn < 0) return;
  pushUndo();
  S.anns = S.anns.filter((_, i) => i !== S.selAnn);
  S.selAnn = -1;
  dirty = true;
}
function syncUndo() {
  $('[data-act="undo"]', ui.toolbar).disabled = !S.undo.length;
  $('[data-act="redo"]', ui.toolbar).disabled = !S.redo.length;
}

// ----- text annotations

function openText(x, y, idx = -1) {
  const a = idx >= 0 ? S.anns[idx] : null;
  const fs = a ? a.fs : Ann.TEXT_SIZES[S.width];
  const color = a ? a.color : Ann.COLORS[S.color];
  S.textEdit = { x: a ? a.x : x, y: a ? a.y : y - fs * 0.6, idx, fs, color };
  const t = ui.texted;
  t.style.left = S.textEdit.x + 'px';
  t.style.top = S.textEdit.y + 'px';
  t.style.fontSize = fs + 'px';
  t.style.color = color;
  t.textContent = a ? a.text : '';
  t.classList.add('on');
  dirty = true;
  requestAnimationFrame(() => {
    t.focus();
    const range = document.createRange();
    range.selectNodeContents(t);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

function commitText() {
  const te = S.textEdit;
  if (!te) return;
  S.textEdit = null;
  const t = ui.texted;
  const text = t.innerText.replace(/\n+$/, '');
  t.classList.remove('on');
  t.blur();
  if (te.idx >= 0) {
    if (text.trim()) {
      if (text !== S.anns[te.idx].text) {
        pushUndo();
        S.anns = S.anns.slice();
        S.anns[te.idx] = { ...S.anns[te.idx], text };
      }
    } else {
      pushUndo();
      S.anns = S.anns.filter((_, i) => i !== te.idx);
    }
  } else if (text.trim()) {
    commitAnn({ type: 'text', x: te.x, y: te.y, text, color: te.color, fs: te.fs });
  }
  dirty = true;
}

ui.texted.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') {
    e.preventDefault();
    commitText();
  }
});
ui.texted.addEventListener('blur', () => setTimeout(commitText, 0));

// ----- tools, colors

function setTool(t, viaKey = false) {
  if (S.textEdit) commitText();
  S.tool = t;
  S.selAnn = -1;
  // The highlight jumps straight to the tool: no sliding between tools.
  const btn = $(`[data-tool="${t}"]`, ui.toolbar);
  for (const b of $$('[data-tool]', ui.toolbar)) {
    b.classList.toggle('on', b === btn);
    b.setAttribute('aria-pressed', b === btn);
  }
  dirty = true;
  updateCursor();
}

function setColor(i) {
  S.color = i;
  syncColor();
}
function setWidth(i) {
  S.width = clamp(i, 0, 2);
  syncColor();
}
function syncColor() {
  const dot = $('.dot', ui.toolbar);
  dot.style.setProperty('--c', Ann.COLORS[S.color]);
  dot.style.setProperty('--s', [0.72, 0.9, 1.1][S.width]);
  $$('.swatch', ui.pop).forEach((b, i) => b.classList.toggle('on', i === S.color));
  $$('.width', ui.pop).forEach((b, i) => b.classList.toggle('on', i === S.width));
  // Recolor the selected annotation, like most editors do.
  if (S.selAnn >= 0 && S.anns[S.selAnn] && S.anns[S.selAnn].type !== 'blur') {
    pushUndo();
    S.anns = S.anns.slice();
    S.anns[S.selAnn] = { ...S.anns[S.selAnn], color: Ann.COLORS[S.color] };
    dirty = true;
  }
}

$('.swatches', ui.pop).innerHTML = Ann.COLORS.map((c, i) => `<button class="swatch" data-color="${i}" aria-label="Color ${i + 1}" style="--c:${c}"><i></i></button>`).join('');
$('.widths', ui.pop).innerHTML = [6, 9, 13].map((s, i) => `<button class="width" data-width="${i}" aria-label="Size ${i + 1}"><i style="--s:${s}px"></i></button>`).join('');

function placePopover() {
  const b = $('#colorBtn').getBoundingClientRect();
  const tb = ui.toolbar.getBoundingClientRect();
  const w = ui.pop.offsetWidth, h = ui.pop.offsetHeight;
  let y = tb.top - 8 - h, origin = '100%';
  if (y < TOPBAR + 8) { y = tb.bottom + 8; origin = '0'; }
  const x = clamp(b.left + b.width / 2 - w / 2, 8, W - w - 8);
  ui.pop.style.left = x + 'px';
  ui.pop.style.top = y + 'px';
  ui.pop.style.transformOrigin = `${b.left + b.width / 2 - x}px ${origin}`;
}
function togglePopover() {
  if (isShown(ui.pop)) return closePopover();
  syncColor();
  placePopover();
  show(ui.pop);
}
function closePopover(instant = false) {
  if (isShown(ui.pop)) hide(ui.pop, instant);
}

// ---------------------------------------------------------------- export

function exportCanvas() {
  const r = S.sel;
  const c = document.createElement('canvas');
  const k = SCALE();
  c.width = Math.max(1, Math.round(r.w * k));
  c.height = Math.max(1, Math.round(r.h * k));
  const x = c.getContext('2d');
  x.setTransform(k, 0, 0, k, -r.x * k, -r.y * k);
  x.drawImage(S.frozen, 0, 0, W, H);
  const env = { raw: S.frozen, dpr: k };
  for (const a of S.anns) Ann.draw(x, a, env);
  return c;
}

const pngOf = (c) => c.toDataURL('image/png').split(',')[1];

/** Copy a canvas to the clipboard through the host (wl-copy). Resolves with its temp path. */
function copyCanvas(c) {
  return native.call('copy-image', { png: pngOf(c) }).then((r) => r, (err) => { console.warn(err); return null; });
}

function saveSession(c) {
  S.session = { frozen: S.frozen, sel: { ...S.sel }, anns: S.anns.slice(), image: c };
}

function closeAfterOutput() {
  S.frozen = null;
  S.sel = null;
  setMode('idle');
}

function actCopy(stay = false) {
  commitText();
  const c = exportCanvas();
  const p = copyCanvas(c);
  if (stay) {
    flashCopied();
    return;
  }
  saveSession(c);
  closeAfterOutput();
  p.then((r) => photoToast(c, r ? 'Copied to clipboard' : 'Copy failed — use Save', r?.path));
}

function actSave() {
  commitText();
  const c = exportCanvas();
  saveSession(c);
  closeAfterOutput();
  native.call('save-image', { png: pngOf(c) }).then(
    (r) => photoToast(c, `Saved to ${r.dir}`, r.path),
    () => photoToast(c, 'Save failed'),
  );
}

function actPin() {
  commitText();
  const c = exportCanvas();
  const r = S.sel;
  saveSession(c);
  closeAfterOutput();
  addPin(c, r);
}

function flashCopied() {
  const pl = $('.pl', ui.toolbar);
  pl.classList.add('swap');
  setTimeout(() => {
    pl.innerHTML = `${I.check}Copied`;
    pl.classList.remove('swap');
  }, 90);
  clearTimeout(flashCopied.t);
  flashCopied.t = setTimeout(() => {
    pl.classList.add('swap');
    setTimeout(() => { pl.textContent = 'Copy'; pl.classList.remove('swap'); }, 90);
  }, 1300);
}

function reopenSession() {
  const s = S.session;
  if (!s || S.mode !== 'idle') return;
  hideToast();
  S.frozen = s.frozen;
  S.sel = { ...s.sel };
  S.anns = s.anns.slice();
  S.undo = [];
  S.redo = [];
  S.selAnn = -1;
  S.kind = 'photo';
  setMode('edit');
  setTool('select', true);
  syncUndo();
}

// ---------------------------------------------------------------- recording

const PRIMARY = {
  setup: { act: 'start', tip: '', label: 'Record' },
  counting: { act: 'cd-now', tip: '', label: 'Start now' },
  recording: { act: 'stop', tip: 'Stop & copy', label: 'Stop recording' },
};

function placeBar() {
  if (!S.sel || (S.mode === 'recording' && S.barMoved)) return;
  placeBelow(ui.ready, S.sel);
  if (S.mode === 'recording') {
    const el = ui.ready, p = keepOutOfRecording(el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight);
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
  }
}

/** Setup → counting → recording: one bar, its controls move and reshape. */
function setBarState(state) {
  const el = ui.ready;
  if (el.dataset.state === state) return;
  morph(el, () => {
    el.dataset.state = state;
    const p = $('[data-k="primary"]', el), cfg = PRIMARY[state];
    p.dataset.act = cfg.act;
    p.setAttribute('aria-label', cfg.label);
    if (cfg.tip) { p.dataset.tip = cfg.tip; p.dataset.key = 'R'; } else { delete p.dataset.tip; delete p.dataset.key; }
  }, { reposition: placeBar });
}

/** True when the recorded area leaves no room outside it for the pill. */
function noRoomOutside() {
  if (!S.sel) return false;
  const w = 220, h = 44; // the recording pill's size
  const p = keepOutOfRecording(W / 2 - w / 2, S.sel.y + S.sel.h / 2, w, h);
  const r = S.sel, g = 8;
  return !(p.x + w <= r.x - g || p.x >= r.x + r.w + g || p.y + h <= r.y - g || p.y >= r.y + r.h + g);
}

function startCountdown() {
  if (S.mode !== 'ready') return;
  closeMenu(true);
  setMode('countdown');
  const num = $('.cd-num', ui.ready);
  let n = 3;
  const tick = () => {
    if (n === 0) { clearCountdown(); startRecording(); return; }
    num.textContent = n;
    num.animate(
      [{ opacity: 0, filter: 'blur(3px)', transform: 'translateY(6px)' }, { opacity: 1, filter: 'none', transform: 'none' }],
      { duration: 220, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
    );
    n--;
    S.cd = setTimeout(tick, 760);
  };
  tick();
}

function clearCountdown() {
  clearTimeout(S.cd);
  S.cd = null;
}

async function startRecording() {
  const r = S.sel;
  S.barMoved = false;
  S.rec = { t0: now(), paused: false, pausedAt: 0, pausedTotal: 0, armUntil: 0, sec: -1, starting: true };
  ui.ready.classList.remove('paused', 'arm');
  ui.ready.classList.toggle('has-mic', audio.mic.on);
  $('.rtime', ui.ready).textContent = '0:00';
  $('[data-act="pause"]', ui.ready).innerHTML = I.pause;
  // Full screen: an on-screen pill would be in the video, so the controls
  // move to the system tray (any StatusNotifierItem host). No tray → pill.
  // Without an overlay layer (GNOME, X11) the window can't stay above the
  // apps being recorded: the host hides it and a notification takes over.
  const external = S.overlay === 'window';
  let tray = false;
  if ((noRoomOutside() || external) && !S.captureHidden) {
    try { tray = (await native.call('tray-show')).ok; } catch { tray = false; }
  }
  S.rec.tray = tray || external;
  tray = S.rec.tray;
  setMode('recording');
  if (tray) { hide(ui.ready, true); hideTip(); }
  // Let the browser paint the hidden state first (the host then also waits for
  // the compositor), so nothing of ours is in the first captured frame.
  // (A hidden window gets no frames: don't wait forever.)
  await new Promise((res) => { requestAnimationFrame(() => requestAnimationFrame(res)); setTimeout(res, 120); });
  if (S.rec?.stopping || !S.rec) return;
  try {
    await native.call('record-start', {
      region: { x: r.x, y: r.y, w: r.w, h: r.h },
      cursor: S.opts.clicks,
      ...audio.sources(),
    });
    if (S.rec) { S.rec.t0 = now(); S.rec.starting = false; }
  } catch (err) {
    console.warn('record-start failed', err);
    S.rec = null;
    cancelCapture();
  }
}

function elapsed(R) {
  const t = R.paused ? R.pausedAt : now();
  return (t - R.t0 - R.pausedTotal) / 1000;
}

function recTick() {
  const R = S.rec;
  if (!R) return;
  const sec = Math.floor(elapsed(R));
  if (sec !== R.sec) {
    R.sec = sec;
    $('.rtime', ui.ready).textContent = fmt(sec);
    if (R.tray) native.send('tray-update', { time: fmt(sec), paused: R.paused });
  }
}

function togglePause() {
  const R = S.rec;
  if (!R || R.starting) return;
  if (R.paused) {
    R.pausedTotal += now() - R.pausedAt;
    R.paused = false;
    native.send('record-resume');
  } else {
    R.pausedAt = now();
    R.paused = true;
    native.send('record-pause');
  }
  ui.ready.classList.toggle('paused', R.paused);
  if (R.tray) native.send('tray-update', { time: fmt(Math.floor(elapsed(R))), paused: R.paused });
  const b = $('[data-act="pause"]', ui.ready);
  b.innerHTML = R.paused ? I.play : I.pause;
  b.dataset.tip = R.paused ? 'Resume' : 'Pause';
}

async function stopRecording(discard = false) {
  const R = S.rec;
  if (!R || R.stopping) return;
  R.stopping = true;
  if (R.tray) native.send('tray-hide');
  const barRect = R.tray ? null : ui.ready.getBoundingClientRect();
  S.rec = null;
  S.sel = null;
  setMode('idle');
  audio.release();
  let res;
  try {
    res = await native.call('record-stop', { discard });
  } catch (err) {
    console.warn('record-stop failed', err);
    return;
  }
  if (discard || !res?.path) return;
  const frames = await loadThumbs(res.thumbs || []);
  // Window overlay: the host keeps the window invisible until this state is drawn.
  requestAnimationFrame(() => requestAnimationFrame(() => native.send('painted')));
  // The source clip; edits to it are non-destructive (a/b/fmt are remembered).
  S.video = {
    url: res.url, path: res.path, dur: res.dur, ext: 'mp4', w: res.w, h: res.h, hasAudio: res.hasAudio,
    frames, cache: res.cache || [], cacheW: res.cacheW, a: 0, b: res.dur, fmt: 'video',
  };
  mediaToast({ kind: 'video', url: res.url, path: res.path, ext: 'mp4', w: res.w, h: res.h, dur: res.dur, size: res.size, title: 'Copied to clipboard', source: true, from: barRect, poster: res.cache?.[0]?.url });
}

/** Filmstrip thumbnails as canvases (the editor draws them repeatedly). */
async function loadThumbs(urls) {
  const out = [];
  for (const u of urls) {
    const img = new Image();
    img.src = u;
    try { await img.decode(); } catch { continue; }
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    out.push(c);
  }
  return out;
}

function armDiscard() {
  const R = S.rec;
  if (!R) return;
  if (now() < R.armUntil) return stopRecording(true);
  R.armUntil = now() + 2000;
  morph(ui.ready, () => ui.ready.classList.add('arm'), { reposition: placeBar });
  clearTimeout(armDiscard.t);
  armDiscard.t = setTimeout(() => morph(ui.ready, () => ui.ready.classList.remove('arm'), { reposition: placeBar }), 2000);
}

/**
 * The recording captures the screen, our own overlay included, so the bar
 * must stay outside the recorded area: dragged into it, it slides out to the
 * nearest side that has room. (Recording the whole screen leaves no outside.)
 */
function keepOutOfRecording(x, y, w, h) {
  const r = S.sel, g = 8;
  if (!r || S.captureHidden) return { x, y }; // our overlay isn't in captures at all
  const L = r.x - g, T = r.y - g, R = r.x + r.w + g, B = r.y + r.h + g;
  if (x + w <= L || x >= R || y + h <= T || y >= B) return { x, y }; // already outside
  const options = [
    { x: L - w, y }, { x: R, y }, // left, right
    { x, y: T - h }, { x, y: B }, // above, below
  ].filter((p) => p.x >= 8 && p.x + w <= W - 8 && p.y >= TOPBAR + 4 && p.y + h <= H - 8);
  if (!options.length) return { x, y };
  return options.reduce((a, b) => (Math.hypot(a.x - x, a.y - y) <= Math.hypot(b.x - x, b.y - y) ? a : b));
}

// While recording, the bar can be dragged out of the way.
ui.ready.addEventListener('pointerdown', (e) => {
  if (S.mode !== 'recording' || e.target.closest('button')) return;
  const r = ui.ready.getBoundingClientRect();
  const ox = e.clientX - r.left, oy = e.clientY - r.top;
  ui.ready.setPointerCapture(e.pointerId);
  ui.ready.classList.add('moving');
  const move = (ev) => {
    S.barMoved = true;
    const p = keepOutOfRecording(clamp(ev.clientX - ox, 8, W - r.width - 8), clamp(ev.clientY - oy, TOPBAR + 4, H - r.height - 8), r.width, r.height);
    ui.ready.style.left = p.x + 'px';
    ui.ready.style.top = p.y + 'px';
  };
  const up = () => {
    ui.ready.classList.remove('moving');
    ui.ready.removeEventListener('pointermove', move);
    ui.ready.removeEventListener('pointerup', up);
    ui.ready.removeEventListener('pointercancel', up);
  };
  ui.ready.addEventListener('pointermove', move);
  ui.ready.addEventListener('pointerup', up);
  ui.ready.addEventListener('pointercancel', up);
});

// ---------------------------------------------------------------- toast

let toastTimer = null;
let toastHover = false;

const EASE_DRAWER = 'cubic-bezier(0.32, 0.72, 0, 1)';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/**
 * Show the toast. With `from` (a rect), the toast grows out of that element:
 * it travels from there while a clip-path opens from that element's shape to
 * the card's (the glass follows the clip), so e.g. the recording pill
 * becomes the toast instead of vanishing while a new card slides in.
 */
function renderToast(html, ms = 6000, from = null) {
  const wasShown = isShown(ui.toast);
  ui.toast.classList.remove('dragging');
  ui.toast.style.transform = '';
  ui.toast.style.opacity = '';
  ui.toast.innerHTML = html;
  for (const el of $$('[data-icon]', ui.toast)) el.insertAdjacentHTML('afterbegin', I[el.dataset.icon]);
  if (from && !reduceMotion.matches) {
    ui.toast.classList.add('dragging'); // no CSS transition: the morph drives it
    show(ui.toast);
    const T = ui.toast.getBoundingClientRect();
    const media = $('.t-media', ui.toast);
    const dx = from.left + from.width / 2 - (T.left + T.width / 2);
    const dy = from.top + from.height / 2 - (T.top + T.height / 2);
    const ix = Math.max(0, (T.width - from.width) / 2), iy = Math.max(0, (T.height - from.height) / 2);
    const r = Math.min(from.height / 2, 22);
    const a = ui.toast.animate([
      { transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(${iy}px ${ix}px ${iy}px ${ix}px round ${r}px)` },
      { transform: 'translate(0px, 0px)', clipPath: 'inset(0px 0px 0px 0px round 20px)' },
    ], { duration: 520, easing: EASE_DRAWER });
    for (const k of ui.toast.children) {
      k.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 90, easing: 'ease', fill: 'backwards' });
    }
    a.onfinish = () => ui.toast.classList.remove('dragging');
  } else {
    show(ui.toast);
    // Same card, new content (e.g. after an export): crossfade, don't re-enter.
    if (wasShown) for (const k of ui.toast.children) k.animate([{ opacity: 0, filter: 'blur(4px)' }, { opacity: 1, filter: 'none' }], { duration: 220, easing: 'ease' });
  }
  armToast(ms);
}

function armToast(ms = 6000) {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (toastHover || editor.isOpen) return armToast(1500);
    hideToast();
  }, ms);
}

function hideToast(instant = false) {
  clearTimeout(toastTimer);
  if (!isShown(ui.toast)) return;
  ui.toast.style.transform = '';
  ui.toast.style.opacity = '';
  if (instant) {
    ui.toast.classList.add('dragging');
    ui.toast.classList.remove('show');
    requestAnimationFrame(() => ui.toast.classList.remove('dragging'));
  } else ui.toast.classList.remove('show');
  const v = $('video', ui.toast);
  if (v) setTimeout(() => v.pause(), 400);
}

function photoToast(c, title, path = null) {
  const name = `Screenshot ${stamp()}.png`;
  S.toastFile = path ? { path, kind: 'image' } : null;
  renderToast(`
    <div class="t-media"><img alt="Capture preview" draggable="true"></div>
    <div class="t-row">
      <div class="t-text"><b>${title}</b><span>${c.width} × ${c.height} · PNG</span></div>
      <div class="t-acts">
        <button class="btn icon" data-act="t-edit" data-icon="edit" data-tip="Edit" aria-label="Edit"></button>
        <button class="btn icon" data-act="t-pin" data-icon="pin" data-tip="Pin" aria-label="Pin"></button>
        <button class="btn icon" data-act="t-save" data-icon="save" data-tip="Save" aria-label="Save"></button>
        <button class="btn icon" data-act="t-close" data-icon="close" data-tip="Dismiss" aria-label="Dismiss"></button>
      </div>
    </div>`);
  c.toBlob((b) => {
    const url = URL.createObjectURL(b);
    const img = $('img', ui.toast);
    if (!img) return;
    img.src = url;
    img.dataset.url = path ? `file://${path}` : url;
    img.dataset.name = name;
    img.dataset.type = 'image/png';
  });
}

const fmtSize = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** Toast for a recording or an exported clip (video or GIF). */
function mediaToast({ kind, url, path, ext, w, h, dur, size, title, source = false, from = null, poster = null }) {
  const name = `Recording ${stamp()}.${ext}`;
  S.toastFile = path ? { path, kind } : null;
  const type = kind === 'gif' ? 'image/gif' : `video/${ext}`;
  const media = kind === 'gif'
    ? `<img class="t-gif" alt="GIF preview" draggable="true" src="${url}" data-url="${url}" data-name="${name}" data-type="${type}">`
    : S.mediaOk === false
      ? `<img class="t-poster" alt="Recording preview" src="${poster || ''}" data-url="${url}" data-name="${name}" data-type="${type}">`
      : `<video muted autoplay loop playsinline draggable="true" src="${url}" data-url="${url}" data-name="${name}" data-type="${type}"></video>`;
  renderToast(`
    <div class="t-media">${media}<span class="t-badge">${fmt(dur)}</span></div>
    <div class="t-row">
      <div class="t-text"><b>${title}</b><span>${kind === 'gif' ? 'GIF' : ext.toUpperCase()} · ${w}×${h}${size ? ` · ${fmtSize(size)}` : ''}</span></div>
      <div class="t-acts">
        <button class="btn icon" data-act="t-trim" data-icon="trim" data-tip="Trim, or make a GIF" aria-label="Trim or make a GIF"></button>
        <button class="btn icon" data-act="t-save" data-icon="save" data-tip="Save" aria-label="Save"></button>
        <button class="btn icon" data-act="t-close" data-icon="close" data-tip="Dismiss" aria-label="Dismiss"></button>
      </div>
    </div>`, 10000, from);
  if (kind !== 'video' || !source || !$('video', ui.toast)) return;
  const v = $('video', ui.toast);
  // WebM from MediaRecorder has no duration in its header; seeking far
  // forces the browser to scan it, then we rewind.
  v.addEventListener('loadedmetadata', () => {
    const apply = () => {
      if (S.video?.url !== url) return;
      if (S.video.b >= S.video.dur - 1e-3) S.video.b = v.duration;
      S.video.dur = v.duration;
      const badge = $('.t-badge', ui.toast);
      if (badge) badge.textContent = fmt(v.duration);
    };
    if (!Number.isFinite(v.duration)) {
      v.addEventListener('durationchange', function fix() {
        if (!Number.isFinite(v.duration)) return;
        v.removeEventListener('durationchange', fix);
        apply();
        v.currentTime = 0;
        v.play().catch(() => {});
      });
      v.currentTime = 1e101;
    } else apply();
  }, { once: true });
}

ui.toast.addEventListener('pointerenter', () => { toastHover = true; });
ui.toast.addEventListener('pointerleave', () => { toastHover = false; });

ui.toast.addEventListener('dragstart', (e) => {
  const m = e.target.closest('[data-url]');
  if (!m) return;
  e.dataTransfer.setData('DownloadURL', `${m.dataset.type}:${m.dataset.name}:${m.dataset.url}`);
  e.dataTransfer.setData('text/uri-list', m.dataset.url);
});

// Swipe the toast toward the right edge to dismiss it (velocity counts).
ui.toast.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || ui.toast.classList.contains('expanded') || e.target.closest('button, .t-media')) return;
  const x0 = e.clientX, t0 = now();
  let dx = 0;
  ui.toast.setPointerCapture(e.pointerId);
  ui.toast.classList.add('dragging');
  const move = (ev) => {
    dx = ev.clientX - x0;
    const tx = dx > 0 ? dx : dx * 0.15;
    ui.toast.style.transform = `translateX(${tx}px)`;
    ui.toast.style.opacity = String(clamp(1 - Math.max(0, dx) / 320, 0.2, 1));
  };
  const up = () => {
    ui.toast.removeEventListener('pointermove', move);
    ui.toast.removeEventListener('pointerup', up);
    ui.toast.removeEventListener('pointercancel', up);
    ui.toast.classList.remove('dragging');
    const v = Math.abs(dx) / Math.max(1, now() - t0);
    if (dx > 90 || (dx > 12 && v > 0.11)) {
      ui.toast.style.transform = '';
      ui.toast.style.opacity = '';
      hideToast();
    } else {
      ui.toast.style.transform = '';
      ui.toast.style.opacity = '';
    }
  };
  ui.toast.addEventListener('pointermove', move);
  ui.toast.addEventListener('pointerup', up);
  ui.toast.addEventListener('pointercancel', up);
});

// ---------------------------------------------------------------- tooltip

let tipTimer = null, tipEl = null, tipHiddenAt = 0;

function hideTip() {
  clearTimeout(tipTimer);
  tipEl = null;
  if (isShown(ui.tip)) {
    hide(ui.tip, true);
    tipHiddenAt = now();
  }
}

function showTip(el, instant) {
  if (!el.isConnected || el.disabled) return;
  const key = el.dataset.key;
  ui.tip.innerHTML = `${el.dataset.tip}${key ? key.split(' ').map((k) => `<kbd>${k}</kbd>`).join('') : ''}`;
  ui.tip.style.gap = '6px';
  const b = el.getBoundingClientRect();
  const w = ui.tip.offsetWidth, h = ui.tip.offsetHeight;
  const x = clamp(b.left + b.width / 2 - w / 2, 8, W - w - 8);
  let y = b.top - 10 - h, origin = '100%';
  const above = y, below = b.bottom + 10;
  // While recording, a tooltip must not open inside the recorded area (it
  // would be in the video): use whichever side of the control stays clear.
  const inRec = (ty) => S.mode === 'recording' && S.sel && !S.captureHidden && !(x + w <= S.sel.x - 4 || x >= S.sel.x + S.sel.w + 4 || ty + h <= S.sel.y - 4 || ty >= S.sel.y + S.sel.h + 4);
  if (above < TOPBAR + 4 || (inRec(above) && !inRec(below))) { y = below; origin = '0'; }
  ui.tip.style.left = x + 'px';
  ui.tip.style.top = y + 'px';
  ui.tip.style.transformOrigin = `${b.left + b.width / 2 - x}px ${origin}`;
  show(ui.tip, instant);
}

document.addEventListener('pointerover', (e) => {
  const el = e.target.closest?.('[data-tip]') || null;
  if (el === tipEl) return;
  clearTimeout(tipTimer);
  if (!el || el.closest('.float:not(.show)')) {
    if (isShown(ui.tip)) { hide(ui.tip, true); tipHiddenAt = now(); }
    tipEl = null;
    return;
  }
  tipEl = el;
  // First tooltip waits; neighbours open instantly once one is showing.
  const warm = isShown(ui.tip) || now() - tipHiddenAt < 500;
  if (warm) showTip(el, true);
  else tipTimer = setTimeout(() => showTip(el, false), 550);
});
document.addEventListener('pointerdown', () => hideTip(), true);

// ---------------------------------------------------------------- UI clicks

ui.root.addEventListener('click', (e) => {
  if (e.target.closest('.toast .t-media video, .toast .t-gif, .toast .t-poster')) return openEditor();
  if (e.target.closest('.toast .t-media img')) return reopenSession();
  const mi = e.target.closest('.mi');
  if (mi) return pickSource(mi.dataset.src, mi.dataset.id);
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.kind) {
    S.kind = t.dataset.kind;
    updateSeg(false);
    return;
  }
  if (t.dataset.menu) return toggleMenu(t.dataset.menu, t);
  if (t.dataset.tool) { setTool(t.dataset.tool); return; }
  if (t.dataset.color) { setColor(+t.dataset.color); return; }
  if (t.dataset.width) { setWidth(+t.dataset.width); return; }
  if (t.dataset.opt) {
    const o = t.dataset.opt;
    if (o === 'mic') audio.mic.on ? audio.disableMic() : audio.enableMic();
    else if (o === 'sys') audio.setSystem(!audio.sys.on);
    else { S.opts[o] = !S.opts[o]; syncOpts(); }
    return;
  }
  switch (t.dataset.act) {
    case 'cancel': return cancelCapture();
    case 'color': return togglePopover();
    case 'undo': return undo();
    case 'redo': return redo();
    case 'pin': return actPin();
    case 'save': return actSave();
    case 'copy': return actCopy();
    case 'start': return startCountdown();
    case 'cd-cancel': clearCountdown(); return setMode('ready');
    case 'cd-now': clearCountdown(); return startRecording();
    case 'pause': return togglePause();
    case 'stop': return stopRecording();
    case 'discard': return stopRecording(true);
    case 't-edit': return reopenSession();
    case 't-pin': {
      const s = S.session;
      if (s) addPin(s.image, s.sel);
      return hideToast();
    }
    case 't-save': {
      const f = S.toastFile;
      const sub = $('.t-text b', ui.toast);
      const done = (r) => { if (sub) sub.textContent = `Saved to ${r.dir}`; };
      if (f) native.call('save-file', f).then(done, () => { if (sub) sub.textContent = 'Save failed'; });
      else if (S.session) native.call('save-image', { png: pngOf(S.session.image) }).then(done);
      return armToast(2500);
    }
    case 't-close': return hideToast();
    case 't-trim': return openEditor();
  }
});

// Close the color popover on any outside press.
document.addEventListener('pointerdown', (e) => {
  if (isShown(ui.pop) && !e.target.closest('#colorPop, #colorBtn')) closePopover();
}, true);

const pill = liquidPill($('.seg', ui.modebar), $('.seg-ind', ui.modebar));

function updateSeg(instant, fromPill = false) {
  const btns = $$('.seg .btn', ui.modebar);
  const i = S.kind === 'photo' ? 0 : 1;
  if (!fromPill) pill.go(i, instant);
  btns.forEach((b, j) => {
    b.classList.toggle('on', j === i);
    b.setAttribute('aria-checked', j === i);
  });
}

// ----- audio sources

const audio = new AudioSources(() => { syncOpts(); if (isShown(ui.menu)) renderMenu(); });

/** On/off toggles swap to a crossed-out icon when off, so the state reads at a glance. */
function setToggleIcon(btn, name, on) {
  const want = on ? name : `${name}Off`;
  if (btn.dataset.iconState === want || !I[want]) return;
  btn.dataset.iconState = want;
  btn.querySelector('svg')?.remove();
  btn.insertAdjacentHTML('afterbegin', I[want]);
}

function syncOpts() {
  const mic = $('[data-split="mic"]', ui.ready), sys = $('[data-opt="sys"]', ui.ready);
  mic.classList.toggle('on', audio.mic.on);
  $('.lbl', mic).textContent = audio.mic.on ? audio.mic.label : audio.denied ? 'Mic blocked' : 'Mic';
  $('[data-opt="mic"]', mic).setAttribute('aria-pressed', audio.mic.on);
  $('[data-opt="mic"]', mic).dataset.tip = audio.mic.on ? `Microphone: ${audio.mic.label}` : 'Microphone off';
  setToggleIcon($('[data-opt="mic"]', mic), 'mic', audio.mic.on);
  setToggleIcon(sys, 'speaker', audio.sys.on);
  sys.classList.toggle('on', audio.sys.on);
  sys.setAttribute('aria-pressed', audio.sys.on);
  sys.dataset.tip = audio.sys.on ? 'System audio on' : 'System audio off';
  const clicks = $('[data-opt="clicks"]', ui.ready);
  setToggleIcon(clicks, 'cursor', S.opts.clicks);
  clicks.classList.toggle('on', S.opts.clicks);
  clicks.setAttribute('aria-pressed', S.opts.clicks);
  if (isShown(ui.ready) && S.sel) placeBelow(ui.ready, S.sel);
}

function updateMeters() {
  const lv = audio.tick();
  const bars = [0.55, 1, 0.75];
  for (const m of $$('.meter', document)) {
    m.querySelectorAll('i').forEach((b, j) => {
      const v = Math.max(0.18, Math.min(1, lv * bars[j] * 1.6));
      b.style.transform = `scaleY(${v.toFixed(3)})`;
    });
  }
}

let menuFor = null;
function renderMenu() {
  const check = I.check;
  const item = (src, id, label, sub, on) => `<button class="mi${on ? ' on' : ''}" role="menuitemradio" aria-checked="${on}" data-src="${src}" data-id="${id}">${check}<span><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span></button>`;
  let html = '<div class="menu-h">Microphone</div>';
  for (const m of audio.mics) html += item('mic', m.id, m.label, '', audio.mic.on && audio.mic.id === m.id);
  html += '<div class="menu-sep"></div>' + item('mic', 'off', 'No microphone', '', !audio.mic.on);
  if (!audio.permitted) html += `<div class="menu-note">${audio.denied ? 'Microphone access is blocked for this page.' : 'Your other microphones appear once you allow access.'}</div>`;
  ui.menu.innerHTML = html;
}

function toggleMenu(which, anchor) {
  if (isShown(ui.menu) && menuFor === which) return closeMenu();
  menuFor = which;
  if (which === 'mic') audio.refreshMics();
  renderMenu();
  const split = anchor.closest('.split') || anchor;
  const a = split.getBoundingClientRect(), bar = ui.ready.getBoundingClientRect();
  const w = ui.menu.offsetWidth, h = ui.menu.offsetHeight;
  let y = bar.top - 8 - h, origin = '100%';
  if (y < TOPBAR + 8) { y = bar.bottom + 8; origin = '0'; }
  const x = clamp(a.left, 8, W - w - 8);
  ui.menu.style.left = x + 'px';
  ui.menu.style.top = y + 'px';
  ui.menu.style.transformOrigin = `${a.left + a.width / 2 - x}px ${origin}`;
  for (const b of $$('[data-menu]', ui.ready)) b.setAttribute('aria-expanded', b.dataset.menu === which);
  show(ui.menu);
}

function closeMenu(instant = false) {
  if (!isShown(ui.menu)) return;
  hide(ui.menu, instant);
  for (const b of $$('[data-menu]', ui.ready)) b.setAttribute('aria-expanded', 'false');
}

function pickSource(src, id) {
  if (id === 'off') audio.disableMic();
  else audio.enableMic(id);
  setTimeout(() => closeMenu(), 120);
}

document.addEventListener('pointerdown', (e) => {
  if (isShown(ui.menu) && !e.target.closest('#srcMenu, [data-menu]')) closeMenu();
}, true);

// ----- video editor

const editor = createEditor({
  icons: I,
  canPlay: () => S.mediaOk !== false,
  onOpen: () => { clearTimeout(toastTimer); hideTip(); syncInput(true); },
  onClose: () => { syncInput(true); },
  onSave: (res, action) => {
    const V = S.video;
    if (!res || !V) { if (V) { show(ui.toast, true); armToast(6000); } return; }
    const gif = res.kind === 'gif';
    const title = action === 'save' ? `Saved to ${res.dir}` : gif ? 'GIF copied' : res.trimmed ? 'Trimmed · copied' : 'Copied to clipboard';
    mediaToast({ kind: gif ? 'gif' : 'video', url: res.url, path: res.path, ext: gif ? 'gif' : 'mp4', w: res.w, h: res.h, dur: res.dur, size: res.size, title, poster: V.cache?.[0]?.url });
  },
});

function openEditor() {
  if (!S.video || editor.isOpen || S.mode !== 'idle') return;
  editor.open(S.video, ui.toast);
}

// ---------------------------------------------------------------- cursor

function updateCursor(p = S.mouse) {
  let c = 'default';
  const resizeCursor = (h) => ({ nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' })[h];
  if (S.mode === 'select') c = 'crosshair';
  else if (S.mode === 'edit' || S.mode === 'ready') {
    if (S.down?.type === 'resize') c = resizeCursor(S.down.h);
    else if (S.down?.type === 'move' || S.down?.type === 'moveAnn') c = 'grabbing';
    else if (S.mode === 'ready' || S.tool === 'select') {
      const h = hitHandle(p);
      if (h) c = resizeCursor(h);
      else if (S.mode === 'edit' && S.anns.some((a) => Ann.hit(a, p))) c = 'move';
      else if (inRect(p, S.sel)) c = 'grab';
      else c = 'crosshair';
    } else c = S.tool === 'text' ? 'text' : 'crosshair';
  }
  if (scene.style.cursor !== c) scene.style.cursor = c;
}

// ---------------------------------------------------------------- keyboard

const TOOL_KEYS = { v: 'select', a: 'arrow', r: 'rect', p: 'pen', t: 'text', h: 'hl', b: 'blur', n: 'num' };

document.addEventListener('keydown', (e) => {
  if (S.textEdit) return;
  if (editor.isOpen) { editor.keydown(e); return; }
  const k = e.key;
  const key = k.length === 1 ? k.toLowerCase() : k;
  const mod = e.ctrlKey || e.metaKey;
  if (k === 'Escape' && isShown(ui.menu)) { closeMenu(); return; }

  switch (S.mode) {
    case 'idle':
      if (k === 'Escape') hideToast();
      return;

    case 'select':
      if (k === 'Escape') cancelCapture();
      else if (k === ' ') { e.preventDefault(); selectFull(); }
      else if (key === 'v' || k === 'Tab') {
        e.preventDefault();
        if ($('[data-kind="video"]', ui.modebar).hidden) return;
        S.kind = S.kind === 'photo' ? 'video' : 'photo';
        updateSeg(true);
      }
      return;

    case 'edit': {
      if (k === 'Escape') {
        if (isShown(ui.pop)) closePopover();
        else if (S.selAnn >= 0) { S.selAnn = -1; dirty = true; }
        else cancelCapture();
        return;
      }
      if (k === 'Enter') { e.preventDefault(); actCopy(); return; }
      if (mod) {
        if (key === 'c') { e.preventDefault(); actCopy(true); }
        else if (key === 's') { e.preventDefault(); actSave(); }
        else if (key === 'p') { e.preventDefault(); actPin(); }
        else if (key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
        else if (key === 'z' || key === 'y') { e.preventDefault(); key === 'y' ? redo() : undo(); }
        return;
      }
      if (k === 'Delete' || k === 'Backspace') { deleteSelected(); return; }
      if (TOOL_KEYS[key]) {
        const t = TOOL_KEYS[key];
        setTool(S.tool === t && t !== 'select' ? 'select' : t, true);
        return;
      }
      if (k >= '1' && k <= '5') { setColor(+k - 1); return; }
      if (k === '[') { setWidth(S.width - 1); return; }
      if (k === ']') { setWidth(S.width + 1); return; }
      if (k.startsWith('Arrow')) { e.preventDefault(); nudge(k, e.shiftKey ? 10 : 1); }
      return;
    }

    case 'ready':
      if (k === 'Escape') cancelCapture();
      else if (k === 'Enter') { e.preventDefault(); startCountdown(); }
      else if (k.startsWith('Arrow')) { e.preventDefault(); nudge(k, e.shiftKey ? 10 : 1); }
      return;

    case 'countdown':
      if (k === 'Enter') { e.preventDefault(); clearCountdown(); startRecording(); }
      else if (k === 'Escape') { clearCountdown(); setMode('ready'); }
      return;

    case 'recording':
      if (k === 'Escape') armDiscard();
      else if (key === 'r' && !mod) stopRecording();
      else if (key === ' ' && !mod) { e.preventDefault(); togglePause(); }
      return;
  }
});

function nudge(k, n) {
  const dx = k === 'ArrowLeft' ? -n : k === 'ArrowRight' ? n : 0;
  const dy = k === 'ArrowUp' ? -n : k === 'ArrowDown' ? n : 0;
  if (S.mode === 'edit' && S.selAnn >= 0) {
    pushUndo();
    S.anns = S.anns.slice();
    S.anns[S.selAnn] = Ann.moved(S.anns[S.selAnn], dx, dy);
  } else if (S.sel) {
    S.sel = { ...S.sel, x: clamp(S.sel.x + dx, 0, W - S.sel.w), y: clamp(S.sel.y + dy, 0, H - S.sel.h) };
    placeFloating();
  }
  dirty = true;
}

// ---------------------------------------------------------------- boot

addEventListener('resize', resize);
resize();
syncColor();
syncUndo();
syncOpts();


// ---------------------------------------------------------------- host

/**
 * Which parts of the overlay take input. Outside a capture the overlay is
 * click-through except for the toast, pins and the recording bar, and it
 * never takes the keyboard, so the desktop works normally underneath.
 */
let lastInput = '';
function syncInput(force = false) {
  const full = CAPTURE_MODES.includes(S.mode) || editor.isOpen || !!S.textEdit;
  const rects = [];
  if (!full) {
    const add = (el, pad = 6) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push([Math.floor(r.left - pad), Math.floor(r.top - pad), Math.ceil(r.width + pad * 2), Math.ceil(r.height + pad * 2)]);
    };
    if (isShown(ui.toast)) add(ui.toast);
    for (const el of welcome.surfaces()) add(el);
    if (S.mode === 'recording') { if (isShown(ui.ready)) add(ui.ready); if (isShown(ui.menu)) add(ui.menu); }
    if (isShown(ui.tip)) add(ui.tip, 0);
    for (const p of $$('#pins > *')) add(p, 0);
  }
  const key = JSON.stringify([full, rects]);
  if (!force && key === lastInput) return;
  lastInput = key;
  native.send('input', { full, keyboard: full, rects });
}

// The shortcut → 'prepare': stop a recording in progress, or hide our own floating
// bits (the toast) so they aren't in the screenshot, then let the host freeze
// the screen → 'capture' with the screenshot.
native.on('prepare', () => {
  welcome.hide(true);
  if (S.mode === 'recording') { stopRecording(); return native.send('prepared', { skip: true }); }
  if (S.mode !== 'idle' || editor.isOpen) return native.send('prepared', { skip: true });
  const hadToast = isShown(ui.toast);
  hideTip();
  hideToast(true);
  // Let the compositor show a frame without them before the screenshot.
  if (!hadToast) return native.send('prepared');
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => native.send('prepared'), 16)));
});

// Tray menu / click while recording full screen.
native.on('tray', (m) => {
  if (S.mode !== 'recording' || !S.rec) return;
  if (m.action === 'stop') stopRecording();
  else if (m.action === 'discard') stopRecording(true);
  else if ((m.action === 'pause') !== S.rec.paused) togglePause();
});

native.on('capture', (m) => {
  if (S.mode === 'idle' && !editor.isOpen) beginCapture('photo', m);
});

native.on('cancel', () => {
  if (editor.isOpen) return;
  if (CAPTURE_MODES.includes(S.mode)) cancelCapture();
});

// No page zoom, ever (pinch arrives as ctrl+wheel or gesture events).
addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false, capture: true });
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) addEventListener(t, (e) => e.preventDefault(), { passive: false });

// Test hook (used by the developer eval action; harmless otherwise).
window.__capture = { S, finishSelect, selectFull, startCountdown, startRecording, stopRecording, togglePause, actCopy, actSave, actPin,
  setTool, setColor, commitAnn, cancelCapture, openEditor, editor, setMode, audio, syncOpts, ui, setBarState };

// Whether WebKit can play our recordings (GStreamer plugins installed).
native.on('config', (m) => {
  S.mediaOk = m.mediaOk !== false;
  if ('captureHidden' in m) S.captureHidden = !!m.captureHidden;
  if (m.overlay) S.overlay = m.overlay;
  // No way to record on this desktop: offer screenshots only.
  if ('canRecord' in m) $('[data-kind="video"]', ui.modebar).hidden = !m.canRecord;
});


const welcome = initWelcome({ syncInput: () => syncInput(true) });

// The overlay window was asked to close (window mode): same as Escape.
native.on('key', (m) => {
  if (m.key === 'Escape' && CAPTURE_MODES.includes(S.mode)) cancelCapture();
});

// Capture self-test: show a tiny marker; the host screenshots the corner and
// checks whether it's there. If not, screen captures leave our overlay out
// (niri: block-out-from "screen-capture" kind="hide").
native.on('probe', () => {
  const dot = document.createElement('div');
  dot.style.cssText = 'position:fixed;left:0;top:0;width:8px;height:8px;background:#ff00ff;z-index:2147483647;pointer-events:none';
  document.body.appendChild(dot);
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
    native.call('probe-ready').finally(() => dot.remove());
  }, 50)));
});

native.send('ready');

requestAnimationFrame(frame);
