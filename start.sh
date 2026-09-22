#!/usr/bin/env bash
# 当日の起動スクリプト: サーバー + cloudflared クイックトンネル。
#
#   ./start.sh                 # トンネルあり(要 cloudflared: brew install cloudflared)
#   ./start.sh --fresh         # data/data.json を消して初期状態(運営トピック6本・新しい進行役キー)から
#   ./start.sh --no-tunnel     # LANのみ。参加者URLは http://<このMacのIP>:8787(現地の同一Wi-Fi限定)
#   PUBLIC_URL=https://example.com ./start.sh --no-tunnel   # 外部URLを手で指定
#   NO_OPEN=1 ./start.sh       # ボードをブラウザで自動的に開かない
#
# 見守り: サーバーが落ちたら再起動、トンネルが落ちたら張り直して参加者URLを更新する。
# 状態は data/data.json に残るので、落ちても続きから。
#
# set -e は使わない。失敗を握って再試行する作りなので、どこかの失敗で全体を止めたくない。
set -uo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8787}"
TUNNEL=1; FRESH=0
for a in "$@"; do
  case "$a" in
    --no-tunnel) TUNNEL=0 ;;
    --fresh) FRESH=1 ;;
    *) echo "不明なオプション: $a"; exit 1 ;;
  esac
done
mkdir -p data
if [[ $FRESH == 1 ]]; then rm -f data/data.json; echo "data/data.json を削除しました(初期状態で起動します)"; fi

SRV_PID=""; TUN_PID=""; KEY=""
PUBLIC_URL="${PUBLIC_URL:-}"

log() { echo "$(date '+%H:%M:%S') $*"; }

cleanup() {
  trap - EXIT INT TERM
  [[ -n "$TUN_PID" ]] && kill "$TUN_PID" 2>/dev/null
  [[ -n "$SRV_PID" ]] && kill "$SRV_PID" 2>/dev/null
  echo; log "終了しました。状態は data/data.json に残っています。"
  exit 0
}
trap cleanup EXIT INT TERM

server_up() { curl -sf "http://localhost:$PORT/api/state" >/dev/null 2>&1; }

start_server() {
  PORT="$PORT" node server.js >> data/server.log 2>&1 &
  SRV_PID=$!
  for _ in $(seq 1 50); do server_up && break; sleep 0.1; done
  if ! server_up; then
    log "サーバーが起動しませんでした。data/server.log を確認してください。"
    return 1
  fi
  KEY=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("data/data.json","utf8")).adminKey)' 2>/dev/null)
  return 0
}

set_public_url() {
  curl -sf -X POST -H 'content-type: application/json' -H "x-admin-key: $KEY" \
    -d "{\"publicUrl\":\"$1\"}" "http://localhost:$PORT/api/admin/settings" >/dev/null \
    || log "参加者URLの登録に失敗しました。進行役画面の「設定」から手で入れてください: $1"
}

lan_url() {
  local ip
  ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo localhost)
  echo "http://$ip:$PORT"
}

# クイックトンネルを張って URL を PUBLIC_URL に入れ、サーバーへ登録する。失敗したら 1 を返す。
start_tunnel() {
  [[ -n "$TUN_PID" ]] && kill "$TUN_PID" 2>/dev/null
  : > data/tunnel.log
  cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate >> data/tunnel.log 2>&1 &
  TUN_PID=$!
  local url=""
  for _ in $(seq 1 120); do
    url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' data/tunnel.log | head -1)
    [[ -n "$url" ]] && break
    sleep 0.5
  done
  if [[ -z "$url" ]]; then
    kill "$TUN_PID" 2>/dev/null; TUN_PID=""
    log "トンネルURLが取れませんでした(data/tunnel.log を確認)。"
    return 1
  fi
  # 新しいホスト名がDNSに載るまで少し待ってからQRに出す。
  # このMacのリゾルバに聞くと「まだ無い」がキャッシュされて自分だけ繋がらなくなるので、1.1.1.1 に直接聞く。
  local host="${url#https://}"
  for _ in $(seq 1 40); do
    [[ -n "$(dig +short @1.1.1.1 "$host" 2>/dev/null | head -1)" ]] && break
    sleep 0.5
  done
  PUBLIC_URL="$url"
  set_public_url "$PUBLIC_URL"
  return 0
}

# --- 起動 ---
start_server || exit 1

if [[ $TUNNEL == 1 ]] && ! command -v cloudflared >/dev/null; then
  log "cloudflared がありません(brew install cloudflared)。LANのみで続けます。"
  TUNNEL=0
fi
if [[ $TUNNEL == 1 ]]; then
  log "トンネル作成中..."
  if ! start_tunnel; then
    PUBLIC_URL=$(lan_url); set_public_url "$PUBLIC_URL"
    log "とりあえずLAN URL($PUBLIC_URL)で続けます。トンネルは10秒ごとに再試行します。"
  fi
else
  [[ -z "$PUBLIC_URL" ]] && PUBLIC_URL=$(lan_url)
  set_public_url "$PUBLIC_URL"
fi

cat <<MSG

================================================================
  参加者 (QR)      : $PUBLIC_URL
  進行役ボード     : http://localhost:$PORT/board?key=$KEY   ← これを画面共有。フルスクリーン推奨
  同じものを外から : $PUBLIC_URL/board?key=$KEY
  表示だけ(key無し): $PUBLIC_URL/board
================================================================
  Ctrl+C で終了。状態は data/data.json に残ります。

MSG
[[ -z "${NO_OPEN:-}" ]] && open "http://localhost:$PORT/board?key=$KEY" 2>/dev/null

# --- 見守り ---
while true; do
  sleep 2
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    log "サーバーが落ちました。再起動します..."
    if start_server; then
      log "サーバー再起動OK"
      [[ -n "$PUBLIC_URL" ]] && set_public_url "$PUBLIC_URL"
    else
      sleep 3
    fi
  fi
  if [[ $TUNNEL == 1 ]] && { [[ -z "$TUN_PID" ]] || ! kill -0 "$TUN_PID" 2>/dev/null; }; then
    log "トンネルがありません。張り直します..."
    if start_tunnel; then
      log "新しい参加者URL: $PUBLIC_URL (ボードのQRは自動更新。既に開いている人にはQRの再読み込みを案内)"
    else
      sleep 8
    fi
  fi
done
