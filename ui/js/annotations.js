// Annotation model + painting. Every annotation is a plain object in screen
// (CSS px) coordinates, so the same objects draw on the overlay and into the
// exported image.

const SANS = '"Geist", ui-sans-serif, system-ui, sans-serif';

export const COLORS = ['#FF453A', '#FFD60A', '#32D74B', '#0A84FF', '#FFFFFF'];
export const WIDTHS = [2, 4, 7];
export const TEXT_SIZES = [16, 22, 32];
export const NUM_RADII = [11, 14, 18];

const tmp = document.createElement('canvas');
const tctx = tmp.getContext('2d');

export function norm(a) {
  const x = Math.min(a.x, a.x + a.w), y = Math.min(a.y, a.y + a.h);
  return { x, y, w: Math.abs(a.w), h: Math.abs(a.h) };
}

function shadow(c, blur = 6) {
  c.shadowColor = 'rgba(0,0,0,.38)';
  c.shadowBlur = blur;
  c.shadowOffsetY = 1.5;
}

function smoothPath(c, pts) {
  c.beginPath();
  c.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) { c.lineTo(pts[0].x + 0.01, pts[0].y); return; }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  const l = pts[pts.length - 1];
  c.lineTo(l.x, l.y);
}

export function textLines(a) { return a.text.split('\n'); }

export function measureText(a) {
  tctx.font = `600 ${a.fs}px ${SANS}`;
  const lines = textLines(a);
  const w = Math.max(...lines.map((l) => tctx.measureText(l).width), 4);
  return { w, h: lines.length * a.fs * 1.2 };
}

/** @param env {{raw: HTMLCanvasElement, dpr: number}} */
export function draw(c, a, env) {
  c.save();
  switch (a.type) {
    case 'arrow': {
      const dx = a.x2 - a.x1, dy = a.y2 - a.y1, len = Math.hypot(dx, dy);
      if (len < 1) break;
      const s = a.size;
      const head = Math.min(len * 0.62, 11 + s * 3.2);
      const hw = head * 0.6;
      const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
      const bx = a.x2 - ux * head, by = a.y2 - uy * head;
      const neckX = bx + ux * head * 0.16, neckY = by + uy * head * 0.16;
      const t0 = Math.max(0.8, s * 0.3), t1 = s * 0.62;
      c.beginPath();
      c.moveTo(a.x1 + nx * t0, a.y1 + ny * t0);
      c.lineTo(neckX + nx * t1, neckY + ny * t1);
      c.lineTo(bx + nx * hw, by + ny * hw);
      c.lineTo(a.x2, a.y2);
      c.lineTo(bx - nx * hw, by - ny * hw);
      c.lineTo(neckX - nx * t1, neckY - ny * t1);
      c.lineTo(a.x1 - nx * t0, a.y1 - ny * t0);
      c.closePath();
      shadow(c);
      c.fillStyle = a.color;
      c.fill();
      c.shadowColor = 'transparent';
      c.lineJoin = 'round';
      c.lineWidth = 1.5;
      c.strokeStyle = a.color;
      c.stroke();
      break;
    }
    case 'rect': {
      const r = norm(a);
      shadow(c);
      c.lineWidth = a.size;
      c.strokeStyle = a.color;
      c.lineJoin = 'round';
      c.beginPath();
      c.roundRect(r.x, r.y, r.w, r.h, Math.min(6, r.w / 2, r.h / 2));
      c.stroke();
      break;
    }
    case 'pen': {
      shadow(c, 4);
      c.lineWidth = a.size;
      c.strokeStyle = a.color;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      smoothPath(c, a.pts);
      c.stroke();
      break;
    }
    case 'hl': {
      c.globalAlpha = 0.4;
      c.lineWidth = a.size * 3 + 10;
      c.strokeStyle = a.color;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      smoothPath(c, a.pts);
      c.stroke();
      break;
    }
    case 'text': {
      c.font = `600 ${a.fs}px ${SANS}`;
      c.textBaseline = 'top';
      // A contrasting outline keeps text legible on any backdrop.
      const light = a.color === '#FFFFFF' || a.color === '#FFD60A';
      c.lineJoin = 'round';
      c.lineWidth = Math.max(3, a.fs * 0.2);
      c.strokeStyle = light ? 'rgba(12,12,16,.82)' : 'rgba(255,255,255,.95)';
      shadow(c, 6);
      textLines(a).forEach((l, i) => c.strokeText(l, a.x, a.y + a.fs * 0.1 + i * a.fs * 1.2));
      c.shadowColor = 'transparent';
      c.fillStyle = a.color;
      textLines(a).forEach((l, i) => c.fillText(l, a.x, a.y + a.fs * 0.1 + i * a.fs * 1.2));
      break;
    }
    case 'blur': {
      const r = norm(a);
      if (r.w < 1 || r.h < 1) break;
      const d = env.dpr, block = 9;
      const tw = Math.max(1, Math.ceil(r.w / block)), th = Math.max(1, Math.ceil(r.h / block));
      tmp.width = tw; tmp.height = th;
      tctx.imageSmoothingEnabled = true;
      tctx.drawImage(env.raw, r.x * d, r.y * d, r.w * d, r.h * d, 0, 0, tw, th);
      c.imageSmoothingEnabled = false;
      c.beginPath();
      c.roundRect(r.x, r.y, r.w, r.h, 4);
      c.clip();
      c.drawImage(tmp, 0, 0, tw, th, r.x, r.y, tw * block, th * block);
      break;
    }
    case 'num': {
      shadow(c, 8);
      c.fillStyle = a.color;
      c.beginPath();
      c.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      c.fill();
      c.shadowColor = 'transparent';
      c.lineWidth = 2;
      c.strokeStyle = 'rgba(255,255,255,.95)';
      c.stroke();
      const light = a.color === '#FFFFFF' || a.color === '#FFD60A';
      c.fillStyle = light ? '#111114' : '#fff';
      c.font = `700 ${Math.round(a.r * 1.15)}px ${SANS}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(String(a.n), a.x, a.y + 0.5);
      break;
    }
  }
  c.restore();
}

export function bbox(a) {
  switch (a.type) {
    case 'arrow': {
      const p = a.size * 2 + 8;
      return { x: Math.min(a.x1, a.x2) - p, y: Math.min(a.y1, a.y2) - p, w: Math.abs(a.x2 - a.x1) + p * 2, h: Math.abs(a.y2 - a.y1) + p * 2 };
    }
    case 'pen':
    case 'hl': {
      const xs = a.pts.map((p) => p.x), ys = a.pts.map((p) => p.y);
      const p = (a.type === 'hl' ? a.size * 1.5 + 5 : a.size / 2) + 4;
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x: x - p, y: y - p, w: Math.max(...xs) - x + p * 2, h: Math.max(...ys) - y + p * 2 };
    }
    case 'text': {
      const m = measureText(a);
      return { x: a.x - 4, y: a.y - 4, w: m.w + 8, h: m.h + 8 };
    }
    case 'num':
      return { x: a.x - a.r - 4, y: a.y - a.r - 4, w: a.r * 2 + 8, h: a.r * 2 + 8 };
    default: {
      const r = norm(a), p = (a.size || 0) / 2 + 4;
      return { x: r.x - p, y: r.y - p, w: r.w + p * 2, h: r.h + p * 2 };
    }
  }
}

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function hit(a, p) {
  if (a.type === 'arrow') return segDist(p, { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }) < a.size + 7;
  if (a.type === 'pen' || a.type === 'hl') {
    const tol = (a.type === 'hl' ? a.size * 1.5 + 5 : a.size / 2) + 6;
    for (let i = 0; i < a.pts.length - 1; i++) if (segDist(p, a.pts[i], a.pts[i + 1]) < tol) return true;
    return a.pts.length === 1 && Math.hypot(p.x - a.pts[0].x, p.y - a.pts[0].y) < tol;
  }
  if (a.type === 'rect') {
    const r = norm(a), t = a.size / 2 + 6;
    const inOuter = p.x > r.x - t && p.x < r.x + r.w + t && p.y > r.y - t && p.y < r.y + r.h + t;
    const inInner = p.x > r.x + t && p.x < r.x + r.w - t && p.y > r.y + t && p.y < r.y + r.h - t;
    return inOuter && !inInner;
  }
  const b = bbox(a);
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

export function moved(a, dx, dy) {
  switch (a.type) {
    case 'arrow': return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
    case 'pen':
    case 'hl': return { ...a, pts: a.pts.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    default: return { ...a, x: a.x + dx, y: a.y + dy };
  }
}
