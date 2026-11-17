#!/data/data/com.termux/files/usr/bin/bash
# Start (or restart) the local PSN price proxy on 127.0.0.1:8787
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
pkill -f "$DIR/server.js" 2>/dev/null || true
sleep 0.2
cd "$DIR"
nohup node "$DIR/server.js" >>"$DIR/proxy.log" 2>&1 &
echo $! > "$DIR/proxy.pid"
sleep 0.5
curl -sS -m 3 http://127.0.0.1:8787/health || {
  echo "proxy failed to start; see $DIR/proxy.log"
  exit 1
}
echo
echo "proxy pid $(cat "$DIR/proxy.pid")"
