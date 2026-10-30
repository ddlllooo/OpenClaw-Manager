'use strict';

// The Gateway suspension lease fences native channels, cron and direct clients.
// Local admission gates alone cannot make that guarantee. Unknown/old protocols
// fall back to a bounded Docker stop, and are reported as a fallback.
function createGuard({read,write,usage,dm,rpc,now=Date.now,emit=()=>{}}) {
  const inflight=new Map();
  async function run(id) {
    const store=require('./instances');
    let u;
    try {u=await usage(id);}catch(error){
      const s=read(id);
      if(!s.policy.limitGiB&&!s.blocked&&!s.recovery)throw error;
      u={reason:'无法完整验证空间或硬配额，已触发存储保护',policy:s.policy};
    }
    let s=read(id);
    const admission=u.policy?.limitGiB>0 && u.percent!==null && u.percent>=u.policy.admissionPercent;
    if(!u.reason&&!s.blocked&&!s.recovery&&!s.drain&&!admission)return u;
    let record;
    try{record=store.loadInstance(id);}catch(error){
      if(s.hard?.backend!=='apfs-volume')throw error;
      // A missing/unmounted volume must not hide a still-running container.
      const row=(await dm.listContainersByLabel()).find(r=>r.instanceId===id&&r.state==='running');
      record={id,containerId:row?.containerId||null};
    }
    const emergency=Boolean(u.reason||s.recovery);
    const persist=()=>write(id,s);
    if(!s.drain){
      s.blocked ||= {at:new Date(now()).toISOString(),reason:u.reason||(s.recovery?'未完成的数据恢复':'数据容量达到停止接单阈值')};
      s.drain={phase:'requested',requestId:'storage-'+id+'-'+now(),startedAt:now(),deadlineAt:now()+Math.min(30,s.policy.drainSeconds||30)*1000};
    }
    // Preserve admission in memory even if the filesystem is completely full.
    let persistenceError;
    try{persist();}catch(e){persistenceError=e;}
    const c=record.containerId?await dm.inspectContainer(record.containerId).catch(e=>{if(e.statusCode===404)return null;throw e;}):null;
    async function stop(reason,interruptedPossible=false) {
      await require('./run-intent').stop(id,{reason:'storage',emergency:true});
      s=read(id);s.blocked ||= {at:new Date(now()).toISOString(),reason};
      s.drain={...s.drain,phase:'stopping',stopReason:reason,interruptedPossible};
      try{persist();}catch(e){persistenceError=e;}
      let policyError;
      if(c){
        try{await dm.getContainer(c.Id).update({RestartPolicy:{Name:'no'}});}catch(e){policyError=e;}
        if(c.State.Paused)throw Object.assign(new Error('实例已暂停，需先解除暂停以完成保护停机'),{statusCode:409});
        if(c.State.Running)await dm.stopContainer(c.Id,30);
        // Do not claim a completed stop based only on a successful API response.
        const after=await dm.inspectContainer(c.Id).catch(e=>{if(e.statusCode===404)return null;throw e;});
        if(after?.State?.Running)throw new Error('Docker 未确认实例停止，保护锁定保留并将在下次检测重试');
      }
      s=read(id);s.drain={...s.drain,phase:'stopped',stoppedAt:s.drain?.stoppedAt||now(),stopReason:reason,interruptedPossible};
      if(policyError)s.drain.warning='实例已停止，但禁用自动重启失败，将持续重试';
      else delete s.drain.warning;
      try{persist();}catch(e){persistenceError=e;}
      emit('storage',{id,status:'blocked',phase:'stopped',reason,interruptedPossible});
      if(policyError)throw policyError;
      if(persistenceError)throw persistenceError;
      return {...u,blocked:s.blocked,drain:s.drain};
    }
    if(!c||!c.State.Running)return stop(s.drain.stopReason||s.blocked.reason,Boolean(s.drain.interruptedPossible));
    if(persistenceError)return stop('存储保护记录无法落盘，已停止实例',true);
    if(emergency)return stop(u.reason||'未完成的数据恢复',true);
    if(s.drain.phase==='stopped'||s.drain.phase==='stopping')return stop(s.blocked.reason,true);
    if(now()>=s.drain.deadlineAt)return stop('存储收尾等待已到时，任务可能未完成',true);
    let result;
    try {
      result=s.drain.suspensionId
        ? await rpc(record,'gateway.suspend.status',{suspensionId:s.drain.suspensionId},{timeout:3000})
        : await rpc(record,'gateway.suspend.prepare',{requestId:s.drain.requestId,drain:true,terminalPolicy:'terminate'},{timeout:3000});
      if(!['ready','draining'].includes(result?.status)||typeof (result.suspensionId||s.drain.suspensionId)!=='string'||!Number.isFinite(result.expiresAtMs)||result.expiresAtMs<=now()+1000)throw new Error('不支持或无法确认 Gateway 全局停止接单协议');
      if(result.status==='ready'&&result.activeCount!==undefined&&result.activeCount!==0)throw new Error('Gateway 就绪结果仍报告活动任务');
      s=read(id);s.drain={...s.drain,phase:'draining',supported:true,suspensionId:result.suspensionId||s.drain.suspensionId,expiresAt:result.expiresAtMs,
        deadlineAt:Math.min(s.drain.deadlineAt,result.expiresAtMs-5000),activeCount:result.activeCount??null};persist();
    } catch(error) {
      // Do not leave a partially acquired lease running until it expires and
      // reopens native ingress. A failed/unknown handshake triggers stop now.
      s=read(id);s.drain={...s.drain,supported:false,fallbackReason:'运行中的 Gateway 不支持或未确认全局收尾接口'};
      try{persist();}catch(e){persistenceError=e;}
      return stop('无法确认全局停止接单，已使用有时限的停机流程',true);
    }
    if(result.status==='ready')return stop('任务收尾完成，已保护停机',false);
    emit('storage',{id,status:'draining',deadlineAt:s.drain.deadlineAt,activeCount:s.drain.activeCount});
    return {...u,blocked:s.blocked,drain:s.drain};
  }
  function enforce(id){
    if(inflight.has(id))return inflight.get(id);
    const task=run(id).finally(()=>{if(inflight.get(id)===task)inflight.delete(id);});
    inflight.set(id,task);return task;
  }
  return {enforce};
}
module.exports={createGuard};
