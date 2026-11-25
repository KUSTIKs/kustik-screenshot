// Shared-element transitions inside one container (FLIP).
//
// Children marked `data-k="<key>"` keep their identity across states. When
// `change()` switches the container to a new state:
//   * a key present before and after MOVES from its old spot to its new one,
//     and if its width changed, its background (`.bg` child) stretches;
//   * a key that disappears leaves a ghost that fades out where it stood;
//   * a key that appears fades in.
// The container's own left/top/width glide at the same time, so the whole
// thing reads as one object changing shape rather than parts being swapped.

const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

const visible = (el) => el.getClientRects().length > 0;
// Nested keyed elements move relative to their keyed parent, not the root,
// so they don't get the parent's motion twice.
const frameKey = (el, root) => el.parentElement.closest('[data-k]') && root.contains(el.parentElement.closest('[data-k]')) ? el.parentElement.closest('[data-k]').dataset.k : null;

export function morph(root, change, { duration = 320, easing = EASE, reposition } = {}) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const R0 = root.getBoundingClientRect();
  const before = new Map();
  for (const el of root.querySelectorAll('[data-k]')) {
    if (visible(el)) before.set(el.dataset.k, { el, r: el.getBoundingClientRect(), parent: frameKey(el, root) });
  }
  const rectOf = (k, R) => (k && before.get(k) ? before.get(k).r : R);

  change();
  reposition?.();

  const R1 = root.getBoundingClientRect();
  if (reduce || !visible(root)) return;

  const opts = { duration, easing };
  if (Math.abs(R0.width - R1.width) > 0.5 || Math.abs(R0.left - R1.left) > 0.5 || Math.abs(R0.top - R1.top) > 0.5) {
    root.animate([
      { left: `${R0.left}px`, top: `${R0.top}px`, width: `${R0.width}px` },
      { left: `${R1.left}px`, top: `${R1.top}px`, width: `${R1.width}px` },
    ], opts);
  }

  const after = new Set();
  const nowRects = new Map();
  for (const el of root.querySelectorAll('[data-k]')) if (visible(el)) nowRects.set(el.dataset.k, el.getBoundingClientRect());
  for (const el of root.querySelectorAll('[data-k]')) {
    if (!visible(el)) continue;
    const k = el.dataset.k;
    after.add(k);
    const r1 = nowRects.get(k);
    const p = before.get(k);
    if (p) {
      // Positions are relative to the frame that is itself moving: the root,
      // or a keyed parent present in both states.
      const pk = frameKey(el, root);
      const shared = pk && pk === p.parent && before.has(pk) && nowRects.has(pk);
      const F0 = shared ? rectOf(pk, R0) : R0, F1 = shared ? nowRects.get(pk) : R1;
      const dx = (p.r.left - F0.left) - (r1.left - F1.left);
      const dy = (p.r.top - F0.top) - (r1.top - F1.top);
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], opts);
      }
      const bg = el.querySelector(':scope > .bg');
      if (bg && Math.abs(p.r.width - r1.width) > 0.5) {
        bg.animate([{ right: `${r1.width - p.r.width}px` }, { right: '0px' }], opts);
      }
    } else {
      el.animate(
        [{ opacity: 0, filter: 'blur(4px)', transform: 'scale(0.94)' }, { opacity: 1, filter: 'none', transform: 'none' }],
        { duration: duration * 0.75, delay: duration * 0.08, easing, fill: 'backwards' },
      );
    }
  }

  // Leaving elements: a ghost holds its old place (on screen, not in the
  // moving container) and fades out.
  for (const [k, p] of before) {
    if (after.has(k)) continue;
    const g = p.el.cloneNode(true);
    g.removeAttribute('data-k');
    g.setAttribute('aria-hidden', 'true');
    g.style.cssText += `;position:absolute;margin:0;pointer-events:none;display:${getComputedStyle(p.el).display};
      left:${p.r.left - R0.left}px;top:${p.r.top - R0.top}px;width:${p.r.width}px;height:${p.r.height}px;`;
    root.appendChild(g);
    g.animate([
      { opacity: 1, transform: 'translate(0px, 0px)' },
      { opacity: 0, filter: 'blur(4px)', transform: `translate(${R0.left - R1.left}px, ${R0.top - R1.top}px) scale(0.94)` },
    ], { duration: duration * 0.5, easing, fill: 'forwards' }).onfinish = () => g.remove();
  }
}
