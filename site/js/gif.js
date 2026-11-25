// Small animated-GIF encoder: one median-cut palette for the whole clip,
// light ordered dithering, and frame differencing (pixels that didn't change
// become transparent, which keeps screen recordings small).

const TRANSPARENT = 255; // palette has 255 real colours + 1 transparent slot

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v / 16 - 0.5) * 10);

/** Median cut over sampled RGB pixels → up to `max` colours. */
function medianCut(samples, max) {
  let boxes = [samples];
  while (boxes.length < max) {
    // Split the box with the widest channel range (weighted by population).
    let bi = -1, bestScore = 0, bestCh = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      let lo = [255, 255, 255], hi = [0, 0, 0];
      for (const p of b) for (let c = 0; c < 3; c++) { if (p[c] < lo[c]) lo[c] = p[c]; if (p[c] > hi[c]) hi[c] = p[c]; }
      const r = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
      const ch = r[0] >= r[1] && r[0] >= r[2] ? 0 : r[1] >= r[2] ? 1 : 2;
      const score = r[ch] * Math.sqrt(b.length);
      if (score > bestScore) { bestScore = score; bi = i; bestCh = ch; }
    });
    if (bi < 0) break;
    const b = boxes[bi].sort((x, y) => x[bestCh] - y[bestCh]);
    const mid = b.length >> 1;
    boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }
  return boxes.map((b) => {
    const s = [0, 0, 0];
    for (const p of b) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
    return s.map((v) => Math.round(v / b.length));
  });
}

/** 15-bit RGB → nearest palette index lookup table. */
function buildLut(pal) {
  const lut = new Uint8Array(32768);
  for (let r = 0; r < 32; r++) for (let g = 0; g < 32; g++) for (let b = 0; b < 32; b++) {
    const R = (r << 3) | 4, G = (g << 3) | 4, B = (b << 3) | 4;
    let best = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i++) {
      const p = pal[i];
      const d = (p[0] - R) ** 2 * 2 + (p[1] - G) ** 2 * 4 + (p[2] - B) ** 2 * 3;
      if (d < bd) { bd = d; best = i; }
    }
    lut[(r << 10) | (g << 5) | b] = best;
  }
  return lut;
}

function lzw(indices, minCodeSize, out) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, next = eoi + 1;
  let dict = new Map();
  let acc = 0, bits = 0;
  const bytes = [];
  const write = (code) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) { bytes.push(acc & 255); acc >>>= 8; bits -= 8; }
  };
  const emit = (code) => {
    write(code);
    if (next > (1 << codeSize) - 1 && codeSize < 12) codeSize++;
  };
  write(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const v = dict.get(key);
    if (v !== undefined) { prefix = v; continue; }
    emit(prefix);
    if (next < 4096) dict.set(key, next++);
    else {
      write(clear);
      dict = new Map();
      next = eoi + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  emit(prefix);
  write(eoi);
  if (bits > 0) bytes.push(acc & 255);
  out.push(minCodeSize);
  for (let i = 0; i < bytes.length; i += 255) {
    const n = Math.min(255, bytes.length - i);
    out.push(n);
    for (let j = 0; j < n; j++) out.push(bytes[i + j]);
  }
  out.push(0);
}

/**
 * @param {{data: Uint8ClampedArray, delay: number}[]} frames  RGBA, delay in seconds
 * @param {number} w @param {number} h
 * @param {(p: number) => void} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function encodeGif(frames, w, h, onProgress) {
  // Palette from pixels sampled across the clip.
  const samples = [];
  const fstep = Math.max(1, Math.floor(frames.length / 24));
  const pstep = Math.max(1, Math.floor((w * h) / 4000));
  for (let f = 0; f < frames.length; f += fstep) {
    const d = frames[f].data;
    for (let i = 0; i < w * h; i += pstep) samples.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
  }
  const pal = medianCut(samples, 255);
  while (pal.length < 256) pal.push([0, 0, 0]);
  const lut = buildLut(pal.slice(0, 255));

  const out = [];
  const str = (s) => { for (const c of s) out.push(c.charCodeAt(0)); };
  const u16 = (v) => out.push(v & 255, (v >> 8) & 255);
  str('GIF89a');
  u16(w); u16(h);
  out.push(0xf7, 0, 0); // global colour table, 256 entries
  for (const p of pal) out.push(p[0], p[1], p[2]);
  out.push(0x21, 0xff, 0x0b); str('NETSCAPE2.0'); out.push(3, 1, 0, 0, 0); // loop forever

  const n = w * h;
  let prev = null;
  let carry = 0;
  for (let f = 0; f < frames.length; f++) {
    const d = frames[f].data;
    const idx = new Uint8Array(n);
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        const o = BAYER[((y & 3) << 2) | (x & 3)];
        const r = Math.max(0, Math.min(255, d[i * 4] + o)) >> 3;
        const g = Math.max(0, Math.min(255, d[i * 4 + 1] + o)) >> 3;
        const b = Math.max(0, Math.min(255, d[i * 4 + 2] + o)) >> 3;
        idx[i] = lut[(r << 10) | (g << 5) | b];
      }
    }
    let frameIdx = idx;
    if (prev) {
      frameIdx = new Uint8Array(n);
      for (let i = 0; i < n; i++) frameIdx[i] = idx[i] === prev[i] ? TRANSPARENT : idx[i];
    }
    prev = idx;
    // Delays are in centiseconds; carry the rounding error so timing stays true.
    const exact = frames[f].delay * 100 + carry;
    const cs = Math.max(2, Math.round(exact));
    carry = exact - cs;
    out.push(0x21, 0xf9, 0x04, (1 << 2) | 1); // disposal: keep, transparency on
    u16(cs);
    out.push(TRANSPARENT, 0);
    out.push(0x2c); u16(0); u16(0); u16(w); u16(h); out.push(0);
    lzw(frameIdx, 8, out);
    onProgress?.((f + 1) / frames.length);
    if (f % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  out.push(0x3b);
  return new Uint8Array(out);
}
