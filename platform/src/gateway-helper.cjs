// Runs inside the instance. Request bodies (including attachments and the token)
// arrive on stdin, never in command arguments or temporary files.
const fs = require('fs');
const { pathToFileURL } = require('url');
const prefix = '@@MANAGER@@';
const emit = (kind, data) => process.stdout.write(prefix + JSON.stringify({ kind, data }) + '\n');
async function exported(prefixName, exportName) {
  for (const name of fs.readdirSync('/app/dist').filter(n => n.startsWith(prefixName + '-') && n.endsWith('.mjs'))) {
    const source = fs.readFileSync('/app/dist/' + name, 'utf8');
    const end = source.slice(source.lastIndexOf('export {'));
    if (!end.includes(exportName)) continue;
    const module = await import(pathToFileURL('/app/dist/' + name).href);
    const alias = new RegExp('\\b' + exportName + ' as ([\\w$]+)').exec(end)?.[1];
    if (typeof module[exportName] === 'function') return module[exportName];
    if (alias && typeof module[alias] === 'function') return module[alias];
  }
  throw new Error('当前 OpenClaw 版本不提供所需接口：' + exportName);
}
(async () => {
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 32 * 1024 * 1024) throw new Error('请求过大'); }
  const input = JSON.parse(raw);
  if (!input.stream) {
    const call = await exported('call', 'callGatewayCli');
    let data;
    for (let attempt = 0; ; attempt++) {
      try { data = await call({ method: input.method, params: input.params, token: input.token, timeoutMs: input.timeout, scopes: ['operator.admin'] }); break; }
      catch (error) {
        // A rejected WebSocket upgrade happens before RPC dispatch. Only this
        // admission fence is safe to retry; never replay an uncertain mutation.
        if (attempt >= 4 || !/gateway rejected websocket upgrade \(HTTP 503\).*admission closed/i.test(String(error.message))) throw error;
        await new Promise(resolve => setTimeout(resolve, 750 * (attempt + 1)));
      }
    }
    emit('result', data); return;
  }
  const GatewayClient = await exported('client', 'GatewayClient');
  const loadIdentity = await exported('device-identity', 'loadOrCreateDeviceIdentity');
  await new Promise((resolve, reject) => {
    let client, done = false, accepted = false;
    const runId = input.params.idempotencyKey;
    const timer = setTimeout(() => finish(new Error('对话超时，请查看会话记录后重试')), input.timeout);
    function finish(error) {
      if (done) return; done = true; clearTimeout(timer); client?.stop();
      error ? reject(error) : resolve();
    }
    client = new GatewayClient({ url: 'ws://127.0.0.1:18789', token: input.token,
      clientName: 'cli', clientVersion: 'manager-1', mode: 'cli', role: 'operator',
      scopes: ['operator.admin'], deviceIdentity: loadIdentity(), minProtocol: 4, maxProtocol: 4,
      onHelloOk: async () => {
        if (accepted) return; accepted = true;
        try { emit('accepted', await client.request('chat.send', input.params, { timeoutMs: 30000 })); }
        catch (error) { finish(error); }
      },
      onEvent: event => {
        if (event.event !== 'chat' || event.payload?.runId !== runId) return;
        emit('chat', event.payload);
        if (['final', 'error', 'aborted'].includes(event.payload.state)) finish();
      },
      onConnectError: error => finish(error),
      onClose: () => { if (!done) finish(new Error('网关连接中断，请查看会话记录')); },
    });
    client.start();
  });
})().then(() => process.stdout.write('', () => process.exit(0))).catch(error => {
  process.stdout.write(prefix + JSON.stringify({ error: String(error.message || error).slice(0, 600) }) + '\n', () => process.exit(1));
});
