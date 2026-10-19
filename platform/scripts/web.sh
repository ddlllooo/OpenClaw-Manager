#!/usr/bin/env bash
# Web-mode launcher: run the manager as a plain Node web service (same code the
# Electron app embeds), serving http://127.0.0.1:${PORT:-18080}/ for browsers.
#
#   scripts/web.sh            # foreground (Ctrl+C to stop)
#   scripts/web.sh -d         # background via nohup, log to /tmp/openclaw-web.log
#   scripts/web.sh -s         # stop a background instance started with -d
#   PORT=18081 scripts/web.sh # custom port
#
# Uses the repo's data/ directory (NOT the desktop app's userData copy) unless
# OPENCLAW_DATA_DIR is set. If the desktop app already holds the port, this
# script tells you instead of failing confusingly.

set -eu
cd "$(dirname "$0")/.."

PORT="${PORT:-18080}"
LOG="${WEB_LOG:-/tmp/openclaw-web.log}"
PIDFILE="/tmp/openclaw-web.pid"

port_owner() {
  lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1
}

describe_owner() {
    if pgrep -qf "OpenClaw Manager.app"; then
      echo "端口 $PORT 被桌面应用占用 [pid $1]。先退出 OpenClaw Manager 再启动 web 模式。"
    else
      echo "端口 $PORT 已被 pid $1 占用。"
    fi
}

case "${1:--f}" in
  -s|--stop)
    if [ -f "$PIDFILE" ]; then
      pid=$(cat "$PIDFILE")
      if kill "$pid" 2>/dev/null; then
        echo "已停止 web 服务 (pid $pid)"
      else
        echo "pid $pid 已不在运行"
      fi
      rm -f "$PIDFILE"
    else
      echo "没有通过 -d 启动的记录（$PIDFILE 不存在）"
    fi
    exit 0
    ;;
  -d|--daemon)
    owner=$(port_owner || true)
    if [ -n "$owner" ]; then describe_owner "$owner"; exit 1; fi
    echo "后台启动 web 服务: http://127.0.0.1:${PORT}/ [日志: ${LOG}]"
    OPENCLAW_DATA_DIR="${OPENCLAW_DATA_DIR:-$PWD/data/instances}" \
    MANAGER_PORT="$PORT" nohup node server.js >>"$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    sleep 1
    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "已启动 (pid $(cat "$PIDFILE"))。停止: scripts/web.sh -s"
    else
      echo "启动失败，最近日志："; tail -5 "$LOG"; rm -f "$PIDFILE"; exit 1
    fi
    exit 0
    ;;
  -f|--foreground|"")
    owner=$(port_owner || true)
    if [ -n "$owner" ]; then describe_owner "$owner"; exit 1; fi
    export OPENCLAW_DATA_DIR="${OPENCLAW_DATA_DIR:-$PWD/data/instances}"
    export MANAGER_PORT="$PORT"
    exec node server.js
    ;;
  *)
    echo "用法: scripts/web.sh [-f|-d|-s]  (-f 前台 / -d 后台 / -s 停止)"
    exit 1
    ;;
esac
