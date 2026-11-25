// Pins: a capture floating above every window (part of the overlay). Drag to
// move, scroll to resize, double-click or × to close.

import { $, clamp } from './dom.js';
import { I } from './icons.js';

const layer = $('#pins');

export function addPin(c, r) {
  const el = document.createElement('div');
  el.className = 'pin';
  el.innerHTML = `<img alt="Pinned capture"><button class="pin-x" aria-label="Close pin">${I.close}</button>`;
  $('img', el).src = c.toDataURL('image/png');
  const st = { x: r.x, y: r.y, w: r.w, h: r.h, aspect: r.w / r.h, maxW: r.w * 3 };
  const place = () => Object.assign(el.style, { left: `${st.x}px`, top: `${st.y}px`, width: `${st.w}px`, height: `${st.h}px` });
  place();
  layer.appendChild(el);
  el.animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  const remove = () => {
    el.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.96)' }], { duration: 140, easing: 'ease', fill: 'forwards' }).onfinish = () => el.remove();
  };
  $('.pin-x', el).addEventListener('click', (e) => { e.stopPropagation(); remove(); });
  el.addEventListener('dblclick', remove);
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.pin-x')) return;
    layer.appendChild(el); // raise
    el.setPointerCapture(e.pointerId);
    el.classList.add('moving');
    const ox = e.clientX - st.x, oy = e.clientY - st.y;
    const move = (ev) => { st.x = ev.clientX - ox; st.y = ev.clientY - oy; place(); };
    const up = () => {
      el.classList.remove('moving');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k = Math.exp(-e.deltaY * 0.0015);
    const nw = clamp(st.w * k, 80, st.maxW), f = nw / st.w;
    st.x = e.clientX - (e.clientX - st.x) * f;
    st.y = e.clientY - (e.clientY - st.y) * f;
    st.w = nw; st.h = nw / st.aspect;
    place();
  }, { passive: false });
}
