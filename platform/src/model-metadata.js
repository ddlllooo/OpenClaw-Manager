'use strict';

// Small, reviewed fallback catalog. Endpoint metadata takes precedence because
// self-hosted deployments can impose lower limits than the original model.
// Sources reviewed 2026-10-15:
// https://api-docs.deepseek.com/quick_start/pricing/
// https://api-docs.deepseek.com/guides/vision/
// https://github.com/zai-org/GLM-5
// https://help.aliyun.com/en/model-studio/glm
// https://www.alibabacloud.com/help/en/model-studio/qwen3-8-flash
const CATALOG = {
  'glm-5.3-flash': { input: ['text', 'image'], contextWindow: 1000000 },
  'glm-5.3': { input: ['text'], contextWindow: 1000000 },
  'qwen3.8-flash': { input: ['text', 'image'], contextWindow: 1000000 },
  'deepseek-v4.1-flash': { input: ['text', 'image'], contextWindow: 1000000 },
  'deepseek-v4-flash': { input: ['text'], contextWindow: 1000000 },
  'deepseek-v4-pro': { input: ['text'], contextWindow: 1000000 },
  'deepseek-flash': { input: ['text', 'image'], contextWindow: 1000000 },
};
function normalizeId(id) {
  return String(id || '').toLowerCase().replace(/^local-/, '').replace(/^qwen-(\d)/, 'qwen$1');
}
function fields(row = {}) {
  const result = {};
  const cw = Number(row.contextWindow ?? row.context_window ?? row.context_length ?? row.max_model_len ?? row.limit?.context);
  if (Number.isInteger(cw) && cw >= 1024 && cw <= 10000000) result.contextWindow = cw;
  const input = row.input ?? row.input_modalities ?? row.modalities?.input ?? row.architecture?.input_modalities;
  if (Array.isArray(input) && input.includes('text')) result.input = input.includes('image') ? ['text', 'image'] : ['text'];
  const vision = row.vision ?? row.capabilities?.vision;
  if (!result.input && typeof vision === 'boolean') result.input = vision ? ['text', 'image'] : ['text'];
  return result;
}
function catalogMatch(id, rows) {
  const matches = rows.filter(r => normalizeId(r.id) === normalizeId(id));
  const values = matches.map(fields).filter(r => r.input || r.contextWindow);
  // Providers with conflicting limits are not interchangeable.
  const result = {};
  for (const key of ['input', 'contextWindow']) {
    const candidates = values.map(r => r[key]).filter(v => v !== undefined);
    if (candidates.length && candidates.every(v => JSON.stringify(v) === JSON.stringify(candidates[0]))) result[key] = candidates[0];
  }
  return result;
}
async function detect({ model, baseUrl, apiKey, catalog = async () => [], fetcher = fetch }) {
  const result = { ...(CATALOG[normalizeId(model)] || {}) };
  const sources = Object.fromEntries(Object.keys(result).map(k => [k, '内置官方资料']));
  let endpoint = {};
  try {
    const url = new URL(String(baseUrl).replace(/\/$/, '') + '/models');
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported URL');
    const response = await fetcher(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (response.ok) {
      const rows = (await response.json()).data;
      // Endpoint names must match exactly apart from case; no fuzzy alias match.
      const row = Array.isArray(rows) && rows.find(r => String(r.id).toLowerCase() === String(model).toLowerCase());
      if (row) endpoint = fields(row);
    }
  } catch { /* /models often returns IDs only, or is not implemented. */ }
  for (const key of Object.keys(endpoint)) { result[key] = endpoint[key]; sources[key] = '供应商 /models'; }
  if (!result.input || !result.contextWindow) {
    try {
      const matched = catalogMatch(model, await catalog());
      for (const key of ['input', 'contextWindow']) if (!result[key] && matched[key]) {
        result[key] = matched[key]; sources[key] = 'OpenClaw 模型目录';
      }
    } catch { /* Unknown models remain explicitly unresolved. */ }
  }
  return { ...result, sources, unresolved: ['input', 'contextWindow'].filter(k => !result[k]) };
}
module.exports = { detect, fields, normalizeId, catalogMatch, CATALOG };
