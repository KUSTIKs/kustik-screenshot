// A scripted mouse that drives the real UI with real events: it glides with a
// human ease, sends pointermove along the way (hover, drags), and honours
// pointer capture, so drags keep going to whatever grabbed them.

let captured = null;
// Synthetic pointers can't be captured by the browser; emulate it.
Element.prototype.setPointerCapture = function () { captured = this; };
Element.prototype.releasePointerCapture = function () { if (captured === this) captured = null; };
Element.prototype.hasPointerCapture = function () { return captured === this; };

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class Cursor {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.className = 'demo-cursor';
    this.el.innerHTML = `<svg viewBox="0 0 20 24" width="27" height="32"><path d="M1 1v17.2l4.4-4.2 3 6.6 3-1.3-2.9-6.4h6.2z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><span class="ring"></span>`;
    root.appendChild(this.el);
    this.x = 760; this.y = 520;
    this.visible = false;
    this.down = false;
    this.hover = null;
    this.place();
  }

  place() {
    this.el.style.transform = `translate(${this.x}px, ${this.y}px)`;
    this.el.classList.toggle('show', this.visible);
    this.el.classList.toggle('down', this.down);
  }
  show(v = true) { this.visible = v; this.place(); }
  jump(x, y) { this.x = x; this.y = y; this.place(); this.dispatchMove(); }

  /** Centre of an element (optionally offset). */
  at(sel, dx = 0, dy = 0) {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) throw new Error(`cursor: no ${sel}`);
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2 + dx, r.top + r.height / 2 + dy];
  }

  /** Glide to (x, y); duration from distance unless given. */
  move(x, y, dur, s) {
    const x0 = this.x, y0 = this.y;
    const dist = Math.hypot(x - x0, y - y0);
    dur ??= Math.min(900, 260 + dist * 0.55);
    this.show(true);
    return new Promise((res, rej) => {
      const t0 = performance.now();
      const step = (now) => {
        if (s && !s.alive()) return rej(new Error('cancelled'));
        const k = Math.min(1, (now - t0) / dur), e = easeInOut(k);
        // A slight arc, like a wrist.
        const arc = Math.sin(Math.PI * k) * Math.min(40, dist * 0.06);
        this.x = x0 + (x - x0) * e;
        this.y = y0 + (y - y0) * e - arc;
        this.place();
        this.dispatchMove();
        if (k < 1) requestAnimationFrame(step); else res();
      };
      requestAnimationFrame(step);
    });
  }
  moveTo(sel, opts = {}, s) {
    const [x, y] = this.at(sel, opts.dx, opts.dy);
    return this.move(x, y, opts.dur, s);
  }

  target() {
    return document.elementFromPoint(this.x, this.y) || document.body;
  }

  fire(type, target, extra = {}) {
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    target.dispatchEvent(new Ctor(type, {
      bubbles: !['pointerenter', 'pointerleave', 'mouseenter', 'mouseleave'].includes(type),
      cancelable: true, composed: true, clientX: this.x, clientY: this.y, screenX: this.x, screenY: this.y,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: this.down ? 1 : 0, ...extra,
    }));
  }

  dispatchMove() {
    const t = this.target();
    if (t !== this.hover) {
      if (this.hover) { this.fire('pointerout', this.hover); this.fire('pointerleave', this.hover); this.fire('mouseout', this.hover, { relatedTarget: t }); }
      this.fire('pointerover', t); this.fire('pointerenter', t);
      this.hover = t;
    }
    this.fire('pointermove', captured || t);
  }

  press() {
    this.down = true; this.place();
    this.pressTarget = this.target();
    this.fire('pointerdown', this.pressTarget);
    this.fire('mousedown', this.pressTarget);
  }
  release() {
    const t = captured || this.target();
    this.down = false; this.place();
    this.fire('pointerup', t);
    this.fire('mouseup', t);
    const over = this.target();
    if (this.pressTarget && (this.pressTarget === over || this.pressTarget.contains(over) || over.contains(this.pressTarget))) this.fire('click', over);
    captured = null;
    this.pressTarget = null;
  }

  async click(sel, s, opts = {}) {
    if (sel) await this.moveTo(sel, opts, s);
    await wait(s, opts.settle ?? 120);
    this.press();
    await wait(s, 90);
    this.release();
  }

  /** Press here, glide to (x, y) holding the button, release. */
  async drag(x, y, dur, s) {
    this.press();
    await wait(s, 60);
    await this.move(x, y, dur, s);
    await wait(s, 80);
    this.release();
  }
}

function wait(s, ms) { return s ? s.wait(ms) : new Promise((r) => setTimeout(r, ms)); }

/** Keyboard: real keydown/keyup on the focused element (bubbles to document). */
export function key(k, mods = {}) {
  const target = document.activeElement || document.body;
  const init = { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, bubbles: true, cancelable: true, ...mods };
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
}
