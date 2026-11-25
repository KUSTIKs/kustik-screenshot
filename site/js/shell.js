// The page: one live screen under the hero, a switcher for its steps and a
// two-tone caption. Each step loads in a fresh stage, double-buffered (the
// next loads behind the current one, then fades in). It only plays while
// it's on screen.
import { STEPS } from './flows-data.js';

const $ = (q) => document.querySelector(q);
const screen = $('.screen'), viewport = $('.viewport'), steps = $('.steps'), ind = $('.ind');
const caption = $('.caption .pl');

const buttons = STEPS.map((x, i) => {
  const b = document.createElement('button');
  b.className = 'step';
  b.role = 'tab';
  b.textContent = x.label;
  b.onclick = () => go(i);
  steps.appendChild(b);
  return b;
});

let at = 0, current = null, token = 0, active = false;

function fit() { viewport.style.transform = `scale(${screen.clientWidth / 1120})`; }
addEventListener('resize', () => { fit(); place(true); });
fit();

/** Slide the highlight under the current step. */
function place(instant = false) {
  const b = buttons[at];
  if (instant) ind.style.transition = 'none';
  ind.style.width = `${b.offsetWidth}px`;
  ind.style.transform = `translateX(${b.offsetLeft}px)`;
  if (instant) { ind.offsetWidth; ind.style.transition = ''; }
}

function setCaption(x, instant) {
  const html = `<b>${x.lead}</b> ${x.text}`;
  if (instant || !caption.innerHTML) { caption.innerHTML = html; return; }
  caption.classList.add('swap');
  setTimeout(() => { caption.innerHTML = html; caption.classList.remove('swap'); }, 150);
}

function go(i, first = false) {
  at = (i + STEPS.length) % STEPS.length;
  buttons.forEach((b, k) => b.setAttribute('aria-selected', String(k === at)));
  place(first);
  setCaption(STEPS[at], first);
  if (!active) return;
  const my = ++token;
  const frame = document.createElement('iframe');
  frame.className = current ? 'next' : '';
  frame.title = 'Kustik Screenshot demo';
  frame.tabIndex = -1;
  frame.dataset.token = my;
  frame.src = `stage.html#${STEPS[at].key}`;
  viewport.appendChild(frame);
  current?.contentWindow?.postMessage({ stop: true }, '*');
}

addEventListener('message', (e) => {
  const m = e.data;
  if (!m?.stage) return;
  const frame = [...viewport.children].find((f) => f.contentWindow === e.source);
  if (!frame || +frame.dataset.token !== token) return;
  if (m.type === 'ready') {
    const old = current;
    current = frame;
    frame.classList.remove('next');
    for (const f of [...viewport.children]) if (f !== frame && f !== old) f.remove();
    if (old && old !== frame) setTimeout(() => old.remove(), 300);
    frame.contentWindow.postMessage({ play: true }, '*');
  } else if (m.type === 'done') {
    const my = token;
    setTimeout(() => { if (my === token && active) go(at + 1); }, 700);
  }
});

// Play only while the screen is in view.
new IntersectionObserver(([e]) => {
  const on = e.intersectionRatio > 0.3;
  if (on === active) return;
  active = on;
  if (on) go(at);
  else { token++; current?.contentWindow?.postMessage({ stop: true }, '*'); }
}, { threshold: [0, 0.3, 0.6] }).observe(screen);

go(0, true);
