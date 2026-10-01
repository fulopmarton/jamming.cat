# jamming.cat

A jamming cat in your terminal, in the spirit of `curl parrot.live`.

```sh
curl jamming.cat
```

Frames stream in until you press Ctrl+C. Browsers get a small landing page instead.

## Options

Options are path segments, so they don't need quoting in zsh, and you can combine them: `curl jamming.cat/party/big`.

| Path     | What you get                                                        |
| -------- | ------------------------------------------------------------------- |
| `/`      | 24-bit color, 48×24 (fits a default 80×24 terminal)                 |
| `/party` | Rainbow cat that changes color on every head bob                    |
| `/256`   | 256 colors, for terminals without truecolor                          |
| `/ascii` | Plain characters, rainbow colored. Works everywhere                  |
| `/small` | 32×16                                                                |
| `/big`   | 64×32, the GIF's native resolution                                   |
| `/help`  | Usage text                                                           |

Windows PowerShell: use `curl.exe`. wget: `wget -qO- jamming.cat`. HTTPie: `http --stream jamming.cat`.

## Running it

Needs Node 18 or newer. There are no dependencies.

```sh
npm start        # http://localhost:3000, then: curl localhost:3000
npm test
```

Or with Docker:

```sh
docker build -t jamming.cat .
docker run -p 3000:3000 jamming.cat
```

### Configuration

| Variable             | Default              | Purpose                                              |
| -------------------- | -------------------- | ---------------------------------------------------- |
| `PORT`               | `3000`               | Listen port                                          |
| `GIF_PATH`           | `assets/catjam.gif`  | Any animated GIF works; frames are decoded at startup |
| `MAX_STREAMS`        | `1000`               | Concurrent streams before new ones get a 503         |
| `MAX_STREAM_SECONDS` | `0` (unlimited)      | End each stream after this long                      |

`/healthz` returns `ok <n> jamming` with the current number of open streams.

## How it works

- [lib/gif.js](lib/gif.js) decodes the GIF (LZW, interlacing, transparency, disposal) into full RGBA frames.
- [lib/render.js](lib/render.js) scales each frame and turns it into ANSI escape codes. Color modes use `▀`/`▄` half blocks: the foreground color is the top pixel and the background is the bottom one, so every character cell shows two square pixels. Escape codes are only emitted when a color changes. ASCII mode maps histogram-equalized brightness to `.:-=+*#%@`.
- Party colors change on the beat. The renderer finds head bobs by tracking where the image's dark detail sits vertically, frame by frame, and switches color at each lowest point.
- [lib/server.js](lib/server.js) picks terminal clients by User-Agent, renders each variant once and caches it, then writes frames on the GIF's own timing (40ms, 25fps). Slow clients get backpressure instead of a growing buffer.

## Bandwidth

Truecolor at 25fps is heavy compared to plain ASCII art. Measured averages per viewer:

| Variant          | Per viewer  |
| ---------------- | ----------- |
| `/` (truecolor)  | ~550 KiB/s  |
| `/party`         | ~360 KiB/s  |
| `/big`           | ~975 KiB/s  |
| `/256`           | ~160 KiB/s  |
| `/ascii`         | ~23 KiB/s   |

If you host it publicly, set `MAX_STREAMS` and maybe `MAX_STREAM_SECONDS` to match your egress budget.

## Deploying behind a proxy

The server sends `X-Accel-Buffering: no`, so nginx streams frames without extra config. For other proxies, turn off response buffering for this upstream, or the cat will stutter or never show up.

With Caddy, disable buffering with `flush_interval -1`:

```caddyfile
jamming.cat {
	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}
}
```

Note that `curl jamming.cat` hits port 80, and curl does not follow redirects without `-L`. If you terminate TLS at a proxy, serve terminal clients over plain HTTP rather than redirecting them to HTTPS, or `curl jamming.cat` returns an empty 308 and no cat.

## Continuous deployment

Every push to `main` runs the tests, then [.github/workflows/deploy.yml](.github/workflows/deploy.yml) ships the commit to the Oracle VM over SSH. [scripts/deploy.sh](scripts/deploy.sh) builds the Docker image on the VM (it's ARM, so building there avoids cross-compiling), replaces the `jamming-cat` container on `127.0.0.1:3000`, and waits for `/healthz`. If `PUBLIC_URL` is set, the workflow then checks `$PUBLIC_URL/healthz`. You can also start it by hand from the Actions tab.

Secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (private key for that user), and optionally `DEPLOY_KNOWN_HOSTS` (the VM's host key line). Variable: `PUBLIC_URL` (optional). Runtime settings like `MAX_STREAMS` go in `~/jamming.cat-deploy/.env` on the VM.

## Credits

The GIF is the "catJAM" emoji of the Vibing Cat meme, from [emoji.gg](https://emoji.gg/emoji/5498_catJAM). Inspired by [parrot.live](https://github.com/hugomd/parrot.live).
