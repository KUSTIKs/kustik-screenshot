// A Linux desktop painted on a canvas, so the (real) capture UI can freeze
// it, read its pixels and record it. The showcase scripts drive it: they type
// in the terminal, paste into the chat, and light the tray's recording dot.

export const SANS = '"Geist", ui-sans-serif, system-ui, sans-serif';
export const MONO = '"Geist Mono", ui-monospace, SFMono-Regular, monospace';
export const TOPBAR = 28;
const TB = 38; // window title bar

const LIGHT = { bg: '#FBFBFA', bar: '#EEEEF1', sep: 'rgba(0,0,0,.07)', border: 'rgba(0,0,0,.16)', title: '#5B5D66', ctl: 'rgba(0,0,0,.09)', glyph: 'rgba(0,0,0,.5)' };
const DARK = { bg: '#141418', bar: '#1C1C21', sep: 'rgba(255,255,255,.06)', border: 'rgba(255,255,255,.10)', title: '#9EA1AB', ctl: 'rgba(255,255,255,.09)', glyph: 'rgba(255,255,255,.55)' };
const TERM = { ...DARK, bg: '#0C0C0F', bar: '#18181C' };
const CHAT = { ...LIGHT, bg: '#FFFFFF', bar: '#F4F4F6' };

export class Desktop {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.wall = document.createElement('canvas');
    this.windows = [];
    this.term = { lines: [], input: '' };
    this.chat = { messages: [], focused: false };
    this.rec = null; // { time, paused } while the tray shows a recording
    this.blink = true;
    this.lastBlink = 0;
    this.minute = -1;
    this.changed = true;
  }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    for (const c of [this.canvas, this.wall]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.paintWall();
    if (!this.windows.length) this.layout();
    for (const win of this.windows) this.clamp(win);
    this.changed = true;
  }

  /** One focused window per scene ('browser' | 'terminal'); the chat waits
   *  off-stage and fades in when something gets pasted into it. */
  layout(scene = this.scene || 'browser') {
    this.scene = scene;
    const { w: W, h: H } = this;
    const mw = Math.round(W * 0.56), mh = Math.round(H * 0.76);
    const mx = Math.round((W - mw) / 2), my = TOPBAR + Math.round((H - TOPBAR - mh) / 2);
    // The chat sits high on the right: its message box must stay clear of the
    // capture toast, which appears in the bottom-right corner.
    const cw = Math.round(W * 0.27), ch = Math.round(H * 0.55);
    this.windows = [
      scene === 'terminal'
        ? { id: 'terminal', title: '~/fieldnotes', x: mx, y: my + 30, w: mw, h: Math.round(mh * 0.72), theme: TERM, draw: drawTerminal }
        : { id: 'browser', title: 'Notes on refraction', x: mx, y: my, w: mw, h: mh, theme: LIGHT, draw: drawBrowser, bar: drawUrlBar },
      { id: 'chat', title: 'Chat', x: W - cw - 28, y: TOPBAR + 26, w: cw, h: ch, theme: CHAT, draw: drawChat, hidden: true },
    ];
    this.resetContent();
  }

  /** Bring a hidden window in: fade and rise (opacity + offset, ease-out). */
  reveal(id, dur = 420) {
    const w = this.win(id);
    if (!w || !w.hidden) return;
    w.hidden = false;
    w.enter = { t0: performance.now(), dur };
    this.focus(w);
    this.changed = true;
  }
  /** Slide the main window aside to make room (used when the chat appears). */
  shift(id, dx, dur = 420) {
    const w = this.win(id);
    if (!w) return;
    w.move = { from: w.x, to: w.x + dx, t0: performance.now(), dur };
    this.changed = true;
  }

  resetContent() {
    this.term = { lines: [
      [['~/fieldnotes ', '#7CC4FF'], ['$ ', '#B5E48C'], ['git pull', '#E6E6EA']],
      [['Already up to date.', '#9A9DA7']],
    ], input: '' };
    this.chat = { focused: false, messages: [
      { me: false, text: 'Morning! Did the refraction essay go out?' },
      { me: true, text: 'Publishing today. One sec' },
      { me: false, text: 'Can you send me how the hero image looks?' },
    ] };
    this.rec = null;
    this.changed = true;
  }

  win(id) { return this.windows.find((w) => w.id === id); }

  // ---------- scripted content

  termType(ch) { this.term.input += ch; this.changed = true; }
  termRun(output = []) {
    this.term.lines.push([['~/fieldnotes ', '#7CC4FF'], ['$ ', '#B5E48C'], [this.term.input, '#E6E6EA']], ...output);
    this.term.input = '';
    this.changed = true;
  }
  termPrint(line) { this.term.lines.push(line); this.changed = true; }

  chatSend(msg) {
    this.chat.messages.push(msg);
    this.changed = true;
  }

  clamp(win) {
    win.x = Math.max(-win.w + 90, Math.min(this.w - 90, win.x));
    win.y = Math.max(TOPBAR, Math.min(this.h - 44, win.y));
  }

  tick(t) {
    if (t - this.lastBlink > 530) {
      this.lastBlink = t;
      this.blink = !this.blink;
      this.changed = true;
    }
    const m = new Date().getMinutes();
    if (m !== this.minute) { this.minute = m; this.changed = true; }
  }

  render() {
    if (!this.changed) return false;
    this.changed = false;
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.drawImage(this.wall, 0, 0, this.w, this.h);
    const now = performance.now();
    const ease = (k) => 1 - (1 - k) ** 3;
    for (const win of this.windows) {
      if (win.hidden) continue;
      if (win.move) {
        const k = Math.min(1, (now - win.move.t0) / win.move.dur);
        win.x = win.move.from + (win.move.to - win.move.from) * ease(k);
        if (k < 1) this.changed = true; else win.move = null;
      }
      let a = 1, dy = 0;
      if (win.enter) {
        const k = Math.min(1, (now - win.enter.t0) / win.enter.dur);
        a = ease(k); dy = (1 - ease(k)) * 16;
        if (k < 1) this.changed = true; else win.enter = null;
      }
      c.save();
      c.globalAlpha = a;
      c.translate(0, dy);
      this.drawWindow(c, win);
      c.restore();
    }
    this.drawTopbar(c);
    return true;
  }

  // ---------- stacking

  focus(win) {
    const i = this.windows.indexOf(win);
    if (i < 0 || i === this.windows.length - 1) return;
    this.windows.splice(i, 1);
    this.windows.push(win);
    this.changed = true;
  }

  // ---------- painting

  paintWall() {
    const c = this.wall.getContext('2d');
    const { w, h, dpr } = this;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const base = c.createLinearGradient(0, 0, 0, h);
    base.addColorStop(0, '#101019');
    base.addColorStop(1, '#0A0A10');
    c.fillStyle = base;
    c.fillRect(0, 0, w, h);
    const M = Math.max(w, h);
    for (const [bx, by, br, col, a] of [
      [0.18, 0.95, 0.55, '255,96,64', 0.22],
      [0.82, 0.05, 0.6, '96,92,255', 0.24],
      [0.6, 0.75, 0.4, '200,64,220', 0.12],
    ]) {
      const g = c.createRadialGradient(bx * w, by * h, 0, bx * w, by * h, br * M);
      g.addColorStop(0, `rgba(${col},${a})`);
      g.addColorStop(1, `rgba(${col},0)`);
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }
    const n = document.createElement('canvas');
    n.width = n.height = 128;
    const nc = n.getContext('2d');
    const img = nc.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 8;
    }
    nc.putImageData(img, 0, 0);
    c.fillStyle = c.createPattern(n, 'repeat');
    c.fillRect(0, 0, w, h);
  }

  drawWindow(c, win) {
    const { x, y, w, h, theme: t } = win;
    const r = 12;
    const top = this.windows[this.windows.length - 1] === win;
    c.save();
    c.shadowColor = top ? 'rgba(0,0,0,.5)' : 'rgba(0,0,0,.38)';
    c.shadowBlur = top ? 56 : 40;
    c.shadowOffsetY = top ? 22 : 14;
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    c.fillStyle = t.bg;
    c.fill();
    c.restore();

    c.save();
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    c.clip();
    c.fillStyle = t.bar;
    c.fillRect(x, y, w, TB);
    c.fillStyle = t.sep;
    c.fillRect(x, y + TB - 1, w, 1);
    // Window controls, right-aligned as on most Linux desktops.
    const cy = y + TB / 2;
    [['close', 22], ['max', 46], ['min', 70]].forEach(([k, dx]) => {
      const cx = x + w - dx;
      c.fillStyle = t.ctl;
      c.beginPath();
      c.arc(cx, cy, 8, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = t.glyph;
      c.lineWidth = 1.2;
      c.lineCap = 'round';
      c.beginPath();
      if (k === 'close') { c.moveTo(cx - 3, cy - 3); c.lineTo(cx + 3, cy + 3); c.moveTo(cx + 3, cy - 3); c.lineTo(cx - 3, cy + 3); }
      if (k === 'max') { c.rect(cx - 3, cy - 3, 6, 6); }
      if (k === 'min') { c.moveTo(cx - 3.5, cy + 0.5); c.lineTo(cx + 3.5, cy + 0.5); }
      c.stroke();
    });
    if (win.bar) win.bar(c, x, y, w, t);
    else {
      c.font = `500 12.5px ${SANS}`;
      c.fillStyle = t.title;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(win.title, x + w / 2, cy + 0.5);
    }
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.beginPath();
    c.rect(x, y + TB, w, h - TB);
    c.clip();
    win.draw(c, x, y + TB, w, h - TB, this);
    c.restore();

    c.beginPath();
    c.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r);
    c.strokeStyle = t.border;
    c.lineWidth = 1;
    c.stroke();
  }

  drawTopbar(c) {
    const W = this.w;
    c.fillStyle = 'rgba(6,6,10,.62)';
    c.fillRect(0, 0, W, TOPBAR);
    // Workspaces
    c.fillStyle = 'rgba(255,255,255,.92)';
    c.beginPath(); c.roundRect(14, 10, 22, 8, 4); c.fill();
    c.fillStyle = 'rgba(255,255,255,.35)';
    for (const x of [46, 58]) { c.beginPath(); c.arc(x, 14, 3, 0, Math.PI * 2); c.fill(); }
    // Clock
    const d = new Date();
    const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    c.font = `600 12.5px ${SANS}`;
    c.fillStyle = 'rgba(255,255,255,.92)';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(`${day}   ${time}`, W / 2, TOPBAR / 2 + 0.5);
    // Tray: wifi, volume, battery
    c.textAlign = 'right';
    c.font = `500 12px ${SANS}`;
    c.fillText('84%', W - 46, TOPBAR / 2 + 0.5);
    c.strokeStyle = 'rgba(255,255,255,.9)';
    c.lineWidth = 1.2;
    c.beginPath(); c.roundRect(W - 38, 9, 20, 10, 3); c.stroke();
    c.fillStyle = 'rgba(255,255,255,.9)';
    c.fillRect(W - 36, 11, 13.5, 6);
    c.fillRect(W - 17, 12, 1.6, 4);
    const wx = W - 100, wy = 18;
    c.lineCap = 'round';
    for (const r of [3.5, 7, 10.5]) { c.beginPath(); c.arc(wx, wy, r, -Math.PI * 0.75, -Math.PI * 0.25); c.stroke(); }
    c.beginPath(); c.arc(wx, wy, 1.2, 0, Math.PI * 2); c.fill();
    if (this.rec) {
      // The app's tray item: a red dot with a soft pulsing halo, then the time.
      const rx = W - 214, ry = 14;
      const t = (performance.now() % 1400) / 1400;
      if (!this.rec.paused) {
        const k = Math.min(1, t / 0.75), e = 1 - (1 - k) ** 3;
        c.fillStyle = `rgba(255,59,48,${0.55 * (1 - e) * (t < 0.75 ? 1 : 0)})`;
        c.beginPath(); c.arc(rx, ry, 4.5 + 4 * e, 0, Math.PI * 2); c.fill();
      }
      c.fillStyle = this.rec.paused ? 'rgba(200,200,210,.9)' : '#FF3B30';
      c.beginPath(); c.arc(rx, ry, 4.5, 0, Math.PI * 2); c.fill();
      c.fillStyle = 'rgba(255,255,255,.92)';
      c.font = `600 12px ${SANS}`;
      c.textAlign = 'left';
      c.fillText(this.rec.time || '0:00', rx + 10, TOPBAR / 2 + 0.5);
      c.fillStyle = 'rgba(255,255,255,.9)';
      this.changed = true; // keep pulsing
    }
    const vx = W - 128;
    c.beginPath(); c.moveTo(vx, 12); c.lineTo(vx + 3, 12); c.lineTo(vx + 7, 8.5); c.lineTo(vx + 7, 19.5); c.lineTo(vx + 3, 16); c.lineTo(vx, 16); c.closePath(); c.fill();
    c.beginPath(); c.arc(vx + 8, 14, 4.5, -0.9, 0.9); c.stroke();
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
  }
}

// ---------- window contents

function wrap(c, text, x, y, maxW, lh) {
  let line = '';
  for (const word of text.split(' ')) {
    const t = line ? line + ' ' + word : word;
    if (c.measureText(t).width > maxW && line) { c.fillText(line, x, y); y += lh; line = word; }
    else line = t;
  }
  if (line) { c.fillText(line, x, y); y += lh; }
  return y;
}

function drawUrlBar(c, x, y, w) {
  const pw = Math.min(340, w - 220), px = x + (w - pw) / 2, py = y + 7;
  c.fillStyle = 'rgba(0,0,0,.06)';
  c.beginPath(); c.roundRect(px, py, pw, 24, 8); c.fill();
  c.font = `500 12px ${SANS}`;
  c.fillStyle = '#6A6C74';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('fieldnotes.dev/notes/refraction', px + pw / 2, py + 12.5);
  // back / forward
  c.strokeStyle = '#8A8C94';
  c.lineWidth = 1.6;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const [cx, dir] of [[x + 22, -1], [x + 44, 1]]) {
    c.beginPath(); c.moveTo(cx - dir * 2.5, y + 14); c.lineTo(cx + dir * 2.5, y + 19); c.lineTo(cx - dir * 2.5, y + 24); c.stroke();
  }
}

function drawBrowser(c, x, y, w, h, desk) {
  c.fillStyle = '#FBFBFA';
  c.fillRect(x, y, w, h);
  const pad = Math.max(28, Math.min(56, w * 0.08));
  const cw = Math.min(w - pad * 2, 560);
  const cx = x + pad;
  let cy = y + 40;
  c.font = `600 11px ${SANS}`;
  c.fillStyle = '#E0532B';
  c.letterSpacing = '0.8px';
  c.fillText('ESSAY  ·  6 MIN READ', cx, cy);
  c.letterSpacing = '0px';
  cy += 40;
  c.font = `700 30px ${SANS}`;
  c.fillStyle = '#141416';
  c.letterSpacing = '-0.6px';
  c.fillText('Notes on refraction', cx, cy);
  const titleW = c.measureText('Notes on refraction').width;
  c.letterSpacing = '0px';
  const title = { x: cx, y: cy - 26, w: titleW, h: 32 };
  cy += 30;
  c.font = `400 15px ${SANS}`;
  c.fillStyle = '#4A4C53';
  cy = wrap(c, 'Glass bends what sits behind it. The trick to making an interface feel like glass is not the blur — it is the way the edges pull the world inward, so content seems to pour around the surface as it moves.', cx, cy, cw, 24);
  cy += 10;
  const hh = Math.min(160, h * 0.28);
  const heroRect = { x: cx, y: cy, w: cw, h: hh };
  const g = c.createLinearGradient(cx, cy, cx + cw, cy + hh);
  g.addColorStop(0, '#FFB38A');
  g.addColorStop(0.5, '#FF5E86');
  g.addColorStop(1, '#6E5BFF');
  c.save();
  c.beginPath(); c.roundRect(cx, cy, cw, hh, 12); c.fillStyle = g; c.fill(); c.clip();
  for (const [ox, oy, r, a] of [[0.28, 0.55, 0.32, 0.35], [0.7, 0.35, 0.22, 0.28], [0.82, 0.85, 0.14, 0.4]]) {
    const rg = c.createRadialGradient(cx + cw * ox - r * hh * 0.4, cy + hh * oy - r * hh * 0.4, 0, cx + cw * ox, cy + hh * oy, r * hh * 1.6);
    rg.addColorStop(0, `rgba(255,255,255,${a + 0.3})`);
    rg.addColorStop(0.6, `rgba(255,255,255,${a * 0.4})`);
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = rg;
    c.beginPath(); c.arc(cx + cw * ox, cy + hh * oy, r * hh * 1.6, 0, Math.PI * 2); c.fill();
  }
  c.restore();
  cy += hh + 30;
  const paraTop = cy - 17;
  c.font = `400 15px ${SANS}`;
  c.fillStyle = '#4A4C53';
  cy = wrap(c, 'Every floating surface is drawn on the GPU: a signed-distance shape, a refracted sample of the frozen screen beneath it, and a thin specular rim that catches the light.', cx, cy, cw, 24);
  cy += 6;
  c.fillStyle = '#4A4C53';
  c.fillText('Questions? Write to ', cx, cy);
  let tx = cx + c.measureText('Questions? Write to ').width;
  c.fillStyle = '#2F5BFF';
  c.font = `500 15px ${SANS}`;
  c.fillText('hello@fieldnotes.dev', tx, cy);
  const ew = c.measureText('hello@fieldnotes.dev').width;
  const email = { x: tx, y: cy - 15, w: ew, h: 20 };
  tx += ew;
  c.font = `400 15px ${SANS}`;
  c.fillStyle = '#4A4C53';
  c.fillText(' or call +1 (415) 555-0132.', tx, cy);
  const px = tx + c.measureText(' or call ').width;
  const phone = { x: px, y: cy - 15, w: c.measureText('+1 (415) 555-0132').width, h: 20 };
  // Where things were drawn, for the showcase scripts (e.g. what to pixelate).
  if (desk) desk.spots = { email, phone, title, hero: heroRect, col: { x: cx, w: cw }, para: { x: cx, y: paraTop, w: cw, h: cy + 8 - paraTop } };
}

function drawTerminal(c, x, y, w, h, desk) {
  c.fillStyle = '#0C0C0F';
  c.fillRect(x, y, w, h);
  c.font = `400 13px ${MONO}`;
  const lh = 20;
  const rows = Math.floor((h - 26) / lh);
  const lines = [...desk.term.lines, [['~/fieldnotes ', '#7CC4FF'], ['$ ', '#B5E48C'], [desk.term.input, '#E6E6EA']]].slice(-rows);
  let ly = y + 26;
  lines.forEach((line, i) => {
    let tx = x + 16;
    for (const [t, col] of line) {
      c.fillStyle = col;
      c.fillText(t, tx, ly);
      tx += c.measureText(t).width;
    }
    if (i === lines.length - 1 && desk.blink) {
      c.fillStyle = '#E6E6EA';
      c.fillRect(tx + 1, ly - 13, 8, 17);
    }
    ly += lh;
  });
}

// ---------- chat

function bubbleLines(c, text, maxW) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    const t = line ? `${line} ${word}` : word;
    if (c.measureText(t).width > maxW && line) { out.push(line); line = word; } else line = t;
  }
  if (line) out.push(line);
  return out;
}

function drawChat(c, x, y, w, h, desk) {
  c.fillStyle = '#FFFFFF';
  c.fillRect(x, y, w, h);
  // Header: who you're talking to.
  c.fillStyle = '#7C5CFF';
  c.beginPath(); c.arc(x + 32, y + 30, 16, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#fff';
  c.font = `600 12px ${SANS}`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('MC', x + 32, y + 30.5);
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.fillStyle = '#141416';
  c.font = `600 14px ${SANS}`;
  c.fillText('Maya Chen', x + 58, y + 27);
  c.fillStyle = '#2FB36B';
  c.beginPath(); c.arc(x + 62, y + 38, 3, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#8A8C94';
  c.font = `400 12px ${SANS}`;
  c.fillText('online', x + 70, y + 42);
  c.fillStyle = 'rgba(0,0,0,.07)';
  c.fillRect(x, y + 60, w, 1);

  // Composer
  const cy = y + h - 58;
  c.fillStyle = 'rgba(0,0,0,.05)';
  c.beginPath(); c.roundRect(x + 14, cy + 10, w - 28, 38, 19); c.fill();
  c.font = `400 14px ${SANS}`;
  c.fillStyle = '#9A9CA4';
  c.fillText('Message', x + 32, cy + 34);
  if (desk.chat.focused && desk.blink) {
    c.fillStyle = '#2F6BFF';
    c.fillRect(x + 32, cy + 20, 1.6, 18);
  }

  // Messages, newest at the bottom.
  const maxW = w * 0.72;
  let by = cy - 8;
  c.save();
  c.beginPath(); c.rect(x, y + 61, w, cy - y - 61); c.clip();
  for (let i = desk.chat.messages.length - 1; i >= 0 && by > y + 61; i--) {
    const m = desk.chat.messages[i];
    let bw, bh;
    if (m.img) {
      const iw = Math.min(maxW, m.w || 240), ih = iw * (m.h / m.w);
      bw = iw; bh = ih + (m.label ? 30 : 0);
      by -= bh;
      const bx = m.me ? x + w - 16 - bw : x + 16;
      c.save();
      c.beginPath(); c.roundRect(bx, by, bw, bh, 14); c.clip();
      c.fillStyle = m.me ? '#2F6BFF' : '#ECECF0';
      c.fillRect(bx, by, bw, bh);
      c.drawImage(m.img, bx, by, iw, ih);
      if (m.label) {
        c.fillStyle = m.me ? 'rgba(255,255,255,.92)' : '#4A4C53';
        c.font = `500 12px ${SANS}`;
        c.fillText(m.label, bx + 12, by + ih + 19);
      }
      c.restore();
    } else {
      c.font = `400 14px ${SANS}`;
      const lines = bubbleLines(c, m.text, maxW - 28);
      bw = Math.max(...lines.map((l) => c.measureText(l).width)) + 28;
      bh = lines.length * 20 + 16;
      by -= bh;
      const bx = m.me ? x + w - 16 - bw : x + 16;
      c.fillStyle = m.me ? '#2F6BFF' : '#ECECF0';
      c.beginPath(); c.roundRect(bx, by, bw, bh, 16); c.fill();
      c.fillStyle = m.me ? '#fff' : '#141416';
      lines.forEach((l, k) => c.fillText(l, bx + 14, by + 22 + k * 20));
    }
    by -= 8;
  }
  c.restore();
}

/** A synthetic pointer, drawn into recordings. */
export function drawCursor(c, x, y) {
  c.save();
  c.translate(x, y);
  c.beginPath();
  c.moveTo(0, 0);
  c.lineTo(0, 17);
  c.lineTo(4.3, 12.8);
  c.lineTo(7.2, 19);
  c.lineTo(10, 17.8);
  c.lineTo(7.2, 11.8);
  c.lineTo(12.6, 11.8);
  c.closePath();
  c.shadowColor = 'rgba(0,0,0,.35)';
  c.shadowBlur = 4;
  c.shadowOffsetY = 1;
  c.fillStyle = '#111';
  c.fill();
  c.shadowColor = 'transparent';
  c.strokeStyle = '#fff';
  c.lineWidth = 1.4;
  c.lineJoin = 'round';
  c.stroke();
  c.restore();
}
