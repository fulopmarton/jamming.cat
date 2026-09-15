import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeGif } from './gif.js';
import { createRenderer, CLEAR, RESET } from './render.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SIZES = { small: 32, medium: 48, big: 64 };
const MODES = new Set(['truecolor', '256', 'ascii']);

// Clients that can show a streaming response as it arrives. PowerShell's
// Invoke-WebRequest buffers forever, so it gets the web page instead.
const TERMINAL_UA = /\b(curl|wget|httpie|libfetch)\b/i;

const HELP = `
  jamming.cat - a jamming cat in your terminal

  usage:  curl HOST[/option/option...]

  color:  (default)  24-bit truecolor
          256        256 colors, for terminals without truecolor
          ascii      plain characters, works everywhere, lowest bandwidth
          party      rainbow cat, changes color on every head bob

  size:   small      32 columns x 16 rows
          medium     48 columns x 24 rows (default, fits 80x24)
          big        64 columns x 32 rows

  e.g.    curl HOST/party
          curl HOST/256/big
          curl HOST/ascii/small

  Windows PowerShell: use curl.exe instead of curl.
`;

export function createServer({
  gifPath = path.join(root, 'assets', 'catjam.gif'),
  maxStreams = 1000,
  maxStreamSeconds = 0, // 0 = jam forever
} = {}) {
  const gifBytes = fs.readFileSync(gifPath);
  const getFrames = createRenderer(decodeGif(gifBytes));
  const landingTemplate = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const streams = new Set();

  // Render the default variant up front so the first request doesn't stall.
  getFrames(parseOptions('/'));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const host = req.headers.host || 'jamming.cat';
    const isTerminal = TERMINAL_UA.test(req.headers['user-agent'] || '');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }

    if (url.pathname === '/catjam.gif') {
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': gifBytes.length,
        'Cache-Control': 'public, max-age=86400',
      });
      return res.end(req.method === 'HEAD' ? undefined : gifBytes);
    }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(`ok ${streams.size} jamming\n`);
    }

    const options = parseOptions(url.pathname);

    if (!isTerminal) {
      if (url.pathname === '/help' || options) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(req.method === 'HEAD' ? undefined : landingTemplate.replaceAll('{{host}}', escapeHtml(host)));
      }
      res.writeHead(302, { Location: '/' });
      return res.end();
    }

    if (url.pathname === '/help' || !options) {
      res.writeHead(url.pathname === '/help' ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(HELP.replaceAll('HOST', host));
    }

    if (streams.size >= maxStreams) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '30' });
      return res.end('Too many cats jamming right now. Try again in a bit.\n');
    }

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
    });
    if (req.method === 'HEAD') return res.end();

    jam(res, getFrames(options));
  });

  function jam(res, frames) {
    res.socket?.setNoDelay(true);
    streams.add(res);

    const deadline = maxStreamSeconds ? Date.now() + maxStreamSeconds * 1000 : Infinity;
    let index = 0;
    let timer = null;
    let due = Date.now();
    let stopped = false;

    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      streams.delete(res);
    };

    const tick = () => {
      if (stopped) return;
      const now = Date.now();
      if (now >= deadline) {
        stop();
        return res.end(`${RESET}\r\n\r\nThe cat needs a break. Run it again to keep jamming.\r\n`);
      }

      const frame = frames[index];
      index = (index + 1) % frames.length;
      // Schedule against absolute time so the tempo doesn't drift, but don't
      // burst through a backlog of frames after a stall.
      due = Math.max(due, now - 100) + frame.delay;

      if (res.write(frame.data)) {
        timer = setTimeout(tick, Math.max(0, due - Date.now()));
      } else {
        // Slow client: wait for the buffer to empty instead of piling up frames.
        res.once('drain', tick);
      }
    };

    res.on('close', stop);
    res.write(CLEAR);
    tick();
  }

  server.streams = streams;

  // Streams never finish on their own, so server.close() alone would wait
  // forever. This stops accepting connections and ends every open stream,
  // leaving each terminal with its colors reset.
  server.shutdown = (callback) => {
    server.close(callback);
    for (const res of streams) res.end(`${RESET}\r\n`);
  };

  return server;
}

export function parseOptions(pathname) {
  const options = { mode: 'truecolor', size: SIZES.medium, party: false };
  for (const segment of pathname.toLowerCase().split('/')) {
    if (segment === '') continue;
    if (segment in SIZES) options.size = SIZES[segment];
    else if (MODES.has(segment)) options.mode = segment;
    else if (segment === 'party') options.party = true;
    else return null;
  }
  return options;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
