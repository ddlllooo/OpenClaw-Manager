'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createInstaller, context, registryMetadata } = require('../src/plugin-install');
const spec = '@test/plugin@1.2.3', integrity = 'sha512-' + Buffer.alloc(64, 17).toString('base64');
const metadata = () => ({ name: '@test/plugin', version: '1.2.3', dist: { integrity, tarball: 'https://registry.npmjs.org/@test/plugin/-/plugin-1.2.3.tgz' }, maintainers: [{ name: 'publisher' }] });
function setup(options = {}) {
  const calls = [];
  const api = createInstaller({ fetchMetadata: async () => metadata(), rpc: async (...args) => { calls.push(args); return { ok: true }; }, allowlist: () => '', nativeAllowlist: () => '@test/plugin', ...options });
  return { api, calls };
}
const body = review => ({ spec: review.spec, confirmSpec: review.spec, reviewToken: review.reviewToken });
test('source review verifies an immutable public npm identity without executing an install', async () => {
  const { api, calls } = setup(); const review = await api.prepare('session', spec);
  assert.equal(review.phase, 'source'); assert.equal(review.integrity, integrity);
  assert.deepEqual(review.publishers, ['publisher']); assert.equal(calls.length, 0);
  await api.install('session', {}, body(review));
  assert.equal(calls[0][1], 'manager.plugins.install');
  assert.deepEqual(calls[0][2], { source: 'npm', spec, pin: true, expectedIntegrity: integrity });
});
test('rejects mutable versions, URLs, paths, aliases, invalid SemVer and command switches before lookup', async () => {
  let reads = 0; const { api } = setup({ fetchMetadata: async () => { reads++; return metadata(); } });
  for (const value of ['plugin@latest', 'plugin@^1.2.3', '../x', 'https://example.com/a.tgz', 'npm:plugin@1.2.3', '--force', 'plugin@01.2.3', 'plugin@1.2.3-..x', 'plugin@1.2.3-01']) await assert.rejects(api.prepare('s', value));
  assert.equal(reads, 0);
});
test('rejects mismatched metadata, missing integrity and alternate or credentialed download hosts', async () => {
  for (const patch of [{name:'wrong'}, {version:'1.2.4'}, {dist:{}}, ...['http://registry.npmjs.org/a', 'https://evil.invalid/a', 'https://registry.npmjs.org.evil.invalid/a', 'https://u:p@registry.npmjs.org/a', 'https://registry.npmjs.org/a?token=x'].map(tarball => ({dist:{integrity,tarball}}))]) {
    const { api, calls } = setup({ fetchMetadata: async () => ({ ...metadata(), ...patch }) });
    await assert.rejects(api.prepare('s', spec)); assert.equal(calls.length, 0);
  }
});
test('approval binds session, instance, container and config, requires typed identity, expires and is one use', async () => {
  const req = { headers: { cookie: 'session-a', 'x-csrf-token': 'csrf' }, instance: { id: 'a', containerId: 'container' } };
  const ctx = context(req, 'revision');
  for (const altered of [{ ...req, headers: { ...req.headers, cookie: 'session-b' } }, { ...req, instance: { ...req.instance, id: 'b' } }, { ...req, instance: { ...req.instance, containerId: 'new' } }]) assert.notEqual(context(altered, 'revision'), ctx);
  assert.notEqual(context(req, 'new'), ctx);
  let now = 0; const { api, calls } = setup({ now: () => now }); const review = await api.prepare(ctx, spec);
  await assert.rejects(api.install('other', {}, body(review)), /不匹配/);
  await assert.rejects(api.install(ctx, {}, { ...body(review), spec: 'other@1.2.3' }));
  await assert.rejects(api.install(ctx, {}, { ...body(review), confirmSpec: '' }));
  await api.install(ctx, {}, body(review)); await assert.rejects(api.install(ctx, {}, body(review))); assert.equal(calls.length, 1);
  const expired = await api.prepare(ctx, spec); now += 300001; await assert.rejects(api.install(ctx, {}, body(expired))); assert.equal(calls.length, 1);
});
test('administrator source allowlist is enforced again at dispatch', async () => {
  let allowed = '@test/plugin'; const { api, calls } = setup({ allowlist: () => allowed });
  const review = await api.prepare('s', spec); allowed = '@other/plugin';
  await assert.rejects(api.install('s', {}, body(review)), /允许/); assert.equal(calls.length, 0);
  await assert.rejects(api.prepare('s', spec), /允许/);
});
const consentError = () => Object.assign(new Error('capability consent required'), { details: { capabilityConsentCode: 'PLUGIN_CAPABILITY_CONSENT_REQUIRED', pluginId: 'test', reviewToken: 'owner-token' } });
test('fresh artifact permission report is shown before sending exactly the owner review token', async () => {
  const calls = []; let attempt = 0;
  const { api } = setup({ rpc: async (instance, method, params) => {
    calls.push({method,params});
    if (method === 'plugins.inspect') return { reviewToken: 'owner-token', declared: { tools: ['read', 'exec'], network: ['example.com'] }, grants: { approved: [] } };
    if (++attempt === 1) throw consentError();
    return { ok: true };
  } });
  const source = await api.prepare('s', spec), review = await api.install('s', {}, body(source));
  assert.equal(review.phase, 'capabilities'); assert.deepEqual(review.declared.tools, ['read', 'exec']); assert.equal(attempt, 1);
  await api.install('s', {}, body(review));
  assert.deepEqual(calls.at(-1).params.acknowledgeCapabilities, {reviewToken:'owner-token'});
  assert.equal(calls.at(-1).params.expectedIntegrity, integrity);
  assert.equal(calls.at(-1).params.acknowledgeInstallPolicyWarning, undefined);
});
test('missing, stale, partial or oversized permission reviews never grant consent', async () => {
  for (const inspected of [{}, {reviewToken:'stale',declared:{}}, {reviewToken:'owner-token'}, {reviewToken:'owner-token',declared:{},declaredSurfaceStatus:'partial'}, {reviewToken:'owner-token',declared:{tools:['x'.repeat(64000)]}}]) {
    const { api } = setup({ rpc: async (i, method) => { if (method === 'plugins.inspect') return inspected; throw consentError(); } });
    await assert.rejects(api.install('s', {}, body(await api.prepare('s', spec))));
  }
});
test('changed permissions require another explicit review instead of blanket acceptance', async () => {
  let attempts = 0;
  const { api } = setup({ rpc: async (i, method, params) => {
    if (method === 'plugins.inspect') return {reviewToken:'owner-token',declared:{tools:['new-tool-'+attempts]}};
    attempts++; throw consentError();
  } });
  const source = await api.prepare('s', spec), first = await api.install('s', {}, body(source));
  const changed = await api.install('s', {}, body(first)); assert.notEqual(changed.reviewToken, first.reviewToken);
  assert.deepEqual(changed.declared.tools, ['new-tool-2']); assert.equal(attempts, 2);
});
test('policy warnings, blocks, unknown outcomes and persisted failures are never automatically retried', async () => {
  for (const error of [Object.assign(new Error('policy warning: credential access'), {details:{installPolicyCode:'install_policy_warning_acknowledgement_required'}}), new Error('blocked'), new Error('timeout after commit'), Object.assign(consentError(), {details:{...consentError().details,persistence:{operation:'install'}}})]) {
    let count = 0; const { api } = setup({ rpc: async () => {count++; throw error;} }); const source = await api.prepare('s', spec);
    await assert.rejects(api.install('s', {}, body(source))); await assert.rejects(api.install('s', {}, body(source))); assert.equal(count, 1);
  }
});
test('registry fetch is credentialless, rejects redirects and bounds metadata responses', async () => {
  const original = global.fetch;
  try {
    global.fetch = async (url, options) => { assert.equal(url,'https://registry.npmjs.org/%40test%2Fplugin/1.2.3'); assert.equal(options.redirect,'error'); assert.equal(options.headers.Authorization,undefined); return new Response(JSON.stringify(metadata())); };
    assert.equal((await registryMetadata('@test/plugin','1.2.3')).name,'@test/plugin');
    global.fetch = async () => new Response('x'.repeat(1024*1024+1));
    await assert.rejects(registryMetadata('x','1.2.3'),/过大/);
    global.fetch = async () => new Response('{}',{status:404}); await assert.rejects(registryMetadata('x','1.2.3'));
  } finally { global.fetch = original; }
});
