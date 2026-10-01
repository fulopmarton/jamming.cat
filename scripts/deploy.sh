#!/usr/bin/env bash
# Runs on the Oracle VM, called by .github/workflows/deploy.yml.
# Builds the image from ~/jamming.cat-deploy/incoming and swaps the container.
#
# Optional: put runtime settings (MAX_STREAMS=..., MAX_STREAM_SECONDS=...)
# in ~/jamming.cat-deploy/.env and they are passed to the container.
set -euo pipefail

TAG="${1:-manual}"
APP=jamming-cat
PORT=3000
BASE="$HOME/jamming.cat-deploy"
SRC="$BASE/incoming"
ENV_FILE="$BASE/.env"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed on this server." >&2
  echo "Install it once with: curl -fsSL https://get.docker.com | sudo sh" >&2
  exit 1
fi

DOCKER=docker
if ! docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
fi

echo "==> Building $APP:$TAG"
$DOCKER build --pull -t "$APP:$TAG" -t "$APP:latest" "$SRC"

# Remove the previous CI container, then anything else still holding the port
# (e.g. the container started by hand for the first deploy).
$DOCKER rm -f "$APP" >/dev/null 2>&1 || true
others=$($DOCKER ps -aq --filter "publish=$PORT")
if [ -n "$others" ]; then
  echo "==> Removing old container(s) on port $PORT: $others"
  $DOCKER rm -f $others >/dev/null
fi

if sudo ss -ltnH "sport = :$PORT" | grep -q .; then
  echo "Port $PORT is still in use by something outside Docker:" >&2
  sudo ss -ltnp "sport = :$PORT" >&2
  echo "Stop it (e.g. the systemd service or pm2 process) and re-run the deploy." >&2
  exit 1
fi

env_args=()
if [ -f "$ENV_FILE" ]; then
  env_args=(--env-file "$ENV_FILE")
fi

echo "==> Starting $APP:$TAG"
$DOCKER run -d \
  --name "$APP" \
  --restart unless-stopped \
  -p "127.0.0.1:$PORT:3000" \
  "${env_args[@]}" \
  "$APP:$TAG" >/dev/null

echo "==> Waiting for /healthz"
for _ in $(seq 1 20); do
  if body=$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null); then
    echo "    $body"
    rm -rf "$BASE/current"
    mv "$SRC" "$BASE/current"
    # Keep the image we just started plus the previous one for rollbacks.
    $DOCKER images "$APP" --format '{{.Tag}}' \
      | grep -vx -e latest -e "$TAG" | tail -n +2 \
      | xargs -r -I{} $DOCKER rmi "$APP:{}" >/dev/null 2>&1 || true
    $DOCKER image prune -f >/dev/null
    echo "==> Deployed $APP:$TAG"
    exit 0
  fi
  sleep 1
done

echo "Container did not become healthy. Logs:" >&2
$DOCKER logs --tail 50 "$APP" >&2 || true
exit 1
