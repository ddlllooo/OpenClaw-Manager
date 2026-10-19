'use strict';
const router=require('express').Router();
// Avoid loading SSH crypto and transfer dependencies on ordinary local startup.
let service;
const ssh=()=>{service||=require('../ssh-connections');service.start();return service;};
router.get('/context',(req,res)=>res.json(require('../device-context').context(ssh().connections)));
router.get('/',(req,res)=>res.json({connections:[...ssh().connections.values()].map(ssh().view)}));
router.get('/local-images',async(req,res,next)=>{try{res.json({images:await require('../image-transfer').localImages()});}catch(e){next(e);}});
router.post('/probe',async(req,res,next)=>{try{res.json(await ssh().probe(req.body||{}));}catch(e){next(e);}});
router.post('/',(req,res,next)=>{try{res.status(202).json(ssh().connect({save:true,autoReconnect:true,...req.body}));}catch(e){next(e);}});
router.post('/:id/reconnect',(req,res,next)=>{try{const row=ssh().connections.get(req.params.id);if(!row)return res.status(404).json({error:'连接不存在'});res.status(202).json(ssh().reconnect(row));}catch(e){next(e);}});
router.patch('/:id',(req,res,next)=>{try{const row=ssh().connections.get(req.params.id);if(!row)return res.status(404).json({error:'连接不存在'});res.json(ssh().edit(row,req.body||{}));}catch(e){next(e);}});
router.delete('/:id/saved',(req,res,next)=>{try{const row=ssh().connections.get(req.params.id);if(!row)return res.status(404).json({error:'连接不存在'});ssh().forget(row);res.json({ok:true});}catch(e){next(e);}});
router.post('/:id/images/transfer',(req,res,next)=>{
  try{const record=ssh().connections.get(req.params.id);if(!record)return res.status(404).json({error:'连接不存在'});
    res.status(202).json({transfer:require('../image-transfer').start(record,req.body)});
  }catch(e){next(e);}
});
router.post('/:id/images/cancel',(req,res)=>{
  const record=ssh().connections.get(req.params.id);
  if(!record)return res.status(404).json({error:'连接不存在'});
  if(record.transfer?.status==='running')record.transfer.controller.abort();
  res.json({ok:true});
});
router.post('/:id/deploy-offline',(req,res,next)=>{
  try{const record=ssh().connections.get(req.params.id);if(!record)return res.status(404).json({error:'连接不存在'});res.status(202).json(ssh().deployOffline(record));}catch(e){next(e);}
});
router.delete('/:id',(req,res,next)=>{try{
  const row=ssh().connections.get(req.params.id);if(!row)return res.status(404).json({error:'连接不存在'});
  ssh().close(row);res.json(ssh().view(row));}catch(e){next(e);}
});
router.startConnections=()=>ssh();
router.closeConnections=()=>service?.closeAll();
module.exports=router;
