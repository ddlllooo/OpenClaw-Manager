'use strict';
const express = require('express');
const store = require('../instances');
const storage = require('../storage');
const router = express.Router();
router.use('/:id/storage', (req,res,next) => {
  try { store.loadInstance(req.params.id); next(); }
  catch { res.status(404).json({error:'实例不存在'}); }
});
const handle = fn => async (req,res,next) => { try { res.json(await fn(req)); } catch(e) { next(e); } };
router.get('/:id/storage',handle(req=>storage.usage(req.params.id)));
router.get('/:id/storage/capabilities',handle(req=>require('../storage-quota').probe(req.params.id)));
router.post('/:id/storage/quota/verify',handle(async req=>{
  const quota=await require('../storage-quota').status(req.params.id,true),current=await storage.usage(req.params.id);
  if(!quota.verified||!current.hardQuota)throw Object.assign(new Error('实际硬配额与登记或平台策略不符，未通过验证'),{statusCode:409});
  return quota;
}));
router.patch('/:id/storage/policy',handle(async req=>{
  await storage.configurePolicy(req.params.id,req.body);
  return storage.enforce(req.params.id);
}));
router.post('/:id/storage/release',handle(async req=>{await storage.release(req.params.id);return {ok:true,hint:'存储保护已解除，可以手动启动实例'};}));
router.post('/:id/storage/drain',handle(req=>storage.beginDrain(req.params.id)));
router.get('/:id/storage/cleanup',handle(req=>storage.cleanupPreview(req.params.id)));
router.post('/:id/storage/cleanup',handle(req=>storage.cleanup(req.params.id,req.body?.revision)));
router.get('/:id/storage/backups',handle(req=>({backups:storage.listBackups(req.params.id)})));
router.post('/:id/storage/backups',handle(req=>storage.snapshot(req.params.id)));
router.post('/:id/storage/backups/:name/verify',handle(req=>storage.verify(req.params.id,req.params.name)));
router.post('/:id/storage/backups/:name/restore',handle(req=>storage.restore(req.params.id,req.params.name)));
router.delete('/:id/storage/backups/:name',handle(req=>storage.deleteBackup(req.params.id,req.params.name)));
router.get('/:id/storage/diagnostics',handle(req=>storage.diagnostics(req.params.id)));
router.post('/:id/storage/repair-config',handle(req=>storage.repairConfig(req.params.id,req.body?.source)));
router.post('/:id/storage/rollback',handle(async req=>{await storage.rollback(req.params.id);return {ok:true,hint:'未完成的恢复已回滚，实例保持停止'};}));
module.exports=router;
