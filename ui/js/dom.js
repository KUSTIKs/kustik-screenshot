// Small DOM helpers shared by the UI's modules.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const pad2 = (n) => String(n).padStart(2, '0');

/** Floating surfaces fade in and out through their `.show` class. */
export function show(el, instant = false) {
  el.classList.toggle('instant', instant);
  el.classList.add('show');
}
export function hide(el, instant = false) {
  el.classList.toggle('instant', instant);
  el.classList.remove('show');
}
export const isShown = (el) => el.classList.contains('show');
