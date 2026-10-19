'use strict';
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const HELPER = fs.readFileSync(path.join(__dirname, 'gateway-helper.cjs'), 'utf8');
const PREFIX = '@@MANAGER@@';
function rpc(instance, method, params = {}, { timeout = 45000, stream = false, onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', instance.containerName, 'node', '-e', HELPER], { windowsHide: true });
    let pending = '', stderr = '', result, settled = false, bytes = 0;
    const decoder = new StringDecoder('utf8');
    const timer = setTimeout(() => { child.kill(); finish(new Error('网关请求超时，请检查实例状态')); }, timeout + 5000);
    function finish(error) {
      if (settled) return; settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(result);
    }
    child.on('error', finish);
    child.stdin.on('error', () => {});
    child.stderr.on('data', b => { if (stderr.length < 2000) stderr += b.toString(); });
    child.stdout.on('data', b => {
      bytes += b.length;
      if (bytes > 24 * 1024 * 1024) { child.kill(); finish(new Error('网关返回数据过大')); return; }
      pending += decoder.write(b);
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line.startsWith(PREFIX)) continue;
        try {
          const envelope = JSON.parse(line.slice(PREFIX.length));
          if (envelope.error) { finish(new Error(envelope.error)); continue; }
          if (envelope.kind === 'result') result = envelope.data;
          onEvent?.(envelope);
        } catch (error) { finish(error); }
      }
    });
    child.on('close', code => {
      if (code !== 0) finish(new Error('网关调用失败：' + (stderr.split('\n').find(Boolean) || '连接中断').slice(0, 200)));
      else if (result === undefined && !stream) finish(new Error('网关未返回结果'));
      else finish();
    });
    child.stdin.end(JSON.stringify({ method, params, timeout, stream, token: instance.gatewayToken }));
  });
}
function cliOnce(instance, args, timeout = 90000, { allowFindings = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', ['exec', instance.containerName, 'openclaw', ...args],
      { timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          if (allowFindings && error.code === 1) {
            try { const data = JSON.parse(stdout); if (Array.isArray(data.findings) && Number.isInteger(data.checksRun)) return resolve(String(stdout)); } catch { /* CLI failed rather than returning advisory findings */ }
          }
          return reject(new Error(String(stderr || stdout || error.message).slice(0, 1000)));
        }
        resolve(String(stdout));
      });
  });
}
async function cli(instance, args, timeout = 90000, options = {}) {
  const readOnly = (args[0] === 'pairing' && args[1] === 'list') || (args[0] === 'plugins' && args[1] === 'list') || args[0] === 'doctor';
  for (let attempt = 0; ; attempt++) {
    try { return await cliOnce(instance, args, timeout, options); }
    catch (error) {
      if (!readOnly || attempt >= 4 || !/Could not start the CLI[\s\S]*refused shared state schema mutation[\s\S]*another Gateway owns/i.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 750 * (attempt + 1)));
    }
  }
}
module.exports = { rpc, cli };
