'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const config = require('../src/model-config');
const metadata = require('../src/model-metadata');
function fixture() {
  return { models: { mode: 'merge', providers: { 'openclaw-mgr-shared': {
    baseUrl: 'https://example.invalid/v1', apiKey: 'real-key', api: 'openai-responses', headers: { 'X-Custom': 'keep' },
    models: [{ id: 'vision', name: 'Friendly', contextWindow: 1000000, input: ['text', 'image'],
      reasoning: true, maxTokens: 32768, cost: { input: 1, output: 2 }, compat: { supportsStore: false } },
    { id: 'sibling', name: 'sibling', contextWindow: 65536, input: ['text'] }],
  } } }, agents: { defaults: { model: { primary: 'openclaw-mgr-shared/vision', fallbacks: ['elsewhere/fallback'] },
    models: { 'openclaw-mgr-shared/vision': { alias: 'Main' } } } } };
}
test('editing one field retains credentials, modalities, context, advanced fields and siblings', () => {
  const c = fixture(), before = structuredClone(c);
  config.update(c, 'vision', { contextWindow: 1048576 });
  before.models.providers['openclaw-mgr-shared'].models[0].contextWindow = 1048576;
  assert.deepEqual(c, before);
  config.update(c, 'vision', { apiKey: '', contextWindow: null });
  assert.deepEqual(c, before);
  config.update(c, 'vision', {});
  assert.deepEqual(c, before);
});
test('credential edit on grouped provider isolates the model and keeps API, headers, aliases and fallbacks', () => {
  const c = fixture();
  const result = config.update(c, 'vision', { apiKey: 'rotated-key' });
  assert.equal(c.models.providers['openclaw-mgr-shared'].apiKey, 'real-key');
  assert.equal(c.models.providers['openclaw-mgr-shared'].models.length, 1);
  const target = config.find(c, 'vision');
  assert.equal(target.provider.api, 'openai-responses');
  assert.equal(target.provider.headers['X-Custom'], 'keep');
  assert.equal(target.provider.apiKey, 'rotated-key');
  assert.equal(c.agents.defaults.model.primary, result.ref);
  assert.deepEqual(c.agents.defaults.model.fallbacks, ['elsewhere/fallback']);
  assert.equal(c.agents.defaults.models[result.ref].alias, 'Main');
});
test('rename uses actual provider and updates references without dropping sibling or custom display name', () => {
  const c = fixture();
  config.update(c, 'vision', { model: 'vision-v2' });
  assert.equal(config.find(c, 'vision'), null);
  assert.equal(config.find(c, 'vision-v2').pid, 'openclaw-mgr-shared');
  assert.equal(config.find(c, 'vision-v2').entry.name, 'Friendly');
  assert.equal(c.agents.defaults.model.primary, 'openclaw-mgr-shared/vision-v2');
  assert.ok(config.find(c, 'sibling'));
  assert.throws(() => config.update(c, 'vision-v2', { model: 'sibling' }), /已存在/);
});
test('delete removes only selected sibling and blocks referenced models', () => {
  const c = fixture();
  assert.throws(() => config.remove(c, 'vision'), /引用/);
  config.remove(c, 'sibling');
  assert.equal(config.find(c, 'sibling'), null);
  assert.ok(config.find(c, 'vision'));
});
test('new models require recognized or explicit metadata, existing omitted fields remain unset', () => {
  const c = fixture();
  assert.throws(() => config.update(c, null, { model: 'unknown', copyKeyFrom: 'vision' }), /无法自动识别/);
  const r = config.update(c, null, { model: 'custom', copyKeyFrom: 'vision', contextWindow: 1048576, input: ['text', 'image'], setDefault: false });
  assert.equal(r.entry.contextWindow, 1048576);
  assert.equal(c.agents.defaults.model.primary, 'openclaw-mgr-shared/vision');
  delete config.find(c, 'vision').entry.input;
  delete config.find(c, 'vision').entry.contextWindow;
  config.update(c, 'vision', { apiKey: '' });
  assert.equal(config.find(c, 'vision').entry.input, undefined);
});
test('automatic re-detection can repair 200k without changing max output or reasoning', () => {
  const c = fixture(); config.find(c, 'vision').entry.contextWindow = 200000;
  config.update(c, 'vision', { contextWindow: 'auto', input: 'auto' }, { contextWindow: 1000000, input: ['text', 'image'] });
  assert.equal(config.find(c, 'vision').entry.contextWindow, 1000000);
  assert.equal(config.find(c, 'vision').entry.maxTokens, 32768);
  assert.equal(config.find(c, 'vision').entry.reasoning, true);
  assert.throws(() => config.update(c, 'vision', { contextWindow: 10000001 }), /1024/);
  assert.throws(() => config.update(c, 'vision', { input: ['video'] }), /输入模态/);
  assert.throws(() => config.update(c, 'vision', { apiKey: 'real****mask' }), /脱敏/);
});
test('provider metadata overrides catalog limits per field, with no completion request', async () => {
  const result = await metadata.detect({ model: 'GLM-5.3-Flash', baseUrl: 'https://example.invalid/v1', apiKey: 'key',
    fetcher: async (url, options) => {
      assert.equal(String(url), 'https://example.invalid/v1/models'); assert.equal(options.redirect, 'error');
      return { ok: true, json: async () => ({ data: [{ id: 'GLM-5.3-Flash', context_length: 262144, architecture: { input_modalities: ['text', 'image'] } }] }) };
    } });
  assert.equal(result.contextWindow, 262144);
  assert.deepEqual(result.input, ['text', 'image']);
  assert.equal(result.sources.contextWindow, '供应商 /models');
});
test('official fallback recognizes exact local aliases and distinguishes text-only from vision generations', async () => {
  const fetcher = async () => { throw Error('offline'); };
  for (const id of ['Local-DeepSeek-V4.1-Flash', 'Qwen-3.8-Flash', 'GLM-5.3-Flash']) {
    const r = await metadata.detect({ model: id, baseUrl: 'https://example.invalid', fetcher });
    assert.deepEqual(r.input, ['text', 'image']); assert.equal(r.contextWindow, 1000000);
  }
  const r = await metadata.detect({ model: 'Local-DeepSeek-V4-Flash', baseUrl: 'https://example.invalid', fetcher });
  assert.deepEqual(r.input, ['text']);
});
test('unknown and ambiguous catalogs remain unresolved; unique OpenClaw entry can resolve', async () => {
  const base = { model: 'unknown', baseUrl: 'https://example.invalid', fetcher: async () => ({ ok: false }) };
  assert.deepEqual((await metadata.detect(base)).unresolved, ['input', 'contextWindow']);
  const r = await metadata.detect({ ...base, catalog: async () => [{ id: 'unknown', input: ['text', 'image'], contextWindow: 1048576 }] });
  assert.equal(r.contextWindow, 1048576); assert.deepEqual(r.unresolved, []);
  const ambiguous = metadata.catalogMatch('unknown', [{ id: 'unknown', contextWindow: 65536 }, { id: 'unknown', contextWindow: 131072 }]);
  assert.equal(ambiguous.contextWindow, undefined);
});
test('frontend edit sends only changed fields and leaves blank values untouched', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const start = source.indexOf('async function saveEditModel()');
  const end = source.indexOf('async function detectModelCapabilities', start);
  const nodes = { '#modelHint': {}, '#emNewName': { value: 'vision' }, '#emBaseUrl': { value: 'https://example.invalid/v1' },
    '#emApiKey': { value: '' }, '#emContextWindow': { value: '' }, '#emInput': { value: 'image' } };
  let sent;
  const ctx = vm.createContext({ editingModel: 'vision', editingModelSnapshot: fixture().models.providers['openclaw-mgr-shared'].models[0],
    state: { selectedId: 'instance' }, $: s => nodes[s], api: async (_, opts) => { sent = JSON.parse(opts.body); return {}; },
    logEvent() {}, closeEditModel() {}, loadModelConfig() {} });
  ctx.editingModelSnapshot.baseUrl = 'https://example.invalid/v1';
  vm.runInContext(source.slice(start, end), ctx);
  await ctx.saveEditModel(); assert.deepEqual(sent, {});
  nodes['#emContextWindow'].value = '1048576';
  await ctx.saveEditModel(); assert.deepEqual(sent, { contextWindow: 1048576 });
});

// Real HTTP routes and filesystem, mocked Docker/schema validation only.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-models-'));
process.env.OPENCLAW_DATA_DIR = scratch;
const store = require('../src/instances');
require.cache[require.resolve('../src/docker')] = { loaded: true, exports: { inspectContainer: async () => ({ State: { Running: true } }) } };
let validationError = false, changeDuringValidation = false;
require.cache[require.resolve('../src/validation')] = { loaded: true, exports: { validate: async () => {
  if (validationError) throw Error('invalid candidate');
  if (changeDuringValidation) store.writeOpenclawConfig('fixture', JSON.stringify({ external: 'newer configuration' }));
} } };
const express = require('express');
const app = express(); app.use(express.json()); app.use('/api/instances', require('../src/operations').middleware);
app.use('/api/instances', require('../src/routes/openclaw'));
let server, base;
test.before(async () => {
  store.saveInstance({ id: 'fixture', containerId: 'mock', containerName: 'mock' });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/instances/fixture/model`;
});
test.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(scratch, { recursive: true, force: true }); });
test('HTTP edit preserves stored metadata and returns modalities without credentials', async () => {
  store.writeOpenclawConfig('fixture', JSON.stringify(fixture()));
  const response = await fetch(base + '/vision', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contextWindow: 1048576 }) });
  assert.equal(response.status, 200);
  const saved = JSON.parse(store.readOpenclawConfig('fixture'));
  assert.equal(config.find(saved, 'vision').entry.maxTokens, 32768);
  const read = await (await fetch(base)).json();
  assert.deepEqual(read.models[0].input, ['text', 'image']);
  assert.ok(!JSON.stringify(read).includes('real-key'));
});
test('schema validation failure does not change live config; conflict retains external writer', async () => {
  const original = JSON.stringify(fixture()); store.writeOpenclawConfig('fixture', original);
  validationError = true;
  let response = await fetch(base + '/vision', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"contextWindow":1048576}' });
  assert.equal(response.status, 400); assert.equal(store.readOpenclawConfig('fixture'), original);
  validationError = false; changeDuringValidation = true;
  response = await fetch(base + '/vision', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"contextWindow":1048576}' });
  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(store.readOpenclawConfig('fixture')), { external: 'newer configuration' });
  changeDuringValidation = false;
});
