// Minimal GIF decoder: turns an animated GIF into fully composited RGBA frames.
// Handles global/local palettes, transparency, interlacing and disposal methods.

export function decodeGif(buf) {
  const sig = buf.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error('not a GIF file');

  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const screenFlags = buf[10];
  let pos = 13;

  let globalPalette = null;
  if (screenFlags & 0x80) {
    const size = 3 * (1 << ((screenFlags & 7) + 1));
    globalPalette = buf.subarray(pos, pos + size);
    pos += size;
  }

  const canvas = new Uint8Array(width * height * 4);
  const frames = [];
  let gce = { disposal: 0, delay: 0, transparent: -1 };

  const readSubBlocks = () => {
    const chunks = [];
    while (pos < buf.length) {
      const len = buf[pos++];
      if (len === 0) break;
      chunks.push(buf.subarray(pos, pos + len));
      pos += len;
    }
    return Buffer.concat(chunks);
  };

  while (pos < buf.length) {
    const block = buf[pos++];

    if (block === 0x3b) break; // trailer

    if (block === 0x21) {
      const label = buf[pos++];
      if (label === 0xf9) {
        const data = readSubBlocks();
        gce = {
          disposal: (data[0] >> 2) & 7,
          delay: data.readUInt16LE(1) * 10,
          transparent: data[0] & 1 ? data[3] : -1,
        };
      } else {
        readSubBlocks();
      }
      continue;
    }

    if (block !== 0x2c) throw new Error(`unexpected GIF block 0x${block.toString(16)}`);

    const left = buf.readUInt16LE(pos);
    const top = buf.readUInt16LE(pos + 2);
    const w = buf.readUInt16LE(pos + 4);
    const h = buf.readUInt16LE(pos + 6);
    const flags = buf[pos + 8];
    pos += 9;

    let palette = globalPalette;
    if (flags & 0x80) {
      const size = 3 * (1 << ((flags & 7) + 1));
      palette = buf.subarray(pos, pos + size);
      pos += size;
    }
    if (!palette) throw new Error('GIF frame has no palette');

    const minCodeSize = buf[pos++];
    const indices = lzwDecode(minCodeSize, readSubBlocks(), w * h);
    const rowOrder = flags & 0x40 ? interlacedRows(h) : null;

    const saved = gce.disposal === 3 ? canvas.slice() : null;

    for (let row = 0; row < h; row++) {
      const y = top + (rowOrder ? rowOrder[row] : row);
      if (y >= height) continue;
      for (let col = 0; col < w; col++) {
        const x = left + col;
        if (x >= width) continue;
        const idx = indices[row * w + col];
        if (idx === gce.transparent) continue;
        const o = (y * width + x) * 4;
        canvas[o] = palette[idx * 3];
        canvas[o + 1] = palette[idx * 3 + 1];
        canvas[o + 2] = palette[idx * 3 + 2];
        canvas[o + 3] = 255;
      }
    }

    // Browsers treat tiny delays as 100ms; do the same so the tempo matches.
    frames.push({ pixels: canvas.slice(), delay: gce.delay < 20 ? 100 : gce.delay });

    if (gce.disposal === 2) {
      for (let y = top; y < Math.min(top + h, height); y++) {
        const start = (y * width + left) * 4;
        const end = (y * width + Math.min(left + w, width)) * 4;
        canvas.fill(0, start, end);
      }
    } else if (saved) {
      canvas.set(saved);
    }

    gce = { disposal: 0, delay: 0, transparent: -1 };
  }

  if (frames.length === 0) throw new Error('GIF has no frames');
  return { width, height, frames };
}

// Decoded row index -> actual row for the four interlace passes.
function interlacedRows(h) {
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < h; y += step) rows.push(y);
  }
  return rows;
}

function lzwDecode(minCodeSize, data, pixelCount) {
  const out = new Uint8Array(pixelCount);
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);

  let codeSize = minCodeSize + 1;
  let codeMask = (1 << codeSize) - 1;
  let nextCode = eoiCode + 1;
  let prev = -1;
  let first = 0;
  let datum = 0;
  let bits = 0;
  let op = 0;

  for (let i = 0; i < data.length && op < pixelCount; i++) {
    datum |= data[i] << bits;
    bits += 8;

    while (bits >= codeSize && op < pixelCount) {
      const code = datum & codeMask;
      datum >>>= codeSize;
      bits -= codeSize;

      if (code === clearCode) {
        codeSize = minCodeSize + 1;
        codeMask = (1 << codeSize) - 1;
        nextCode = eoiCode + 1;
        prev = -1;
        continue;
      }
      if (code === eoiCode) return out;

      if (prev === -1) {
        out[op++] = code;
        prev = first = code;
        continue;
      }
      if (code > nextCode) return out; // corrupt stream; keep what we have

      let sp = 0;
      let c = code;
      if (code === nextCode) {
        stack[sp++] = first;
        c = prev;
      }
      while (c > eoiCode) {
        stack[sp++] = suffix[c];
        c = prefix[c];
      }
      first = c;
      stack[sp++] = c;
      while (sp > 0 && op < pixelCount) out[op++] = stack[--sp];

      if (nextCode < 4096) {
        prefix[nextCode] = prev;
        suffix[nextCode] = first;
        nextCode++;
        if (nextCode === 1 << codeSize && codeSize < 12) {
          codeSize++;
          codeMask = (1 << codeSize) - 1;
        }
      }
      prev = code;
    }
  }
  return out;
}
