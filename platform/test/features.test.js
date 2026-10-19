'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { EventEmitter } = require('events');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-features-'));
process.env.OPENCLAW_DATA_DIR = scratch;
const store = require('../src/instances');
const workspace = require('../src/workspace-files');
const feature = require('../src/instance-features');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
function fixture(id = 'features') {
  store.saveInstance({ id, gatewayToken: 'gateway-sensitive-token' });
  store.writeOpenclawConfig(id, '{}'); fs.mkdirSync(store.workspaceDir(id), { recursive: true });
}
test('workspace saves, detects conflicting writes and restores earlier contents with another history version', () => {
  fixture(); const empty = workspace.read('features', 'MEMORY.md');
  const first = workspace.write('features', 'MEMORY.md', 'first memory', empty.revision);
  assert.throws(() => workspace.write('features', 'MEMORY.md', 'overwrite', empty.revision), /已被/);
  const second = workspace.write('features', 'MEMORY.md', 'second memory', first.revision);
  const old = workspace.version('features', 'MEMORY.md', workspace.history('features', 'MEMORY.md')[0].version);
  assert.equal(old.content, 'first memory');
  const restored = workspace.write('features', 'MEMORY.md', old.content, second.revision);
  assert.equal(restored.content, 'first memory'); assert.equal(workspace.history('features', 'MEMORY.md').length, 2);
  assert.ok(!fs.existsSync(path.join(store.workspaceDir('features'), '.history')));
});
test('workspace rejects traversal, credentials, symlinks and invalid history IDs', t => {
  fixture('paths');
  for (const relative of ['../.env', 'memory/../SOUL.md', 'memory/a/b.md', '/MEMORY.md', 'memory/.secret.md', 'openclaw.json']) assert.throws(() => workspace.read('paths', relative));
  assert.throws(() => workspace.version('paths', 'MEMORY.md', '../../other'));
  const outside = path.join(scratch, 'outside.md'); fs.writeFileSync(outside, 'private');
  try { fs.symlinkSync(outside, path.join(store.workspaceDir('paths'), 'SOUL.md')); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('Windows symlink privilege unavailable; traversal checks passed'); return; } throw error; }
  assert.throws(() => workspace.read('paths', 'SOUL.md'), /符号链接/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'private');
});
test('workspace keeps 20 history entries and new memory files stay isolated by instance', () => {
  fixture('history'); fixture('other'); let row = workspace.read('history', 'memory/2026-10-15.md');
  for (let i = 0; i < 23; i++) row = workspace.write('history', row.path, 'version-' + i, row.revision);
  assert.equal(workspace.history('history', row.path).length, 20);
  assert.equal(workspace.read('other', row.path).exists, false);
  assert.throws(() => workspace.write('history', row.path, 'x'.repeat(workspace.MAX_BYTES + 1), row.revision), /256KB/);
});
test('cron create is disabled by default, validates timezones and never enables unsolicited delivery', () => {
  const job = feature.cronPatch({ name: 'daily', message: 'summarize', schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' } });
  assert.equal(job.enabled, false); assert.equal(job.delivery.mode, 'none'); assert.equal(job.sessionTarget, 'isolated');
  assert.throws(() => feature.schedule({ kind: 'cron', expr: '0 9 * * *', tz: 'Invalid/Timezone' }), /时区/);
  assert.throws(() => feature.schedule({ kind: 'every', everyMs: 5000 }), /间隔/);
  assert.throws(() => feature.schedule({ kind: 'at', at: '2026-01-01T00:00:00Z' }), /时间/);
  assert.throws(() => feature.cronPatch({ name: 'x', message: 'x', schedule: { kind: 'every', everyMs: 60000 }, delivery: { mode: 'announce', channel: 'feishu' } }), /目标/);
});
test('cron patch preserves advanced payload settings and revisions ignore runtime updates', () => {
  const old = { name: 'job', enabled: true, payload: { kind: 'agentTurn', message: 'before', model: 'provider/model', thinking: 'low', timeoutSeconds: 180 }, state: { lastRunAtMs: 1 } };
  const patch = feature.cronPatch({ message: 'after' }, old);
  assert.deepEqual(patch.payload, { ...old.payload, message: 'after' }); assert.ok(!Object.hasOwn(patch, 'enabled'));
  assert.equal(feature.cronRevision(old), feature.cronRevision({ ...old, state: { lastRunAtMs: 2 } }));
  assert.notEqual(feature.cronRevision(old), feature.cronRevision({ ...old, enabled: false }));
});
test('attachments validate size, filename, format and canonical MIME; text remains native attachment', () => {
  const content = Buffer.from('file test').toString('base64');
  assert.equal(feature.attachments([{ fileName: 'test.txt', mimeType: 'image/png', content }])[0].mimeType, 'text/plain');
  assert.throws(() => feature.attachments([{ fileName: '../test.txt', content }]), /文件名/);
  assert.throws(() => feature.attachments([{ fileName: 'test.png', content }]), /格式/);
  assert.throws(() => feature.attachments([{ fileName: 'test.txt', content: '!!!' }]), /编码/);
  assert.throws(() => feature.attachments(Array(5).fill({ fileName: 'x.txt', content })), /最多/);
  assert.throws(() => feature.attachments([{ fileName: 'x.txt', content: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }]), /10MB/);
});
test('diagnostics redact known credentials embedded in arbitrary output and nested secret fields', () => {
  fixture('redaction'); store.writeEnvFile('redaction', 'API_KEY=environment-secret');
  const clean = feature.redact({ details: ['problem with provider-secret and environment-secret'], nested: { apiKey: 'unknown-key', headers: { Auth: 'private' } } },
    { models: { providers: { demo: { apiKey: 'provider-secret' } } } }, { id: 'redaction', gatewayToken: 'gateway-sensitive-token' });
  assert.ok(!JSON.stringify(clean).includes('provider-secret')); assert.ok(!JSON.stringify(clean).includes('environment-secret')); assert.ok(!JSON.stringify(clean).includes('unknown-key'));
});
test('chat cancellation can pass the instance lock while a stream is still running', () => {
  const operations = require('../src/operations'); operations.busy.set('fixture', { description: 'POST /fixture/chat/stream' });
  let passed = false;
  operations.middleware({ method: 'POST', path: '/fixture/chat/abort' }, {}, () => { passed = true; });
  assert.equal(passed, true);
  let status;
  operations.middleware({ method: 'POST', path: '/fixture/restart' }, { status(s) { status = s; return this; }, json() {} }, () => assert.fail('must stay locked'));
  assert.equal(status, 409); operations.busy.clear();
});
test('a disconnected chat keeps its operation lock until the native run has actually completed', () => {
  const operations = require('../src/operations');
  const res = new EventEmitter(); res.json = value => value;
  operations.middleware({ method: 'POST', path: '/streamfixture/chat/stream' }, res, () => {});
  res.emit('close'); assert.equal(operations.busy.has('streamfixture'), true);
  res.locals.releaseManagerOperation(); assert.equal(operations.busy.has('streamfixture'), false);
});
test('doctor advisory exit code preserves structured findings; genuine CLI failures still reject', async () => {
  const filename = path.join(__dirname, '../src/gateway-rpc.js');
  let stdout = JSON.stringify({ ok: false, checksRun: 31, findings: [{ severity: 'warning', message: 'advisory' }] });
  const module = { exports: {} };
  const context = vm.createContext({ module, __dirname: path.dirname(filename), require: n => n === 'child_process' ? {
    execFile: (_, args, opts, cb) => cb(Object.assign(new Error('exit 1'), { code: 1 }), stdout, ''),
  } : require(n) });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  assert.equal(JSON.parse(await module.exports.cli({}, [], 1000, { allowFindings: true })).checksRun, 31);
  stdout = 'real command failure'; await assert.rejects(module.exports.cli({}, [], 1000, { allowFindings: true }));
});
test('editing only a cron name does not overwrite advanced schedules or delivery settings', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/features.js'), 'utf8');
  const start = source.indexOf('async function saveAutomation()'); const end = source.indexOf('async function automationAction(', start);
  const values = { cronAgent: 'main', cronName: 'updated', cronMessage: 'message', cronModel: '', cronKind: 'cron', cronSchedule: '0 9 * * *', cronTimezone: '', cronEnabled: 'false', cronDelivery: '__keep', cronTo: '', cronAccount: '' };
  const nodes = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, type: k === 'cronEnabled' ? 'checkbox' : 'text', checked: false, dataset: { savedValue: k === 'cronName' ? 'old' : v } }]));
  nodes.cronHint = {}; nodes.cronEditor = { classList: { add() {} } };
  let sent;
  const context = vm.createContext({ automationState: { editing: { id: 'job', managerRevision: 'rev1', schedule: { kind: 'cron', expr: '0 9 * * *', staggerMs: 1234 }, delivery: { mode: 'webhook', to: 'https://example.invalid' } } },
    state: { selectedId: 'fixture' }, $: s => nodes[s.slice(1)], $$: () => [],
    cronForm: () => ({ name: 'updated', message: 'message', model: '', schedule: { kind: 'cron', expr: '0 9 * * *' }, enabled: false, delivery: { mode: 'none' } }),
    api: async (_, opts) => { sent = JSON.parse(opts.body); }, loadAutomations: async () => {}, featureFailure: e => { throw e; } });
  vm.runInContext(source.slice(start, end), context); await context.saveAutomation();
  assert.deepEqual(sent, { revision: 'rev1', name: 'updated' });
});
