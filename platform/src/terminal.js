'use strict';

// Interactive terminal per instance: bridges a browser WebSocket (xterm.js)
// to a docker exec TTY stream. The exec process runs INSIDE the instance
// container, so the shell sees the instance's own filesystem (config dir,
// workspace) and environment — a direct replacement for opening a terminal
// on the host and typing `docker exec -it openclaw-<id> bash`.

const WebSocket = require('ws');
const crypto = require('crypto');
const store = require('./instances');
const dockermod = require('./docker');

// One shell per connection; docker exec processes die with their socket.
const clients = new Set();

function safeSend(ws, payload) {
  if (ws.bufferedAmount > 1024 * 1024) return ws.close(1008, 'slow client');
  if (ws.readyState === WebSocket.OPEN) ws.send(payload, () => { /* ignore */ });
}

// Wire protocol (client → server):
//   binary frames      = raw stdin bytes from xterm.js
//   text frames (JSON) = {type:"resize", cols, rows} | {type:"ping"}
// Wire protocol (server → client):
//   binary frames      = raw pty output (stdout+stderr merged via Tty:true)
//   text frames (JSON) = {type:"error", message} | {type:"exit", code}
function handleTerminal(instanceId, ws) {
  let instance = null;
  let execStream = null;
  let execProc = null; // container-modem exec instance (resize / kill)
  let closed = false;
  let sentExit = false;
  let pendingInput = Buffer.alloc(0);
  const pidFile = `/tmp/.manager-terminal-${crypto.randomBytes(12).toString('hex')}.pid`;
  let cleanupScheduled = false;
  let lastActivity = Date.now();
  const idleTimer = setInterval(() => { if (Date.now() - lastActivity > 15 * 60 * 1000) ws.close(1000, 'idle timeout'); }, 60000);
  idleTimer.unref();

  try {
    instance = store.loadInstance(instanceId);
  } catch {
    safeSend(ws, JSON.stringify({ type: 'error', message: '实例不存在' }));
    ws.close();
    return;
  }
  if (!instance.containerId) {
    safeSend(ws, JSON.stringify({ type: 'error', message: '实例容器尚未创建，请先启动实例' }));
    ws.close();
    return;
  }

  let pendingCols = 80;
  let pendingRows = 24;

  function applyResize(execRef, cols, rows) {
    if (!execRef || typeof execRef.resize !== 'function') return;
    execRef.resize({ w: cols, h: rows }).catch(() => { /* exec already gone */ });
  }

  const container = dockermod.getContainer(instance.containerId);
  const shell = process.env.OPENCLAW_TERMINAL_SHELL || 'bash';
  const shellArgs = shell === 'sh' ? [] : ['-l'];
  function cleanupShell() {
    if (cleanupScheduled) return;
    cleanupScheduled = true;
    // Docker exec has no kill API. Save the container PID before exec'ing the shell,
    // then signal only that per-connection process on disconnect (never other terminals).
    const timer = setTimeout(() => {
      container.exec({ User: 'node', Cmd: ['sh', '-c',
        `if [ -r '${pidFile}' ]; then read p < '${pidFile}'; case "$p" in ''|*[!0-9]*) exit 1;; esac; kill -HUP "$p" 2>/dev/null || true; rm -f '${pidFile}'; fi`],
      }).then(exec => exec.start({ Detach: true })).catch(() => {});
    }, 300);
    timer.unref();
  }

  container.exec({
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true, // merged stdout/stderr; raw pty semantics for vim/ctrl-c
    Cmd: ['sh', '-c', `echo $$ > '${pidFile}'; exec "$@"`, 'manager-terminal', shell, ...shellArgs],
    Env: [
      'TERM=xterm-256color',
      'HOME=/home/node',
      'LANG=C.UTF-8',
      `OPENCLAW_GATEWAY_TOKEN=${instance.gatewayToken}`,
    ],
    WorkingDir: '/home/node',
    User: 'node',
  }, (err, exec) => {
    if (closed) return;
    if (err || !exec) {
      safeSend(ws, JSON.stringify({ type: 'error', message: `创建终端失败: ${err ? err.message : '未知错误'}` }));
      ws.close();
      return;
    }
    execProc = exec;
    exec.start({ hijack: true, stdin: true }, (startErr, stream) => {
      if (closed) {
        stream && stream.destroy && stream.destroy();
        cleanupShell();
        return;
      }
      if (startErr || !stream) {
        safeSend(ws, JSON.stringify({ type: 'error', message: `终端连接失败: ${startErr ? startErr.message : '未知错误'}` }));
        ws.close();
        return;
      }
      execStream = stream;
      if (pendingInput.length) { stream.write(pendingInput); pendingInput = Buffer.alloc(0); }
      safeSend(ws, JSON.stringify({ type: 'ready' }));

      // With Tty:true the whole frame is payload — pipe it straight through.
      stream.on('data', (chunk) => safeSend(ws, chunk));
      stream.on('end', () => sendExit(0));
      stream.on('error', () => sendExit(1));

      // Apply the client's current window size as soon as the exec exists,
      // then xterm's own resize messages take over.
      applyResize(execProc, pendingCols, pendingRows);
    });
  });

  function sendExit(code) {
    if (sentExit || closed) return;
    sentExit = true;
    safeSend(ws, JSON.stringify({ type: 'exit', code }));
    try { ws.close(); } catch { /* already closing */ }
  }

  ws.on('message', (data, isBinary) => {
    if (closed) return;
    lastActivity = Date.now();
    if (isBinary) {
      if (execStream) execStream.write(Buffer.from(data));
      else if (pendingInput.length + data.length <= 65536) pendingInput = Buffer.concat([pendingInput, Buffer.from(data)]);
      else ws.close(1009, 'input buffer exceeded');
      return;
    }
    try {
      const msg = JSON.parse(String(data));
      if (msg.type === 'resize') {
        pendingCols = Math.min(500, Math.max(2, Number(msg.cols) || 80));
        pendingRows = Math.min(300, Math.max(2, Number(msg.rows) || 24));
        applyResize(execProc, pendingCols, pendingRows);
      }
      // "ping" — ws protocol-level keepalive already covers liveness.
    } catch { /* ignore malformed control frames */ }
  });

  ws.on('close', () => {
    clearInterval(idleTimer);
    cleanupShell();
    closed = true;
    clients.delete(ws);
    if (execStream) { try { execStream.end(); } catch { /* noop */ } }
    if (execProc && typeof execProc.kill === 'function') {
      execProc.kill().catch(() => { /* already gone */ });
    }
  });

  ws.on('error', () => {
    clearInterval(idleTimer);
    cleanupShell();
    if (execStream) execStream.destroy();
    closed = true;
    clients.delete(ws);
  });

  clients.add(ws);
}

function parseUpgrades(server) {
  const wss = new WebSocket.Server({ noServer: true, maxPayload: 65536 });

  server.on('upgrade', async (req, socket, head) => {
    if(process.env.MANAGER_CONTAINERIZED==='1'&&require('./ssh-origins').upgrade(req,socket,head))return;
    if (!require('./security').authenticated(req) || !req.headers.origin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    if (clients.size >= 8) { socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return; }
    const m = /^\/api\/instances\/([A-Za-z0-9_-]+)\/terminal$/.exec((req.url || '').split('?')[0]);
    if (!m) { socket.destroy(); return; }
    try {
      const inst = store.loadInstance(m[1]);
      if (!inst.containerId || !(await dockermod.inspectContainer(inst.containerId)).State.Running) {
        socket.end('HTTP/1.1 409 Conflict\r\n\r\n'); return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => handleTerminal(m[1], ws));
    } catch { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); }
  });
}

module.exports = { parseUpgrades, clients };
