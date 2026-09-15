import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeGif } from '../lib/gif.js';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

// Reference frames were produced with `convert <gif> -coalesce rgba:<out>`.
function assertMatchesReference(name) {
  const gif = decodeGif(fs.readFileSync(fixture(`${name}.gif`)));
  const reference = fs.readFileSync(fixture(`${name}.rgba`));
  const frameBytes = gif.width * gif.height * 4;

  assert.equal(gif.frames.length, reference.length / frameBytes);
  gif.frames.forEach(({ pixels }, i) => {
    const expected = reference.subarray(i * frameBytes, (i + 1) * frameBytes);
    for (let o = 0; o < frameBytes; o += 4) {
      const where = `frame ${i}, pixel ${o / 4}`;
      assert.equal(pixels[o + 3] > 0, expected[o + 3] > 0, `alpha at ${where}`);
      if (expected[o + 3] > 0) {
        assert.deepEqual([...pixels.subarray(o, o + 3)], [...expected.subarray(o, o + 3)], `color at ${where}`);
      }
    }
  });
  return gif;
}

test('decodes interlaced images', () => {
  const buf = fs.readFileSync(fixture('interlaced.gif'));
  const descriptor = buf.indexOf(0x2c, 13);
  assert.ok(buf[descriptor + 9] & 0x40, 'fixture should be interlaced');
  assertMatchesReference('interlaced');
});

test('applies disposal methods and transparency like ImageMagick', () => {
  const gif = assertMatchesReference('disposal');
  assert.equal(gif.frames.length, 5);
  assert.deepEqual(gif.frames.map((f) => f.delay), [50, 50, 50, 50, 50]);
});

test('treats near-zero delays as 100ms, like browsers', () => {
  const gif = decodeGif(fs.readFileSync(fixture('interlaced.gif')));
  assert.equal(gif.frames[0].delay, 100);
});

test('decodes the catjam gif', () => {
  const gif = decodeGif(fs.readFileSync(new URL('../assets/catjam.gif', import.meta.url)));
  assert.equal(gif.width, 64);
  assert.equal(gif.height, 64);
  assert.equal(gif.frames.length, 158);
  assert.ok(gif.frames.every((f) => f.delay === 40));
});

test('rejects files that are not GIFs', () => {
  assert.throws(() => decodeGif(Buffer.from('\x89PNG\r\n\x1a\n0000000')), /not a GIF/);
});
