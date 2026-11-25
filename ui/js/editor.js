// Video trim editor. Expands out of the toast into a large glass panel.
//
// Scrubbing never waits on the decoder: while you drag, the preview shows
// small JPEG frames the host extracted after recording (seeking a <video> per
// pointer move is slow). The video element is seeked once, when you let go.

import { native } from './native.js';
import { liquidPill } from './pill.js';
import { clamp, pad2 } from './dom.js';

const EASE_DRAWER = 'cubic-bezier(0.32, 0.72, 0, 1)';
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const FPS = 30;
const MIN_LEN = 0.2;
const SNAP_PX = 6;

const tfmt = (s) => {
  s = Math.max(0, s);
  return `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}.${Math.floor((s % 1) * 10)}`;
};
const secs = (s) => `${s.toFixed(1)} s`;

// Media transport glyphs are solid shapes, not outlines.
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.4-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>';

function rulerStep(dur) {
  if (dur <= 4) return [1, 0.25];
  if (dur <= 12) return [1, 0.5];
  if (dur <= 40) return [5, 1];
  if (dur <= 120) return [10, 2];
  return [30, 5];
}

export function createEditor({ icons: I, onSave, onOpen, onClose, canPlay = () => true }) {
  // The editor has no panel of its own: it lives inside the toast card, which
  // grows into the editor and shrinks back (one component, two shapes).
  const el = document.createElement('div');
  el.className = 'ed-in';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Trim recording');
  el.innerHTML = `
      <div class="ed-media"><video playsinline muted preload="auto"></video><canvas class="ed-scrub"></canvas></div>
      <div class="ed-row">
        <button class="ed-play" data-ed="play" aria-label="Play" data-tip="Play" data-key="Space">${PLAY}</button>
        <div class="ed-tl">
          <div class="ed-track">
            <div class="ed-film"><div class="ed-strip"></div><div class="ed-shade l"></div><div class="ed-shade r"></div></div>
            <div class="ed-sel">
              <span class="ed-h l" role="slider" aria-label="Start" tabindex="0" data-tip="Start" data-key="I"><b></b></span>
              <span class="ed-h r" role="slider" aria-label="End" tabindex="0" data-tip="End" data-key="O"><b></b></span>
            </div>
            <div class="ed-head"><span class="ed-knob"></span><span class="ed-bubble"></span></div>
          </div>
          <div class="ed-ruler"></div>
        </div>
      </div>
      <div class="ed-foot">
        <div class="seg ed-fmt" role="radiogroup" aria-label="Format">
          <span class="seg-ind"></span>
          <button class="btn" role="radio" data-fmt="video">Video</button>
          <button class="btn" role="radio" data-fmt="gif">GIF</button>
        </div>
        <span class="ed-meta"></span>
        <span class="ed-spacer"></span>
        <button class="btn ghost" data-ed="cancel" data-tip="Discard changes" data-key="Esc">Cancel</button>
        <button class="btn ghost" data-ed="save" data-tip="Save to Downloads" data-key="Ctrl S">Save</button>
        <button class="btn primary ed-go" data-ed="copy"><span class="ed-prog"></span><span class="pl">Copy</span><kbd class="enter">${I.enter}</kbd></button>
      </div>`;
  let box = null; // the toast, while it is the editor

  const $ = (s) => el.querySelector(s);
  let video = $('video');
  const scrub = $('.ed-scrub');
  const sctx = scrub.getContext('2d');
  const track = $('.ed-track');
  const strip = $('.ed-strip');
  const ruler = $('.ed-ruler');
  const sel = $('.ed-sel');
  const head = $('.ed-head');
  const bubble = $('.ed-bubble');
  const playBtn = $('.ed-play');
  const shadeL = $('.ed-shade.l'), shadeR = $('.ed-shade.r');

  let src = null;        // the source clip object owned by the app
  let V = null;          // working copy: { dur, a, b, fmt, ... }
  let fromRect = null;
  let open = false;
  let raf = 0;
  let drag = null;
  let busy = null;
  let ticks = [];
  let dispT = null;      // time shown while dragging / until a seek lands
  let scrim = 0, scrimTarget = 0;

  const fmtPill = liquidPill($('.ed-fmt'), $('.ed-fmt .seg-ind'), { attr: 'fmt' });

  // ---------- layout

  function layout() {
    const W = innerWidth, H = innerHeight;
    const w = Math.min(880, W - 48);
    // Fixed inner width: while the card grows, the content is revealed, not reflowed.
    el.style.width = `${w - 16}px`;
    const mediaH = Math.round(clamp((w - 20) / (V.w / V.h), 160, H * 0.52));
    $('.ed-media').style.height = `${mediaH}px`;
    box.style.width = `${w}px`;
    box.style.height = 'auto';
    const h = box.offsetHeight;
    box.style.height = `${h}px`;
    box.style.left = `${Math.round((W - w) / 2)}px`;
    box.style.top = `${Math.round(Math.max(36, (H - h) / 2))}px`;
    placeVideo();
    buildStrip();
    buildRuler();
    sync();
    syncHead();
  }

  function buildStrip() {
    strip.textContent = '';
    const tw = track.clientWidth, th = track.clientHeight;
    if (!tw || !V.frames.length) return;
    const tileW = th * (V.w / V.h);
    if (!(tileW > 1)) { console.warn('editor: track not laid out', { tw, th, w: V.w, h: V.h }); return; }
    const n = Math.min(200, Math.max(1, Math.ceil(tw / tileW)));
    for (let i = 0; i < n; i++) {
      const f = V.frames[Math.min(V.frames.length - 1, Math.floor(((i + 0.5) / n) * V.frames.length))];
      const c = document.createElement('canvas');
      c.width = f.width; c.height = f.height;
      c.getContext('2d').drawImage(f, 0, 0);
      c.style.width = `${tileW}px`;
      strip.appendChild(c);
    }
  }

  function buildRuler() {
    ruler.textContent = '';
    ticks = [];
    const [major, minor] = rulerStep(V.dur);
    const tw = track.clientWidth;
    for (let i = 0; i * minor <= V.dur + 1e-6; i++) {
      const t = Math.round(i * minor * 1000) / 1000;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      const tick = document.createElement('i');
      tick.className = isMajor ? 'M' : 'm';
      tick.style.left = `${(t / V.dur) * tw}px`;
      if (isMajor) tick.dataset.l = t >= 60 ? `${Math.floor(t / 60)}:${pad2(Math.round(t % 60))}` : `${Math.round(t)}s`;
      ruler.appendChild(tick);
      ticks.push({ t, el: tick });
    }
  }

  const x2t = (x) => (x / track.clientWidth) * V.dur;
  const t2x = (t) => (t / V.dur) * track.clientWidth;

  function sync() {
    const tw = track.clientWidth;
    const xa = t2x(V.a), xb = t2x(V.b);
    sel.style.transform = `translateX(${xa}px)`;
    sel.style.width = `${xb - xa}px`;
    shadeL.style.width = `${xa}px`;
    shadeR.style.width = `${tw - xb}px`;
    const len = V.b - V.a;
    const gifW = Math.min(640, V.cacheW || V.w);
    $('.ed-meta').textContent = V.fmt === 'gif'
      ? `${secs(len)} · GIF · ${gifW}×${Math.round((gifW * V.h) / V.w)}`
      : `${secs(len)} · ${V.ext.toUpperCase()} · ${V.w}×${V.h}`;
  }

  function syncHead() {
    const t = dispT ?? video.currentTime ?? 0;
    head.style.transform = `translateX(${t2x(clamp(t, 0, V.dur))}px)`;
    if (drag) bubble.textContent = tfmt(t);
  }

  function setFmt(f, fromPill = false, instant = false) {
    V.fmt = f;
    if (!fromPill) fmtPill.go(f === 'video' ? 0 : 1, instant);
    for (const b of el.querySelectorAll('[data-fmt]')) {
      b.classList.toggle('on', b.dataset.fmt === f);
      b.setAttribute('aria-checked', b.dataset.fmt === f);
    }
    $('.ed-go .pl').textContent = f === 'gif' ? 'Copy GIF' : 'Copy';
    sync();
  }

  // ---------- playback

  function setPlaying(p) {
    if (p) {
      hideScrub();
      if (video.currentTime >= V.b - 0.03 || video.currentTime < V.a - 0.03) video.currentTime = V.a;
      video.play().catch(() => {});
    } else video.pause();
  }
  const paintPlay = () => {
    const playing = !video.paused;
    playBtn.innerHTML = playing ? PAUSE : PLAY;
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playBtn.dataset.tip = playing ? 'Pause' : 'Play';
  };

  function loop() {
    if (!open) { raf = 0; return; }
    // Keep playback inside the kept range.
    if (!video.paused && !drag && video.currentTime >= V.b) video.currentTime = V.a;
    syncHead();
    raf = requestAnimationFrame(loop);
  }

  // One real seek at a time; the latest request wins.
  let seeking = false, pendingSeek = null;
  function seek(t) {
    if (seeking) { pendingSeek = t; return; }
    seeking = true;
    video.currentTime = t;
  }
  function onSeeked() {
    seeking = false;
    if (pendingSeek != null) { const t = pendingSeek; pendingSeek = null; seek(t); return; }
    if (!drag) { dispT = null; hideScrub(); }
  }

  /** The editor can adopt another element's <video> (the toast's), so the
   *  same playing video travels between them instead of being replaced. */
  function bindVideo(v) {
    if (video) for (const [ev, fn] of [['play', paintPlay], ['pause', paintPlay], ['seeked', onSeeked]]) video.removeEventListener(ev, fn);
    video = v;
    for (const [ev, fn] of [['play', paintPlay], ['pause', paintPlay], ['seeked', onSeeked]]) v.addEventListener(ev, fn);
  }
  bindVideo(video);

  /** Size the video to its picture (no letterbox), centred in the media box. */
  function placeVideo() {
    const box = $('.ed-media');
    const mw = box.clientWidth, mh = box.clientHeight;
    const s = Math.min(mw / V.w, mh / V.h);
    Object.assign(video.style, {
      position: 'absolute', inset: 'auto', objectFit: 'fill', transform: '',
      left: `${(mw - V.w * s) / 2}px`, top: `${(mh - V.h * s) / 2}px`,
      width: `${V.w * s}px`, height: `${V.h * s}px`,
    });
  }

  function contentRect(r, w, h) {
    const s = Math.min(r.width / w, r.height / h);
    return { x: r.left + (r.width - w * s) / 2, y: r.top + (r.height - h * s) / 2, w: w * s, h: h * s };
  }

  // ---------- instant preview from cached frames

  const bitmaps = new Map();
  let paintToken = 0;
  function nearestFrame(t) {
    const c = V.cache;
    if (!c?.length) return null;
    let lo = 0, hi = c.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (c[m].t < t) lo = m + 1; else hi = m; }
    if (lo > 0 && Math.abs(c[lo - 1].t - t) < Math.abs(c[lo].t - t)) lo--;
    return c[lo];
  }
  async function paintScrub(t) {
    const f = nearestFrame(t);
    if (!f) return;
    const token = ++paintToken;
    let bmp = bitmaps.get(f);
    if (!bmp) {
      const img = new Image();
      img.src = f.url;
      await img.decode();
      bmp = await createImageBitmap(img);
      bitmaps.set(f, bmp);
      if (bitmaps.size > 40) { const [k, v] = bitmaps.entries().next().value; v.close?.(); bitmaps.delete(k); }
    }
    if (token !== paintToken) return;
    // Layout size (not the on-screen rect, which is mid-animation while the
    // card grows), at device resolution.
    const k = window.devicePixelRatio || 1;
    const bw = Math.round(scrub.clientWidth * k), bh = Math.round(scrub.clientHeight * k);
    if (scrub.width !== bw || scrub.height !== bh) { scrub.width = bw; scrub.height = bh; }
    const s = Math.min(scrub.width / bmp.width, scrub.height / bmp.height);
    const w = bmp.width * s, h = bmp.height * s;
    sctx.clearRect(0, 0, scrub.width, scrub.height);
    sctx.drawImage(bmp, (scrub.width - w) / 2, (scrub.height - h) / 2, w, h);
    scrub.classList.add('on');
  }
  function hideScrub() { paintToken++; scrub.classList.remove('on'); }

  /** Show time `t` right now; seek the real video now or later. */
  function preview(t, commit) {
    dispT = t;
    syncHead();
    if (V.cache?.length) {
      paintScrub(t);
      if (commit) seek(t);
    } else seek(t);
  }

  // ---------- snapping ("stops"), with hysteresis so it never flickers

  let snapped = null;
  function snapTime(t, alt) {
    if (alt) { snapped = null; return { t, hit: null }; }
    const x = t2x(t);
    if (snapped && Math.abs(t2x(snapped.t) - x) < SNAP_PX + 4) return { t: snapped.t, hit: snapped, held: true };
    let best = null, bd = SNAP_PX;
    for (const c of [...ticks, { t: 0 }, { t: V.dur }]) {
      const d = Math.abs(t2x(c.t) - x);
      if (d < bd) { bd = d; best = c; }
    }
    snapped = best;
    return best ? { t: best.t, hit: best } : { t, hit: null };
  }

  function detent(handle, hit) {
    handle.querySelector('b').animate([{ transform: 'scaleY(1.5)' }, { transform: 'none' }], { duration: 180, easing: EASE_OUT });
    if (hit.el) {
      hit.el.classList.add('hit');
      setTimeout(() => hit.el.classList.remove('hit'), 240);
    }
  }

  // ---------- pointer

  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || busy) return;
    e.preventDefault();
    track.setPointerCapture(e.pointerId);
    video.pause();
    const r = track.getBoundingClientRect();
    const h = e.target.closest('.ed-h');
    snapped = null;
    if (h) {
      const left = h.classList.contains('l');
      drag = { type: left ? 'a' : 'b', el: h, r, off: e.clientX - r.left - t2x(left ? V.a : V.b) };
      h.classList.add('active');
      preview(left ? V.a : V.b, false);
    } else {
      drag = { type: 'scrub', r };
      scrubTo(e);
    }
    el.classList.add('dragging');
  });

  function scrubTo(e) {
    // The playhead lives inside the kept range.
    let t = clamp(x2t(e.clientX - drag.r.left), V.a, V.b);
    if (!e.altKey) for (const edge of [V.a, V.b]) if (Math.abs(t2x(edge) - t2x(t)) < SNAP_PX) t = edge;
    preview(t, !V.cache?.length);
  }

  track.addEventListener('pointermove', (e) => {
    if (!drag) {
      track.style.cursor = e.target.closest('.ed-h') ? 'ew-resize' : 'pointer';
      return;
    }
    if (drag.type === 'scrub') return scrubTo(e);
    const x = e.clientX - drag.r.left - drag.off;
    const raw = x2t(x);
    const lo = drag.type === 'a' ? 0 : V.a + MIN_LEN;
    const hi = drag.type === 'a' ? V.b - MIN_LEN : V.dur;
    // Past its limit the handle stretches like rubber instead of stopping dead.
    const over = raw < lo ? t2x(lo) - x : raw > hi ? x - t2x(hi) : 0;
    drag.el.style.setProperty('--stretch', (1 + Math.min(0.5, Math.max(0, over) * 0.012)).toFixed(3));
    const { t, hit, held } = snapTime(clamp(raw, lo, hi), e.altKey);
    const v = clamp(t, lo, hi);
    if (drag.type === 'a') V.a = v; else V.b = v;
    if (hit && !held) detent(drag.el, hit);
    sync();
    preview(drag.type === 'a' ? V.a : Math.max(V.a, V.b - 1 / FPS), false);
  });

  const endDrag = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    el.classList.remove('dragging');
    if (d.el) {
      d.el.classList.remove('active');
      d.el.style.setProperty('--stretch', '1');
    }
    // Land the real video on the frame you were looking at.
    seek(dispT ?? video.currentTime);
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);

  el.addEventListener('click', (e) => {
    const f = e.target.closest('[data-fmt]');
    if (f) { setFmt(f.dataset.fmt); return; }
    const b = e.target.closest('[data-ed]');
    if (!b) return;
    if (e.detail) b.blur(); // a mouse click must not leave focus for Space to re-trigger
    const a = b.dataset.ed;
    if (a === 'play') setPlaying(video.paused);
    else if (a === 'cancel') cancel();
    else if (a === 'save') run('save');
    else if (a === 'copy') run('copy');
  });

  // ---------- keyboard

  function keydown(e) {
    if (!open) return false;
    const k = e.key;
    const cur = dispT ?? video.currentTime;
    const step = e.shiftKey ? 1 : 1 / FPS;
    if (k === 'Escape') { e.preventDefault(); busy ? busy.cancel() : cancel(); return true; }
    if (busy) return true;
    if (k === ' ') { e.preventDefault(); setPlaying(video.paused); }
    else if (k === 'Enter') { e.preventDefault(); run('copy'); }
    else if ((e.ctrlKey || e.metaKey) && (k === 's' || k === 'S')) { e.preventDefault(); run('save'); }
    else if (k === 'i' || k === 'I') { V.a = clamp(cur, 0, V.b - MIN_LEN); sync(); bump('l'); }
    else if (k === 'o' || k === 'O') { V.b = clamp(cur, V.a + MIN_LEN, V.dur); sync(); bump('r'); }
    else if (k === 'g' || k === 'G') setFmt(V.fmt === 'gif' ? 'video' : 'gif');
    else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      video.pause();
      const d = k === 'ArrowLeft' ? -step : step;
      const focused = document.activeElement?.closest?.('.ed-h');
      if (focused?.classList.contains('l')) { V.a = clamp(V.a + d, 0, V.b - MIN_LEN); sync(); preview(V.a, true); }
      else if (focused?.classList.contains('r')) { V.b = clamp(V.b + d, V.a + MIN_LEN, V.dur); sync(); preview(V.b, true); }
      else preview(clamp(cur + d, V.a, V.b), true);
    }
    else if (k === 'Home') { video.pause(); preview(V.a, true); }
    else if (k === 'End') { video.pause(); preview(V.b, true); }
    return true;
  }
  // Space activates a focused button on keyup; we already handled it on keydown.
  document.addEventListener('keyup', (e) => { if (open && e.key === ' ') e.preventDefault(); }, true);

  function bump(side) {
    $(`.ed-h.${side} b`).animate([{ transform: 'scaleY(1.5)' }, { transform: 'none' }], { duration: 180, easing: EASE_OUT });
  }

  // ---------- open / close

  let fromMedia = null, adopted = null, from = null;
  const placeholder = video;

  const restoreVideoStyle = (v) => {
    for (const k of ['position', 'inset', 'objectFit', 'transform', 'transformOrigin', 'left', 'top', 'width', 'height']) v.style[k] = '';
  };

  /**
   * The toast card becomes the editor: the card's box grows to the editor's
   * size (the glass follows it), its own video keeps playing and flies from
   * the thumbnail into the preview, its title row fades out and the editing
   * controls fade in. Closing runs the same path backwards.
   */
  function openEditor(source, toast) {
    src = source;
    V = { ...source, a: source.a ?? 0, b: source.b ?? source.dur, fmt: source.fmt ?? 'video' };
    box = toast;
    open = true;
    dispT = null;
    const T0 = toast.getBoundingClientRect();
    const tmedia = toast.querySelector('.t-media'), trow = toast.querySelector('.t-row');
    const tv = tmedia?.querySelector('video'), tm = tmedia?.querySelector('video, img');
    fromMedia = tm ? contentRect(tm.getBoundingClientRect(), V.w, V.h) : null;
    const mediaBox = tmedia?.getBoundingClientRect();
    const rowR = trow?.getBoundingClientRect();
    from = { T0, tmedia, trow, box: mediaBox && { x: mediaBox.left - T0.left, y: mediaBox.top - T0.top, w: mediaBox.width, h: mediaBox.height }, row: rowR && { x: rowR.left - T0.left, y: rowR.top - T0.top, w: rowR.width } };

    adopted = tv && tv.currentSrc === V.url ? tv : null;
    if (adopted) {
      $('.ed-media').replaceChild(adopted, video);
      bindVideo(adopted);
      adopted.loop = false;
      adopted.muted = !V.hasAudio;
      if (adopted.currentTime < V.a || adopted.currentTime > V.b) adopted.currentTime = V.a;
    } else if (canPlay()) {
      video.src = V.url;
      video.muted = !V.hasAudio;
      video.currentTime = V.a;
      video.addEventListener('loadeddata', () => setPlaying(true), { once: true });
    }
    // Without playback support, the preview shows cached frames (scrubbing still works).
    playBtn.disabled = !canPlay();
    if (!canPlay()) requestAnimationFrame(() => preview(V.a, false));

    toast.classList.add('expanded', 'dragging');
    Object.assign(toast.style, { right: 'auto', bottom: 'auto', transform: 'none', opacity: '' });
    if (trow) Object.assign(trow.style, { position: 'absolute', left: `${from.row.x}px`, top: `${from.row.y}px`, width: `${from.row.w}px` });
    if (tmedia) tmedia.style.display = 'none';
    toast.appendChild(el);
    layout();
    setFmt(V.fmt, false, true);
    paintPlay();
    scrimTarget = 1;
    onOpen?.();

    const F = toast.getBoundingClientRect();
    // The base densifies as the card grows: a toast-sized card reads as glass,
    // a full editor needs a calmer base so the desktop doesn't show through.
    const small = { left: `${T0.left}px`, top: `${T0.top}px`, width: `${T0.width}px`, height: `${T0.height}px`, borderRadius: '20px', backgroundColor: 'rgba(19, 19, 25, 0.82)' };
    const big = { left: `${F.left}px`, top: `${F.top}px`, width: `${F.width}px`, height: `${F.height}px`, borderRadius: '16px', backgroundColor: 'rgba(19, 19, 25, 0.94)' };
    const opts = { duration: 480, easing: EASE_DRAWER };
    // The thumbnail's box grows into the preview's box (same background and
    // corners), and the video grows inside it. Measure before anything moves.
    growMedia(T0, F, true, opts);
    flyVideo(T0, F, true, opts);
    toast.animate([small, big], opts);
    trow?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: EASE_OUT, fill: 'forwards' });
    for (const r of [$('.ed-row'), $('.ed-foot')]) {
      r.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 280, delay: 180, easing: EASE_OUT, fill: 'backwards' });
    }
    if (!raf) raf = requestAnimationFrame(loop);
  }

  /** A canvas holding the video's current frame, laid out like the thumbnail video. */
  function stillOf(v) {
    if (!v.videoWidth || v.readyState < 2) return null;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    try { c.getContext('2d').drawImage(v, 0, 0); } catch { return null; }
    c.className = 't-still';
    return c;
  }

  /** Clip the preview box down to the thumbnail's box (both relative to the moving card). */
  function growMedia(T0, F, forward, opts) {
    if (!from.box) return null;
    const m = $('.ed-media'), M = m.getBoundingClientRect();
    const rx = M.left - F.left, ry = M.top - F.top;
    const t = from.box.y - ry, l = from.box.x - rx;
    const r = M.width - (l + from.box.w), b = M.height - (t + from.box.h);
    const small = { clipPath: `inset(${t}px ${r}px ${b}px ${l}px round 13px)` };
    const big = { clipPath: 'inset(0px 0px 0px 0px round 10px)' };
    return m.animate(forward ? [small, big] : [big, small], { ...opts, fill: forward ? 'none' : 'forwards' });
  }

  /** The video flies between its thumbnail spot and the preview spot, inside the moving card. */
  function flyVideo(T0, F, forward, opts) {
    if (!fromMedia) return null;
    const Vf = video.getBoundingClientRect();
    const dx = (fromMedia.x - T0.left) - (Vf.left - F.left);
    const dy = (fromMedia.y - T0.top) - (Vf.top - F.top);
    const s = fromMedia.w / Vf.width;
    const a = { transform: `translate(${dx}px, ${dy}px) scale(${s})` }, b = { transform: 'translate(0px, 0px) scale(1)' };
    video.style.transformOrigin = '0 0';
    return video.animate(forward ? [a, b] : [b, a], { ...opts, fill: forward ? 'none' : 'forwards' });
  }

  function closeEditor(after) {
    if (!open) return;
    hideScrub();
    open = false;
    scrimTarget = 0;
    if (!adopted) video.pause();
    const toast = box, { T0, tmedia, trow } = from;
    const F = toast.getBoundingClientRect();
    const opts = { duration: 400, easing: EASE_DRAWER };
    for (const r of [$('.ed-row'), $('.ed-foot')]) r.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: EASE_OUT, fill: 'forwards' });
    trow?.getAnimations().forEach((a) => a.cancel());
    trow?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: 220, easing: EASE_OUT, fill: 'backwards' });
    // Keep handles: these hold their end state until we hand the video back,
    // then must be cancelled explicitly (a leftover transform would shrink
    // the thumbnail's video and make it unclickable).
    const closing = [growMedia(T0, F, false, opts), flyVideo(T0, F, false, opts)].filter(Boolean);
    const anim = toast.animate([
      { left: `${F.left}px`, top: `${F.top}px`, width: `${F.width}px`, height: `${F.height}px`, borderRadius: '16px', backgroundColor: 'rgba(19, 19, 25, 0.94)' },
      { left: `${T0.left}px`, top: `${T0.top}px`, width: `${T0.width}px`, height: `${T0.height}px`, borderRadius: '20px', backgroundColor: 'rgba(19, 19, 25, 0.82)' },
    ], { ...opts, fill: 'forwards' });
    anim.onfinish = () => {
      for (const a of closing) a.cancel();
      // Hand the same video back to the thumbnail, still playing.
      if (adopted) {
        const v = adopted;
        adopted = null;
        // Moving a <video> makes WebKit rebuild its picture, so for a frame or
        // two it shows nothing. Cover the hand-off with a still of the current
        // frame, and drop it once the moved video has drawn a real frame.
        const still = stillOf(v);
        if (tmedia) tmedia.style.display = '';
        $('.ed-media').replaceChild(placeholder, v);
        bindVideo(placeholder);
        restoreVideoStyle(v);
        v.getAnimations().forEach((a) => a.cancel());
        v.loop = true;
        v.muted = true;
        tmedia?.prepend(v);
        if (still && tmedia) {
          tmedia.insertBefore(still, v.nextSibling);
          let done = false;
          const drop = () => {
            if (done) return;
            done = true;
            still.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease' }).onfinish = () => still.remove();
          };
          // Two presented frames: the first can still be the empty rebuild.
          if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => v.requestVideoFrameCallback(drop));
          setTimeout(drop, 600);
        }
        v.play().catch(() => {});
      } else {
        video.getAnimations().forEach((a) => a.cancel());
        video.removeAttribute('src');
        video.load();
      }
      if (tmedia) tmedia.style.display = '';
      if (trow) for (const k of ['position', 'left', 'top', 'width']) trow.style[k] = '';
      el.getAnimations({ subtree: true }).forEach((a) => a.cancel());
      el.remove();
      toast.classList.remove('expanded');
      for (const k of ['left', 'top', 'width', 'height', 'right', 'bottom', 'transform']) toast.style[k] = '';
      anim.cancel();
      requestAnimationFrame(() => toast.classList.remove('dragging'));
      box = null;
      for (const b of bitmaps.values()) b.close?.();
      bitmaps.clear();
      after?.();
      onClose?.();
    };
  }

  function cancel() { closeEditor(() => onSave(null)); }

  // ---------- export

  /**
   * Copy or save the kept range. The host does the work with ffmpeg (trim,
   * or GIF with a per-clip palette), reporting progress as it goes.
   */
  async function run(action) {
    if (busy) return;
    const btn = $('.ed-go'), prog = $('.ed-prog'), label = $('.ed-go .pl');
    const idle = label.textContent;
    let callId = null, cancelled = false;
    busy = { cancel: () => { cancelled = true; if (callId) native.cancel(callId); } };
    btn.classList.add('busy');
    el.classList.add('busy');
    video.pause();
    const verb = V.fmt === 'gif' ? 'Making GIF' : 'Exporting';
    const progress = (p) => {
      prog.style.transform = `scaleX(${clamp(p, 0, 1).toFixed(3)})`;
      label.textContent = `${verb} ${Math.round(clamp(p, 0, 1) * 100)}%`;
    };
    try {
      const req = native.call('export', { path: V.path, a: V.a, b: V.b, dur: V.dur, fmt: V.fmt, action }, { onProgress: progress });
      callId = req.callId;
      const result = await req;
      if (cancelled) return;
      Object.assign(src, { a: V.a, b: V.b, fmt: V.fmt });
      closeEditor(() => onSave(result, action));
    } catch (err) {
      if (!cancelled) console.warn('Export failed', err);
    } finally {
      busy = null;
      btn.classList.remove('busy');
      el.classList.remove('busy');
      prog.style.transform = '';
      label.textContent = idle;
    }
  }

  addEventListener('resize', () => { if (open) layout(); });

  return {
    open: openEditor,
    keydown,
    get isOpen() { return open; },
    /** Scrim opacity for the scene, eased toward its target each frame. */
    scrim() {
      scrim += (scrimTarget - scrim) * 0.18;
      if (Math.abs(scrim - scrimTarget) < 0.002) scrim = scrimTarget;
      return scrim;
    },
  };
}
