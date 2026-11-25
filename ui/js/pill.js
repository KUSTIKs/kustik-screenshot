// A segmented-control indicator that moves like a drop of liquid.
//
// Its two edges ride separate springs. The leading edge (the side it's moving
// toward) is stiff, the trailing edge is soft, so the pill stretches out in
// the direction of travel, thins a little as it stretches (volume is
// conserved), overshoots a touch, and snaps back into shape when it lands.
// It moves when a segment is picked; it is not draggable.

const LEAD = { k: 820, c: 44 };   // ζ ≈ 0.77
const TRAIL = { k: 300, c: 27 };  // ζ ≈ 0.78, slower → the stretch

export function liquidPill(seg, ind, { attr = 'kind', inset = 2 } = {}) {
  const btns = [...seg.querySelectorAll(`[data-${attr}]`)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const L = { x: 0, v: 0, t: 0 }, R = { x: 0, v: 0, t: 0 };
  let raf = 0, last = 0;

  const segW = () => btns[0].offsetWidth;
  const bounds = (i) => [btns[i].offsetLeft, btns[i].offsetLeft + btns[i].offsetWidth];

  function render() {
    const w = Math.max(8, R.x - L.x);
    const stretch = Math.max(0, w / segW() - 1);
    const sy = 1 - Math.min(0.2, stretch * 0.42);
    ind.style.width = `${w}px`;
    ind.style.transform = `translateX(${L.x - inset}px) scaleY(${sy.toFixed(4)})`;
  }

  function step(dt) {
    const dir = Math.sign((L.t + R.t) / 2 - (L.x + R.x) / 2);
    const lead = dir >= 0 ? R : L, trail = dir >= 0 ? L : R;
    for (const [e, s] of [[lead, LEAD], [trail, TRAIL]]) {
      const f = -s.k * (e.x - e.t) - s.c * e.v;
      e.v += f * dt;
      e.x += e.v * dt;
    }
    if (R.x - L.x < 8) { const m = (L.x + R.x) / 2; L.x = m - 4; R.x = m + 4; }
  }

  function tick(t) {
    const dt = Math.min(1 / 30, (t - last) / 1000);
    last = t;
    for (let i = 0; i < 4; i++) step(dt / 4);
    render();
    const settled = [L, R].every((e) => Math.abs(e.x - e.t) < 0.15 && Math.abs(e.v) < 4);
    if (settled) {
      L.x = L.t; R.x = R.t; L.v = R.v = 0;
      render();
      raf = 0;
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function go(i, instant = false) {
    [L.t, R.t] = bounds(i);
    if (instant || reduce.matches) {
      L.x = L.t; R.x = R.t; L.v = R.v = 0;
      cancelAnimationFrame(raf);
      raf = 0;
      render();
      return;
    }
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }

  return { go };
}
