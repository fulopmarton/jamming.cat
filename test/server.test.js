import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createServer, parseOptions } from '../lib/server.js';

const CURL = 'curl/8.5.0';
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0';

let server;
let base;

before(async () => {
  server = createServer({ maxStreams: 2 });
  server.listen(0);
  await once(server, 'listening');
  base = `http://localhost:${server.address().port}`;
});

after(() => new Promise((resolve) => server.shutdown(resolve)));

function request(path, { userAgent = CURL, method = 'GET', collectMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers: { 'User-Agent': userAgent } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      const finish = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      res.on('end', finish);
      if (collectMs) {
        setTimeout(() => {
          req.destroy();
          finish();
        }, collectMs);
      }
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? null : reject(err)));
    req.end();
  });
}

test('parses combinable path options', () => {
  assert.deepEqual(parseOptions('/'), { mode: 'truecolor', size: 48, party: false });
  assert.deepEqual(parseOptions('/Party/256/BIG/'), { mode: '256', size: 64, party: true });
  assert.deepEqual(parseOptions('/ascii/small'), { mode: 'ascii', size: 32, party: false });
  assert.equal(parseOptions('/nope'), null);
});

test('streams animation frames to curl', async () => {
  const res = await request('/', { collectMs: 300 });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/plain/);
  const text = res.body.toString();
  assert.ok(text.startsWith('\x1b[2J\x1b[H'), 'clears the screen first');
  const frames = text.split('\x1b[H').length - 2;
  assert.ok(frames >= 5 && frames <= 12, `expected ~8 frames in 300ms, got ${frames}`);
});

test('stops streaming when the client disconnects', async () => {
  await request('/ascii', { collectMs: 100 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(server.streams.size, 0);
});

test('prints help for /help and unknown options', async () => {
  const help = await request('/help');
  assert.equal(help.status, 200);
  assert.match(help.body.toString(), /curl localhost:\d+\/party/);

  const unknown = await request('/disco');
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.toString(), /usage:/);
});

test('serves the landing page to browsers', async () => {
  const res = await request('/party', { userAgent: BROWSER });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.match(res.body.toString(), /curl localhost:\d+/);
  assert.doesNotMatch(res.body.toString(), /\{\{host\}\}/);
});

test('redirects browsers away from unknown paths', async () => {
  const res = await request('/wp-admin', { userAgent: BROWSER });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');
});

test('serves the gif', async () => {
  const res = await request('/catjam.gif', { userAgent: BROWSER });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/gif');
  assert.equal(res.body.subarray(0, 6).toString(), 'GIF89a');
});

test('answers HEAD without a body and rejects other methods', async () => {
  const head = await request('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);

  const post = await request('/', { method: 'POST' });
  assert.equal(post.status, 405);
});

test('turns clients away once the stream limit is reached', async () => {
  const held = [request('/ascii', { collectMs: 400 }), request('/ascii', { collectMs: 400 })];
  await new Promise((r) => setTimeout(r, 100));
  const rejected = await request('/ascii');
  assert.equal(rejected.status, 503);
  await Promise.all(held);
});
