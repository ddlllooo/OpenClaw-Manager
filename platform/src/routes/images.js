'use strict';

const express = require('express');
const dockermod = require('../docker');
const monitor = require('../monitor');

const router = express.Router();
const tasks = new Map();
const owner = req => /(?:^|;\s*)openclaw_manager_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1] || '';
router.get('/cleanup/history', (req,res,next) => {
  try {
    const {limit,cursor} = req.query;
    if ((limit !== undefined && (typeof limit !== 'string' || !/^\d{1,2}$/.test(limit))) ||
        (cursor !== undefined && typeof cursor !== 'string')) return res.status(400).json({error:'历史分页参数无效'});
    res.json(require('../retention').history({limit:limit === undefined ? 10 : Number(limit),cursor:cursor || ''}));
  } catch (err) { next(err); }
});
router.get('/cleanup/preview', async (req, res, next) => {
  try { res.json(await require('../retention').preview(owner(req))); } catch (err) { next(err); }
});
router.post('/cleanup', express.json(), async (req, res, next) => {
  try {
    const previewId = req.body?.previewId;
    if (typeof previewId !== 'string' || !/^[a-f0-9]{48}$/.test(previewId)) return res.status(400).json({ error:'请先生成清理预览，再执行清理' });
    const result = await require('../retention').execute(previewId, owner(req));
    monitor.broadcast('lifecycle', { id:'image-store', action:'manual-cleanup', removedImages:result.removedImages.length, removedContainers:result.removedContainers.length });
    res.json(result);
  } catch (err) { next(err); }
});
router.get('/retention', (req, res) => res.json(require('../retention').status()));
router.get('/tasks', (req, res) => res.json({ tasks: [...tasks.values()] }));

// GET /api/images — local image store (what "离线部署" will use)
router.get('/', async (req, res, next) => {
  try {
    const images = await dockermod.listLocalImages();
    const defaultCached = await dockermod.imageExists(dockermod.DEFAULT_IMAGE);
    res.json({
      images,
      defaultImage: dockermod.DEFAULT_IMAGE,
      defaultImageCached: defaultCached,
      retention: require('../retention').status(),
    });
  } catch (err) { next(err); }
});

// POST /api/images/pull { image } — pre-download into local store with SSE progress
router.post('/pull', express.json(), async (req, res, next) => {
  try {
    const image = String(req.body.image || dockermod.DEFAULT_IMAGE).trim();
    if (!image) return res.status(400).json({ error: '镜像名称不能为空' });

    if (await dockermod.imageExists(image)) {
      return res.json({ ok: true, cached: true, hint: '镜像已存在于本地，无需下载' });
    }

    if (tasks.get(image)?.status === 'running') return res.status(409).json({ error: '该镜像已在下载中' });
    const task = { image, status: 'running', startedAt: Date.now() };
    tasks.set(image, task);
    if (tasks.size > 100) for (const [key, value] of tasks) { if (value.status !== 'running') { tasks.delete(key); break; } }
    // Respond immediately; progress goes over SSE so the UI can show it live.
    res.json({ ok: true, cached: false, hint: '开始下载镜像，进度请见事件流' });
    monitor.broadcast('pull', { id: 'image-store', image, status: 'started' });
    try {
      await dockermod.pullImage(image, (evt) => {
        monitor.broadcast('pull', {
          id: 'image-store',
          image,
          status: evt.status || 'progress',
          layer: evt.id || null,
          current: evt.progressDetail && evt.progressDetail.current,
          total: evt.progressDetail && evt.progressDetail.total,
          progress: evt.progress || null,
        });
      });
      task.status = 'done'; task.finishedAt = Date.now();
      monitor.broadcast('pull', { id: 'image-store', image, status: 'done' });
    } catch (err) {
      task.status = 'error'; task.error = dockermod.shortDockerError(err); task.finishedAt = Date.now();
      monitor.broadcast('pull', { id: 'image-store', image, status: 'error', error: dockermod.shortDockerError(err) });
    }
  } catch (err) { next(err); }
});

// Legacy direct deletion cannot bypass the same preview/reference protections.
router.delete('/:tag', (req, res) => res.status(409).json({
  error: '请先查看清理预览，再使用手动清理；直接删除可能移除必要的回滚版本',
}));

module.exports = router;
