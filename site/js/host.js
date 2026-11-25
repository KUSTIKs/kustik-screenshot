// Stands in for the desktop app (kustik_screenshot/app.py) so the real UI (ui/) runs in a
// browser: the same messages in and out, answered from the canvas desktop.
//
// UI → host: window.webkit.messageHandlers.native.postMessage(JSON)
// host → UI: window.nativeReceive(msg)

import { drawCursor } from './fake-desktop.js';
import { encodeGif } from './gif.js';

const FPS = 30;

export class Host {
  constructor(desk, cursor) {
    this.desk = desk;
    this.cursor = cursor;
    this.clipboard = null; // { kind: 'image' | 'video' | 'gif' | 'text', url, w, h }
    this.ready = new Promise((res) => (this._ready = res));
    this.rec = null;
    this.monitor = null;
    window.webkit = { messageHandlers: { native: { postMessage: (s) => this.receive(JSON.parse(s)) } } };
  }

  post(msg) { window.nativeReceive?.(msg); }
  reply(id, data = {}) { if (id != null) this.post({ type: 'reply', id, data }); }

  /** The global shortcut: what pressing Super+Shift+S does. */
  trigger() { this.post({ type: 'prepare' }); }

  receive(m) {
    const fn = this['on_' + m.type.replace(/-/g, '_')];
    if (fn) Promise.resolve(fn.call(this, m, m.id)).catch((e) => console.warn('host', m.type, e));
  }

  // ---- lifecycle

  on_ready() {
    this.post({ type: 'config', mediaOk: true, captureHidden: false, overlay: 'layer', canRecord: true });
    this._ready();
  }
  on_log(m) { console.debug('[ui]', m.text); }
  on_input() {}
  on_painted() {}

  // ---- capture: freeze the desktop

  async on_prepared(m) {
    if (m.skip) return;
    const d = this.desk;
    d.render();
    const blob = await new Promise((r) => d.canvas.toBlob(r, 'image/png'));
    const img = URL.createObjectURL(blob);
    const windows = d.windows.map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h, title: w.title }));
    this.post({ type: 'capture', img, windows, output: { name: 'eDP-1', x: 0, y: 0, w: d.w, h: d.h, scale: d.dpr } });
  }

  // ---- clipboard and files

  async on_copy_image(m, id) {
    const url = `data:image/png;base64,${m.png}`;
    const img = await loadImage(url);
    this.clipboard = { kind: 'image', url, img, w: img.naturalWidth, h: img.naturalHeight };
    this.reply(id, { path: 'Screenshot.png' });
  }
  on_save_image(m, id) { this.reply(id, { path: 'Screenshot.png', dir: 'Pictures/Screenshots' }); }
  on_save_file(m, id) { this.reply(id, { path: m.path, dir: m.kind === 'image' ? 'Pictures/Screenshots' : 'Videos/Recordings' }); }

  // ---- audio (no real devices: a believable meter)

  on_list_mics(m, id) { this.reply(id, { mics: [{ id: 'mic', label: 'Built-in Microphone' }], default: 'mic' }); }
  on_mic_monitor(m) {
    clearInterval(this.monitor);
    if (!m.source) return;
    let t = 0;
    this.monitor = setInterval(() => {
      t += 0.05;
      const v = Math.max(0, 0.35 + 0.3 * Math.sin(t * 7) * Math.sin(t * 2.3) + 0.15 * Math.random());
      this.post({ type: 'mic-level', v: Math.min(1, v) });
    }, 50);
  }

  // ---- tray indicator → the top bar's recording dot

  on_tray_show(m, id) { this.desk.rec = { time: '0:00', paused: false }; this.desk.changed = true; this.reply(id, { ok: true }); }
  on_tray_update(m) { if (this.desk.rec) Object.assign(this.desk.rec, { time: m.time, paused: !!m.paused }); }
  on_tray_hide() { this.desk.rec = null; this.desk.changed = true; }

  // ---- recording: the canvas region → video, plus filmstrip and scrub frames

  on_record_start(m, id) {
    const d = this.desk, k = d.dpr, r = m.region;
    const w = Math.round(r.w * k) & ~1, h = Math.round(r.h * k) & ~1;
    const out = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const oc = out.getContext('2d');
    const stream = out.captureStream(FPS);
    const mr = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 8e6 });
    const chunks = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const thumbCanvas = document.createElement('canvas');
    const cacheCanvas = document.createElement('canvas');
    const rec = this.rec = { mr, chunks, w, h, t0: performance.now(), paused: 0, pausedAt: 0, thumbs: [], cache: [], lastThumb: -1, lastCache: -1 };
    const draw = () => {
      if (this.rec !== rec) return;
      d.render();
      oc.drawImage(d.canvas, r.x * k, r.y * k, w, h, 0, 0, w, h);
      if (m.cursor && this.cursor.visible) {
        oc.save(); oc.scale(k, k);
        drawCursor(oc, this.cursor.x - r.x, this.cursor.y - r.y);
        oc.restore();
      }
      if (!rec.pausedAt) {
        const t = (performance.now() - rec.t0 - rec.paused) / 1000;
        if (Math.floor(t * 10 / 3) > rec.lastThumb) { rec.lastThumb = Math.floor(t * 10 / 3); rec.thumbs.push(snap(out, thumbCanvas, 0, 68, 0.6)); }
        if (Math.floor(t * 15) > rec.lastCache) { rec.lastCache = Math.floor(t * 15); rec.cache.push({ t: rec.lastCache / 15, url: snap(out, cacheCanvas, 720, 400, 0.8) }); }
      }
      rec.raf = requestAnimationFrame(draw);
    };
    draw();
    mr.start(250);
    this.reply(id);
  }
  on_record_pause() { const r = this.rec; if (r && !r.pausedAt) { r.pausedAt = performance.now(); r.mr.pause(); } }
  on_record_resume() { const r = this.rec; if (r && r.pausedAt) { r.paused += performance.now() - r.pausedAt; r.pausedAt = 0; r.mr.resume(); } }

  async on_record_stop(m, id) {
    const r = this.rec;
    if (!r) return this.reply(id, {});
    this.rec = null;
    cancelAnimationFrame(r.raf);
    if (r.pausedAt) this.on_record_resume.call({ rec: r });
    await new Promise((res) => { r.mr.onstop = res; r.mr.stop(); });
    if (m.discard) return this.reply(id, {});
    const blob = new Blob(r.chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const dur = r.cache.length / 15;
    const path = `Recording ${stamp()}.mp4`;
    (this.files ??= new Map()).set(path, { kind: 'video', url, w: r.w, h: r.h, cache: r.cache });
    this.clipboard = this.files.get(path);
    this.reply(id, { path, url, dur, w: r.w, h: r.h, hasAudio: false, size: blob.size, thumbs: r.thumbs, cache: r.cache, cacheW: 720 });
  }

  // ---- export: trim (media fragment) or a real GIF from the scrub frames

  async on_export(m, id) {
    const src = this.files?.get(m.path);
    if (!src) return this.post({ type: 'error', id, error: 'missing source' });
    const a = +m.a, b = +m.b;
    if (m.fmt !== 'gif') {
      const url = `${src.url}#t=${a.toFixed(2)},${b.toFixed(2)}`;
      const res = { kind: 'video', path: m.path, url, dur: b - a, w: src.w, h: src.h, size: 0, dir: 'Videos/Recordings', trimmed: a > 0.01 || b < +m.dur - 0.01 };
      this.files.set(m.path, { ...src, url });
      if (m.action === 'copy') this.clipboard = { ...src, url };
      return this.reply(id, res);
    }
    const frames = src.cache.filter((f) => f.t >= a && f.t <= b);
    const first = await loadImage(frames[0].url);
    const gw = Math.min(480, first.naturalWidth), gh = Math.round(first.naturalHeight * gw / first.naturalWidth);
    const cv = Object.assign(document.createElement('canvas'), { width: gw, height: gh });
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const rgba = [];
    for (let i = 0; i < frames.length; i++) {
      cx.drawImage(await loadImage(frames[i].url), 0, 0, gw, gh);
      rgba.push({ data: cx.getImageData(0, 0, gw, gh).data, delay: 1 / 15 });
      this.post({ type: 'progress', id, p: (i / frames.length) * 0.5 });
    }
    const bytes = await encodeGif(rgba, gw, gh, (p) => this.post({ type: 'progress', id, p: 0.5 + p * 0.5 }));
    const blob = new Blob([bytes], { type: 'image/gif' });
    const url = URL.createObjectURL(blob);
    const path = m.path.replace(/\.\w+$/, '.gif');
    const img = await loadImage(url);
    const file = { kind: 'gif', url, img, w: gw, h: gh };
    this.files.set(path, file);
    if (m.action === 'copy') this.clipboard = file;
    this.reply(id, { kind: 'gif', path, url, dur: b - a, w: gw, h: gh, size: blob.size, dir: 'Videos/Recordings', trimmed: true });
  }
  on_cancel() {}
}

function snap(src, cv, maxW, maxH, q) {
  // maxW 0 → fixed height (filmstrip thumbnails)
  const k = maxW ? Math.min(1, maxW / src.width, maxH / src.height) : maxH / src.height;
  cv.width = Math.max(2, Math.round(src.width * k));
  cv.height = Math.max(2, Math.round(src.height * k));
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', q);
}

export function loadImage(url) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}
