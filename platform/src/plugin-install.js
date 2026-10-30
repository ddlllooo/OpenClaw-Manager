'use strict';
// No package code is loaded by the manager. The instance runtime owns staging, artifact
// verification, policy enforcement and capability-token validation.
const crypto = require('crypto');
const { npmSpec, fail } = require('./management');
const REGISTRY = 'https://registry.npmjs.org';
const TTL = 5 * 60 * 1000;
function createInstaller({ rpc, fetchMetadata = registryMetadata, now = Date.now, allowlist = () => process.env.MANAGER_PLUGIN_ALLOWLIST, nativeAllowlist = () => process.env.MANAGER_NATIVE_PLUGIN_ALLOWLIST } = {}) {
  const reviews = new Map();
  function checkSource(spec) {
    const allowed = allowlist(), name = spec.slice(0, spec.lastIndexOf('@'));
    if (allowed && !allowed.split(',').map(s => s.trim()).includes(name)) fail('插件来源不在管理员允许的 npm 包列表中', 403);
    if (!(nativeAllowlist() || '').split(',').map(s => s.trim()).includes(name)) fail('原生插件会与网关共享数据和密钥，默认禁止新增。工具插件请使用 isolate-plugin.cjs；确需原生插件时由管理员将完整 npm 包名加入 MANAGER_NATIVE_PLUGIN_ALLOWLIST',403);
  }
  function issue(context, intent, view, capabilities) {
    for (const [key, row] of reviews) if (row.expires <= now()) reviews.delete(key);
    if (reviews.size >= 128) fail('待确认的插件请求过多，请稍后重试', 429);
    const token = crypto.randomBytes(32).toString('hex');
    reviews.set(token, { context, intent, capabilities, expires: now() + TTL });
    return { reviewRequired: true, reviewToken: token, spec: intent.spec, ...view };
  }
  async function prepare(context, value) {
    const spec = npmSpec(value), split = spec.lastIndexOf('@');
    const name = spec.slice(0, split), version = spec.slice(split + 1);
    checkSource(spec);
    const metadata = await fetchMetadata(name, version);
    if (metadata.name !== name || metadata.version !== version) fail('npm 返回的包名或版本不匹配');
    const integrity = metadata.dist?.integrity;
    if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) fail('插件缺少有效 SHA-512 完整性信息，拒绝安装');
    let tarball;
    try { tarball = new URL(metadata.dist.tarball); } catch { fail('插件下载来源无效'); }
    if (tarball.origin !== REGISTRY || tarball.username || tarball.password || tarball.search || tarball.hash) fail('仅允许公共 npm registry 的 HTTPS 制品来源');
    const intent = { source: 'npm', spec, pin: true, expectedIntegrity: integrity };
    return issue(context, intent, { phase: 'source', execution: 'native (shares gateway data and credentials; administrator trusted)', source: REGISTRY, version, integrity,
      tarball: tarball.href, publishers: (Array.isArray(metadata.maintainers) ? metadata.maintainers : []).slice(0, 30).map(m => String(m.name || '').slice(0, 120)),
      warning: '请核对包名和发布者。公共 npm 来源和哈希不代表代码可信；插件可能读取实例数据、密钥并使用网络。下一步由运行时检查实际制品权限，策略警告不会自动接受。' });
  }
  async function install(context, instance, body) {
    const row = reviews.get(body.reviewToken);
    if (!row || row.expires <= now() || row.context !== context) fail('插件确认已过期或与当前会话、实例、配置不匹配，请重新检查', 409);
    if (body.spec !== row.intent.spec || body.confirmSpec !== row.intent.spec) fail('请完整输入本次确认的包名和固定版本');
    // Consume before dispatch, including on failure/unknown outcome. Never replay
    // an install merely because the browser retries a request.
    reviews.delete(body.reviewToken);
    checkSource(row.intent.spec);
    const request = { ...row.intent };
    if (row.capabilities) request.acknowledgeCapabilities = { reviewToken: row.capabilities };
    try {
      const result = await rpc(instance, 'manager.plugins.install', request, { timeout: 240000 });
      if (!result || result.ok === false || result.success === false) fail('插件安装未完成，请刷新库存并检查运行时状态');
      return { ok: true, hint: '插件安装完成，请刷新并重启实例应用插件。' };
    } catch (error) {
      const details = error.details;
      // A warning acknowledgment approves ALL warnings in an invocation, not
      // just the displayed finding. Do not issue that broad approval from here.
      if (details?.installPolicyCode) fail('安装策略阻止了安装，平台不会自动接受警告：' + String(error.message), 403);
      if (details?.persistence || details?.runtime?.committed) throw error;
      const consent = details?.capabilityConsentCode === 'PLUGIN_CAPABILITY_CONSENT_REQUIRED' ? details : null;
      if(instance.channelIsolation&&consent?.pluginId==='feishu')fail('独立飞书不能恢复同进程原生插件',403);
      if (!consent || typeof consent.pluginId !== 'string' || typeof consent.reviewToken !== 'string') throw error;
      const inspected = consent.report || await rpc(instance, 'plugins.inspect', { pluginId: consent.pluginId });
      if (inspected?.reviewToken !== consent.reviewToken || !inspected.declared || typeof inspected.declared !== 'object' || inspected.declaredSurfaceStatus === 'partial' || inspected.declaredSurfaceStatus === 'unavailable') fail('无法取得完整且匹配的权限审查，拒绝接受权限');
      const view = { phase: 'capabilities', pluginId: consent.pluginId, declared: inspected.declared, grants: inspected.grants,
        source: REGISTRY, integrity: row.intent.expectedIntegrity, version: row.intent.spec.slice(row.intent.spec.lastIndexOf('@') + 1),
        runtimeSource: inspected.source, trust: inspected.trust, warning: '以下为运行时从实际制品提取的权限声明。权限声明不是操作系统沙箱；仅在信任插件时批准。内容变化时必须重新审查。' };
      if (JSON.stringify(view).length > 64000) fail('插件权限报告过大，拒绝隐藏或截断后授权，请使用受信任终端审查');
      return issue(context, row.intent, view, consent.reviewToken);
    }
  }
  return { prepare, install };
}
async function registryMetadata(name, version) {
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' }
  });
  if (!response.ok) fail('无法读取指定 npm 版本，请核对来源和网络');
  if (Number(response.headers.get('content-length')) > 1024 * 1024) fail('npm 元数据过大');
  let raw = '', bytes = 0;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) fail('npm 元数据过大');
    raw += decoder.decode(chunk, { stream: true });
  }
  return JSON.parse(raw + decoder.decode());
}
function context(req, revision) {
  return crypto.createHash('sha256').update(JSON.stringify([req.headers.cookie || '', req.headers['x-csrf-token'] || '', req.instance.id, req.instance.containerId, revision])).digest('hex');
}
module.exports = { createInstaller, context, registryMetadata };
