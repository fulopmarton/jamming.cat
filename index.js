import { createServer } from './lib/server.js';

const port = Number(process.env.PORT) || 3000;

const server = createServer({
  gifPath: process.env.GIF_PATH || undefined,
  maxStreams: Number(process.env.MAX_STREAMS) || undefined,
  maxStreamSeconds: Number(process.env.MAX_STREAM_SECONDS) || undefined,
});

const shutdown = () => {
  server.shutdown(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(port, () => {
  console.log(`jamming.cat listening on http://localhost:${port}  (try: curl localhost:${port})`);
});
