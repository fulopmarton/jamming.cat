import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeGif } from '../lib/gif.js';
import { createRenderer, beatIndices, HOME, RESET, TRAILER } from '../lib/render.js';

const gif = decodeGif(fs.readFileSync(new URL('../assets/catjam.gif', import.meta.url)));
const getFrames = createRenderer(gif);

const visibleLines = (buf) =>
  buf.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\r\n');

for (const mode of ['truecolor', '256', 'ascii']) {
  for (const size of [32, 48, 64]) {
    test(`${mode} frames at size ${size} are ${size} columns x ${size / 2} rows`, () => {
      const frames = getFrames({ mode, size });
      assert.equal(frames.length, gif.frames.length);
      for (const { data, delay } of frames) {
        const text = data.toString();
        assert.ok(text.startsWith(HOME));
        assert.ok(text.endsWith(RESET + TRAILER));
        assert.ok(!/(?<!\r)\n/.test(text), 'every line feed has a carriage return');
        const lines = visibleLines(data);
        assert.equal(lines.length, size / 2 + 2, 'artwork rows plus two blank lines');
        assert.ok(lines.slice(-2).every((line) => line === ''), 'frame ends with blank lines');
        assert.ok(lines.every((line) => [...line].length <= size));
        assert.equal(delay, 40);
      }
    });
  }
}

test('color frames never carry a background color across a line break', () => {
  for (const mode of ['truecolor', '256']) {
    for (const { data } of getFrames({ mode, size: 48, party: true })) {
      for (const line of data.toString().split('\r\n').slice(0, -1)) {
        const lastBg = [...line.matchAll(/\x1b\[([0-9;]*)m/g)]
          .flatMap((m) => sgrBackgrounds(m[1]))
          .at(-1);
        assert.ok(lastBg === undefined || lastBg === 'default', `line ends with background ${lastBg}`);
      }
    }
  }
});

test('frames are cached per variant', () => {
  assert.equal(getFrames({ mode: '256', size: 32 }), getFrames({ mode: '256', size: 32 }));
  assert.notEqual(getFrames({ mode: '256', size: 32 }), getFrames({ mode: '256', size: 32, party: true }));
});

test('finds one beat per head bob in catjam', () => {
  const beats = beatIndices(gif);
  const total = beats.at(-1);
  // ~12.5 frames per bob at 25fps is 120 BPM.
  assert.ok(total >= 11 && total <= 14, `expected ~13 beats, got ${total}`);
  for (let i = 1; i < beats.length; i++) assert.ok(beats[i] - beats[i - 1] <= 1);
});

function sgrBackgrounds(params) {
  const p = params.split(';').map(Number);
  const out = [];
  for (let i = 0; i < p.length; i++) {
    if (p[i] === 0 || p[i] === 49) out.push('default');
    else if (p[i] === 48) {
      out.push(p.slice(i, i + (p[i + 1] === 2 ? 5 : 3)).join(';'));
      i += p[i + 1] === 2 ? 4 : 2;
    } else if (p[i] === 38) i += p[i + 1] === 2 ? 4 : 2;
  }
  return out;
}
