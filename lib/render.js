// Turns decoded GIF frames into ANSI terminal frames.
//
// Color modes draw two pixels per cell with half-block characters (fg = top
// pixel, bg = bottom pixel), so a W px wide frame is W columns x W/2 rows.
// ASCII mode draws one character per 1x2 px block, which gives the same
// footprint and works in any terminal.

const ESC = '\x1b[';
// Explicit CR so lines don't staircase when the tty isn't translating \n.
const NEWLINE = '\r\n';
const DEFAULT = -1;
const ASCII_RAMP = '.:-=+*#%@';

// Rainbow used by party mode, one color per head bob.
const PARTY_RGB = [
  [255, 64, 64], [255, 160, 32], [255, 230, 40], [60, 220, 90],
  [40, 200, 255], [80, 110, 255], [200, 80, 255], [255, 80, 190],
];
const PARTY_ANSI = [91, 93, 92, 96, 94, 95]; // bright red, yellow, green, cyan, blue, magenta

export const HOME = `${ESC}H`;
export const CLEAR = `${ESC}2J${ESC}H`;
export const RESET = `${ESC}0m`;

export function createRenderer(gif) {
  const beats = beatIndices(gif);
  const cache = new Map();

  return function getFrames({ mode = 'truecolor', size = 48, party = false } = {}) {
    if (mode === 'ascii') party = true; // always rainbow, so share one cache entry
    const key = `${mode}:${size}:${party}`;
    if (!cache.has(key)) cache.set(key, renderAll(gif, beats, { mode, size, party }));
    return cache.get(key);
  };
}

function renderAll(gif, beats, { mode, size, party }) {
  // Terminal cells are about twice as tall as wide, so `size` columns of
  // square pixels take half as many rows.
  const width = size;
  const rows = Math.max(1, Math.round((size * gif.height) / gif.width / 2));
  const height = mode === 'ascii' ? rows : rows * 2;
  const scaled = gif.frames.map((f) => resize(f.pixels, gif.width, gif.height, width, height));
  const rampLut = mode === 'ascii' ? asciiRampLut(scaled) : null;

  return scaled.map((pixels, i) => {
    let body;
    if (mode === 'ascii') {
      // ASCII is always rainbow, parrot.live style.
      const color = PARTY_ANSI[beats[i] % PARTY_ANSI.length];
      body = `${ESC}${color}m${asciiFrame(pixels, width, height, rampLut)}`;
    } else {
      if (party) tint(pixels, PARTY_RGB[beats[i] % PARTY_RGB.length]);
      body = halfBlockFrame(pixels, width, height, mode === '256' ? xterm256 : trueColor);
    }
    return { data: Buffer.from(HOME + body + RESET), delay: gif.frames[i].delay };
  });
}

// Box-filter resize with supersampling; alpha-weighted so transparent pixels
// don't bleed dark fringes into the edges.
export function resize(src, sw, sh, tw, th) {
  const out = new Uint8Array(tw * th * 4);
  const n = 4;
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < n; sy++) {
        const py = Math.min(sh - 1, Math.floor(((ty + (sy + 0.5) / n) * sh) / th));
        for (let sx = 0; sx < n; sx++) {
          const px = Math.min(sw - 1, Math.floor(((tx + (sx + 0.5) / n) * sw) / tw));
          const o = (py * sw + px) * 4;
          const alpha = src[o + 3];
          r += src[o] * alpha;
          g += src[o + 1] * alpha;
          b += src[o + 2] * alpha;
          a += alpha;
        }
      }
      const o = (ty * tw + tx) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / (n * n));
    }
  }
  return out;
}

function halfBlockFrame(px, width, height, colorOf) {
  const at = (x, y) => {
    if (y >= height) return DEFAULT;
    const o = (y * width + x) * 4;
    return px[o + 3] < 128 ? DEFAULT : colorOf.key(px[o], px[o + 1], px[o + 2]);
  };

  let out = '';
  let fg = DEFAULT;
  let bg = DEFAULT;

  // Emit only the SGR parameters that actually change.
  const set = (nextFg, nextBg) => {
    const params = [];
    if (nextFg !== null && nextFg !== fg) params.push(colorOf.sgr(nextFg, false));
    if (nextBg !== bg) params.push(colorOf.sgr(nextBg, true));
    if (params.length) out += `${ESC}${params.join(';')}m`;
    if (nextFg !== null) fg = nextFg;
    bg = nextBg;
  };

  for (let y = 0; y < height; y += 2) {
    if (y > 0) out += NEWLINE;
    for (let x = 0; x < width; x++) {
      const top = at(x, y);
      const bottom = at(x, y + 1);
      if (top === DEFAULT && bottom === DEFAULT) {
        set(null, DEFAULT);
        out += ' ';
      } else if (top === bottom) {
        set(null, top);
        out += ' ';
      } else if (top === DEFAULT) {
        set(bottom, DEFAULT);
        out += '▄';
      } else if (bottom === DEFAULT) {
        set(top, DEFAULT);
        out += '▀';
      } else if (fg === bottom || bg === top) {
        set(bottom, top);
        out += '▄';
      } else {
        set(top, bottom);
        out += '▀';
      }
    }
    // Never leave a background color active across a line break.
    if (bg !== DEFAULT) set(null, DEFAULT);
  }
  return out;
}

function asciiFrame(px, width, height, rampLut) {
  const lines = [];
  for (let y = 0; y < height; y++) {
    let line = '';
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      line += px[o + 3] < 128 ? ' ' : rampLut[Math.round(luminance(px, o))];
    }
    lines.push(line.trimEnd());
  }
  return lines.join(`${ESC}K${NEWLINE}`) + `${ESC}K`;
}

const trueColor = {
  // 5 bits per channel looks identical at terminal scale but makes runs of
  // equal colors (and therefore skipped escape codes) far more common, which
  // cuts bandwidth by about a quarter.
  key: (r, g, b) => (q5(r) << 16) | (q5(g) << 8) | q5(b),
  sgr: (key, isBg) =>
    key === DEFAULT
      ? (isBg ? '49' : '39')
      : `${isBg ? 48 : 38};2;${(key >> 16) & 255};${(key >> 8) & 255};${key & 255}`,
};

const q5 = (v) => Math.min(255, (v & 0xf8) + 4);

// xterm's 256-color palette minus the 16 user-configurable system colors.
const XTERM_PALETTE = (() => {
  const cube = [0, 95, 135, 175, 215, 255];
  const colors = [];
  for (let i = 0; i < 216; i++) colors.push([cube[Math.floor(i / 36)], cube[Math.floor(i / 6) % 6], cube[i % 6]]);
  for (let i = 0; i < 24; i++) colors.push([8 + i * 10, 8 + i * 10, 8 + i * 10]);
  return colors;
})();

let xtermLut = null;

// Nearest palette entry by "redmean" distance, a cheap perceptual metric that
// keeps skin tones from drifting green. Cached per 15-bit color.
function nearestXterm(r, g, b) {
  xtermLut ??= new Int16Array(32768).fill(-1);
  const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  if (xtermLut[k] >= 0) return xtermLut[k];

  const [cr, cg, cb] = [(r >> 3) * 8 + 4, (g >> 3) * 8 + 4, (b >> 3) * 8 + 4];
  let best = 0;
  let bestDist = Infinity;
  XTERM_PALETTE.forEach(([pr, pg, pb], i) => {
    const rm = (cr + pr) / 2;
    const dist = (2 + rm / 256) * (cr - pr) ** 2 + 4 * (cg - pg) ** 2 + (2 + (255 - rm) / 256) * (cb - pb) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return (xtermLut[k] = 16 + best);
}

const xterm256 = {
  key: nearestXterm,
  sgr: (key, isBg) => (key === DEFAULT ? (isBg ? '49' : '39') : `${isBg ? 48 : 38};5;${key}`),
};

function luminance(px, o) {
  return 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
}

// Luminance -> ASCII character, histogram-equalized over the whole animation.
// The cat is mostly light fur, so a linear mapping turns it into a wall of the
// same character; equalizing spreads the ramp across the shading that's there.
function asciiRampLut(frames) {
  const histogram = new Float64Array(256);
  let total = 0;
  for (const px of frames) {
    for (let o = 0; o < px.length; o += 4) {
      if (px[o + 3] < 128) continue;
      histogram[Math.round(luminance(px, o))]++;
      total++;
    }
  }
  const lut = [];
  let below = 0;
  for (let l = 0; l < 256; l++) {
    const rank = total ? below / total : l / 256;
    lut.push(ASCII_RAMP[Math.min(ASCII_RAMP.length - 1, Math.floor(rank * ASCII_RAMP.length))]);
    below += histogram[l];
  }
  return lut;
}

function tint(px, [tr, tg, tb]) {
  for (let o = 0; o < px.length; o += 4) {
    const l = 0.25 + (0.75 * luminance(px, o)) / 255;
    px[o] = Math.round((px[o] * 0.3 + tr * l * 0.7));
    px[o + 1] = Math.round((px[o + 1] * 0.3 + tg * l * 0.7));
    px[o + 2] = Math.round((px[o + 2] * 0.3 + tb * l * 0.7));
  }
}

// Finds head bobs: frames where the image's "ink" drops lowest (a local
// maximum of the darkness-weighted vertical centroid). Returns, for every
// frame, how many bobs have happened so far, so colors can change on the beat.
export function beatIndices(gif) {
  const { width, height, frames } = gif;
  const centroid = frames.map(({ pixels }) => {
    let sum = 0;
    let weight = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (pixels[o + 3] < 128) continue;
        const ink = 255 - luminance(pixels, o);
        sum += y * ink;
        weight += ink;
      }
    }
    return weight ? sum / weight : 0;
  });

  const window = 5;
  const count = frames.length;
  const isPeak = centroid.map((v, i) => {
    if (count < window * 2 + 1) return false;
    for (let d = -window; d <= window; d++) {
      if (d === 0) continue;
      const other = centroid[(i + d + count) % count];
      if (other > v || (d < 0 && other === v)) return false;
    }
    return true;
  });

  // Fall back to a steady ~120 BPM if nothing bob-like was found.
  const peaks = isPeak.filter(Boolean).length;
  let beat = 0;
  let elapsed = 0;
  return frames.map((f, i) => {
    if (peaks >= 2) {
      if (isPeak[i]) beat++;
    } else {
      beat = Math.floor(elapsed / 500);
    }
    elapsed += f.delay;
    return beat;
  });
}
