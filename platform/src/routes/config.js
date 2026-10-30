'use strict';

const express = require('express');
const store = require('../instances');
const confidential = require('../confidential');

const router = express.Router();

// Values remain server-side; unchanged masked lines restore their stored values.
function maskEnv(content) {
  return content.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const eq = t.indexOf('=');
    if (eq <= 0) return line;
    const key = t.slice(0, eq);
    return `${key}=****`;
  }).join('\n');
}

// A value the masker produced: "ab" + stars + "yz" (long values) or bare "****"
// (short values). PUT gets the masked text back from the editor, so those
// values must be replaced with the real on-disk values instead of being
// written as literal asterisks (which would silently destroy the secret).
const MASK_RE = /^.{0,2}\*{1,}.{0,2}$/;

function restoreMaskedEnv(incoming, stored) {
  const current = store.parseEnv(stored);
  const outLines = String(incoming).split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const eq = t.indexOf('=');
    if (eq <= 0) return line;
    const key = t.slice(0, eq);
    const val = t.slice(eq + 1);
    const maskedLine = maskEnv(`${key}=${current[key] || ''}`);
    if (key in current && t === maskedLine) {
      if (!(key in current)) return null; // masked value for a key we never stored — drop the line
      return `${key}=${current[key]}`;
    }
    return line;
  }).filter((l) => l !== null);
  return outLines.join('\n');
}

function requireInstance(req, res, next) {
  try {
    req.instance = store.loadInstance(req.params.id);
    next();
  } catch {
    res.status(404).json({ error: '实例不存在' });
  }
}

// ── openclaw.json ────────────────────────────────────────────────────────────
router.get('/:id/config', requireInstance, (req, res) => {
  const raw = store.readOpenclawConfig(req.instance.id);
  if (raw === null) return res.status(404).json({ error: '配置文件尚未生成' });
  res.json({ content: JSON.stringify(confidential.mask(JSON.parse(raw)), null, 2) + '\n', revision: store.revision(raw) });
});

router.put('/:id/config', express.json({ limit: '1mb' }), requireInstance, async (req, res) => {
  try {
    const old = store.readOpenclawConfig(req.instance.id);
    if (!req.body.revision) return res.status(428).json({ error: '请先重新加载配置' });
    if (req.body.revision !== store.revision(old)) return res.status(409).json({ error: '配置已被其他操作修改，请重新加载后合并' });
    let content = String(req.body.content || '');
    const parsed = confidential.restore(JSON.parse(content), JSON.parse(old || '{}'));
    content = JSON.stringify(parsed, null, 2) + '\n';
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置必须是对象');
    if (parsed.gateway?.auth?.token !== req.instance.gatewayToken) throw new Error('请保持 Gateway Token 不变；凭据轮换需要专门迁移');
    await require('../validation').validate(req.instance, content);
    if (!req.instance.configPending) store.atomicWrite(require('path').join(store.configDir(req.instance.id), 'openclaw.json.last-good'), old);
    store.writeOpenclawConfig(req.instance.id, content);
    store.saveInstance({ ...req.instance, configPending: true });
    res.json({ ok: true, content: JSON.stringify(confidential.mask(parsed), null, 2) + '\n', revision: store.revision(content), hint: '配置已校验并保存。部分配置需重启后生效。' });
  } catch (err) {
    res.status(400).json({ error: confidential.scrub(`保存失败: ${err.message}`, req.instance) });
  }
});

// ── .env ─────────────────────────────────────────────────────────────────────
router.get('/:id/env', requireInstance, (req, res) => {
  const raw = store.readEnvFile(req.instance.id);
  res.json({ content: maskEnv(raw), revision: store.revision(raw) });
});

router.put('/:id/env', express.json({ limit: '256kb' }), requireInstance, (req, res) => {
  try {
    const old = store.readEnvFile(req.instance.id);
    if (!req.body.revision) return res.status(428).json({ error: '请先重新加载环境变量' });
    if (req.body.revision !== store.revision(old)) return res.status(409).json({ error: '环境变量已修改，请重新加载后合并' });
    let content = String(req.body.content || '');
    const parsed = store.parseEnv(content);
    for (const key of Object.keys(parsed)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return res.status(400).json({ error: `非法变量名: ${key}` });
      }
    }
    // The GET view is masked; put the real values back for any masked lines so
    // an edit elsewhere in the file can't silently persist asterisks.
    content = restoreMaskedEnv(content, store.readEnvFile(req.instance.id));
    if (content.includes('__OPENCLAW_REDACTED__')) throw new Error('不能保存脱敏占位符');
    const finalEnv = store.parseEnv(content);
    if (finalEnv.OPENCLAW_GATEWAY_TOKEN !== req.instance.gatewayToken) throw new Error('请保持 Gateway Token 不变');
    if (!req.instance.envPending) store.atomicWrite(require('path').join(store.configDir(req.instance.id), '.env.last-good'), old);
    store.writeEnvFile(req.instance.id, content);
    store.saveInstance({ ...req.instance, envPending: content !== old || req.instance.envPending });
    res.json({ ok: true, content: maskEnv(content), revision: store.revision(content), hint: '环境变量已保存，重启时将安全重建容器以应用。' });
  } catch (err) {
    res.status(400).json({ error: confidential.scrub(`保存失败: ${err.message}`, req.instance) });
  }
});

module.exports = router;
