// Embedded before gateway-helper.cjs, executed inside the instance as its normal
// user. This uses the same transactional installer as the installed CLI. Older
// Gateways do not expose npm installs over RPC. Missing exports fail closed.
async function installVerifiedPlugin(input, exported) {
  const crypto = require('crypto');
  const request = input.params;
  const readSnapshot = await exported('management-config', 'readPluginMutationSnapshot');
  const install = await exported('management-install', 'installManagedPluginSource');
  const inspectArtifact = await exported('install', 'installPluginFromNpmSpec');
  const consentHandler = await exported('capability-consent', 'prepareManagedPluginArtifactConsentHandler');
  const defer = await exported('npm-managed-root', 'requestDeferredPluginInstall');
  const transaction = await exported('npm-managed-root', 'resolvePluginInstallTransaction');
  const snapshot = await readSnapshot(process.env);
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  };
  const logger = { info() {}, warn() {}, error() {} };
  let approved = false;
  const reviewCapabilities = async review => {
      if (!review.declared || typeof review.reviewToken !== 'string') throw new Error('运行时没有提供完整的插件权限审查');
      const report = { pluginId: review.pluginId, declared: review.declared, grants: review.grants, trust: review.trust };
      // Native tokens can be process-local. Bind the manager's approval to the
      // immutable artifact and the entire report, then return the freshly issued
      // native token only after this comparison. The owner rechecks it at commit.
      const digest = crypto.createHash('sha256').update(JSON.stringify(canonical({ spec: request.spec, integrity: request.expectedIntegrity, report }))).digest('hex');
      if (request.acknowledgeCapabilities?.reviewToken === digest) { approved = true; return { reviewToken: review.reviewToken }; }
      const error = new Error('插件需要明确审查并批准声明的权限');
      error.details = { capabilityConsentCode: 'PLUGIN_CAPABILITY_CONSENT_REQUIRED', pluginId: review.pluginId, reviewToken: digest,
        report: { ...report, reviewToken: digest } };
      throw error;
  };
  // Explicitly review official artifacts too. Some runtime releases exempt
  // official npm packages from their default consent callback. This separate
  // staging pass always stops before commit and preserves that runtime's policy
  // and integrity checks. No source code is imported for inspection.
  const handler = await consentHandler({ config: snapshot.config, source: 'npm', spec: request.spec,
    expectedIntegrity: request.expectedIntegrity, reviewOfficialArtifacts: true, onCapabilityConsent: reviewCapabilities });
  const staged = new Error('MANAGER_PLUGIN_INSPECTION_COMPLETE');
  let inspection;
  try {
    inspection = await inspectArtifact(defer({ spec: request.spec, expectedIntegrity: request.expectedIntegrity,
      config: snapshot.config, mode: 'install', logger,
      onBeforePluginArtifactCommit: async artifact => { await handler.onBeforePluginArtifactCommit(artifact); throw staged; } }));
    throw new Error(String(inspection.error || '运行时未执行插件制品预检，拒绝安装'));
  } catch (error) { if (error !== staged) throw error; }
  finally { if (inspection) await transaction(inspection)?.rollback(); }
  if (!approved) throw new Error('插件制品未获得权限批准');
  const result = await install({
    request: { source: 'npm', spec: request.spec, pin: true, mode: 'install', expectedIntegrity: request.expectedIntegrity },
    snapshot,
    runtime: { log() {}, error() {}, exit(code) { throw new Error('Plugin installer stopped: ' + code); } },
    logger,
    onCapabilityConsent: reviewCapabilities,
    beforePersistentEffect: () => { if (!approved) throw new Error('插件制品未获得权限批准'); }
    // No accept-all callback and no onInstallPolicyWarning override.
  });
  if (!result.ok) throw new Error(String(result.error || '插件安装失败').slice(0, 1200));
  // Never return installed.config or arbitrary runtime objects to the browser.
  return { ok: true, restartRequired: true };
}
