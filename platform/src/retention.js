'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const historyStore = require('./cleanup-history');
const { imagePurpose } = require('./image-purpose');
const policy = { enabled: true, instanceRollbackVersions: 1, managerPreviousVersions: 1, healthStableSeconds: 30 };
const digest = value => /^sha256:[a-f0-9]{64}$/.test(value || '');
const repo = tag => String(tag).replace(/@.*$/, '').replace(/:[^/:]+$/, '');
const name = c => (c.Name || c.Names?.[0] || '').replace(/^\//, '');
const labels = c => c.Config?.Labels || c.Labels || {};
const stopped = c => c.State?.Running === false && ['exited', 'created', 'dead'].includes(c.State.Status);

function createRetention(options = {}) {
  const dm = options.dm || require('./docker');
  const store = options.store || require('./instances');
  const guard = options.guard || require('./maintenance-guard');
  const now = options.now || Date.now;
  const env = options.env || process.env;
  const isBusy = options.isBusy || (() => require('./operations').busy.size > 0 || require('./resource-planner').pending.size > 0);
  const file = () => path.join(options.home || path.dirname(store.instancesRoot()), 'retention-state.json');
  let timer = null, timerRunning = false, observed = null, managerReady = false, stoppedLoop = true;
  const previews = new Map();
  const failure = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
  function load() {
    if (!fs.existsSync(file())) return { version: 1, managers: {}, retired: [], pendingInstances: {}, pending: false, lastRun: null };
    const state = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (state.version !== 1 || !state.managers || typeof state.managers !== 'object' || Array.isArray(state.managers) || !Array.isArray(state.retired) ||
        !state.retired.every(r => digest(r.id) && ['manager', 'runtime'].includes(r.kind)) ||
        !Object.values(state.managers).every(m => m && digest(m.current) && digest(m.previous) && Array.isArray(m.families) && m.families.every(f => typeof f === 'string'))) throw new Error('自动清理记录损坏，已停止清理');
    return state;
  }
  function save(state) { store.atomicWrite(file(), JSON.stringify(state, null, 2)); }
  function audit(report) {
    report.completedAt = new Date(now()).toISOString();
    historyStore.append(path.dirname(file()), report);
  }
  function history(query) { return historyStore.read(path.dirname(file()), query); }
  function detail(item) { return {type:item.type,id:item.id,name:item.name,...(item.tags?{tags:item.tags}:{}),...(item.instanceName?{instanceName:item.instanceName}:{})}; }
  function rejected(reason) {
    audit({at:new Date(now()).toISOString(),source:'manual',trigger:{kind:'manual-cleanup'},state:'skipped',
      removedImages:[],removedContainers:[],deletedImages:[],deletedContainers:[],skipped:[{type:'operation',name:'手动清理',reason}],errors:[]});
    return Object.assign(failure(reason),{historyRecorded:true});
  }
  function status() {
    try { const s = load(); return { policy, pending: s.pending, managers: s.managers, lastRun: s.lastRun }; }
    catch (e) { return { policy, pending: false, error: e.message }; }
  }
  function recordSuccess(instance) {
    const s = load();
    s.pending = true;
    s.pendingInstances ||= {};
    s.pendingInstances[instance.id] = instance.containerId;
    s.trigger = { kind: 'instance-upgrade', id: instance.id, containerId: instance.containerId, at: now() };
    save(s);
    // Defer until the lifecycle/HTTP operation releases its own operation lock.
    if (timer) { clearTimeout(timer); timer = setTimeout(loop, 0); timer.unref(); }
  }
  function readRecords() {
    if (options.readRecords) return options.readRecords();
    const active = store.listInstanceIds().map(id => store.loadInstance(id));
    const archived = [];
    for (const entry of fs.readdirSync(store.instancesRoot(), { withFileTypes: true })) {
      if (!entry.name.endsWith('.kept')) continue;
      const target = path.join(store.instancesRoot(), entry.name, 'instance.json');
      if (fs.existsSync(target)) archived.push(JSON.parse(fs.readFileSync(target, 'utf8')));
    }
    return { active, all: [...active, ...archived] };
  }
  async function inspectImage(ref) {
    try { return await dm.docker.getImage(ref).inspect(); }
    catch (e) { if (e.statusCode === 404) return null; throw e; }
  }
  async function snapshot() {
    const containers = [];
    for (const c of await dm.docker.listContainers({ all: true })) {
      try { containers.push(await dm.inspectContainer(c.Id)); }
      catch (e) { if (e.statusCode !== 404) throw e; }
    }
    return { containers, ...readRecords() };
  }
  function queue(s, id, kind) {
    if (digest(id) && !s.retired.some(r => r.id === id)) s.retired.push({ id, kind, at: now() });
  }
  async function ready(r, c) {
    if (!c?.State?.Running || (c.State.Health && c.State.Health.Status !== 'healthy') || r.envPending || r.configPending) return false;
    if (options.checkReady) return options.checkReady(r, c);
    return require('./lifecycle').ready(r.port, 3000);
  }
  async function observeManager(s) {
    managerReady = false;
    if (env.MANAGER_CONTAINERIZED !== '1') return false;
    const host = String(env.HOSTNAME || '');
    if (!/^[a-f0-9]{12,64}$/.test(host)) return false;
    const rows = await dm.docker.listContainers({ all: true });
    const own = rows.filter(c => c.Id.startsWith(host) && labels(c)['openclaw.manager'] === 'true');
    if (own.length !== 1) return false;
    const c = await dm.inspectContainer(own[0].Id);
    if (!c.State.Running || c.State.Health?.Status !== 'healthy') { observed = null; return false; }
    const key = `${c.Id}:${c.State.StartedAt}`;
    if (!observed || observed.key !== key) { observed = { key, since: now() }; return false; }
    if (now() - observed.since < policy.healthStableSeconds * 1000) return false;
    managerReady = true;
    const deployment = labels(c)['openclaw.deployment'];
    if (!deployment) return false;
    const existing = s.managers[deployment];
    if (existing?.current === c.Image) {
      if (existing.containerId !== c.Id) { existing.containerId = c.Id; save(s); }
      return false;
    }
    const current = await inspectImage(c.Image);
    if (!current) throw new Error('当前 Manager 镜像不可检查');
    let previousId = existing?.current;
    if (!previousId && env.OPENCLAW_PREVIOUS_MANAGER_IMAGE) previousId = (await inspectImage(env.OPENCLAW_PREVIOUS_MANAGER_IMAGE))?.Id;
    if (!previousId || previousId === c.Image) return false; // Never guess a previous successful build.
    const previous = await inspectImage(previousId);
    if (!previous || imagePurpose(previous.RepoTags || [], previous.Config?.Labels || {}).kind !== 'manager') return false;
    const families = (current.RepoTags || []).map(repo).filter(r => (previous.RepoTags || []).some(t => repo(t) === r));
    if (!families.length) return false;
    if (existing?.previous) queue(s, existing.previous, 'manager');
    s.managers[deployment] = { current: c.Image, previous: previousId, families, verifiedAt: now(), containerId: c.Id };
    // On first adoption, older versions in this exact Manager repository can
    // retire only after a declared previous version is verified and protected.
    for (const image of await dm.docker.listImages({ all: true })) {
      if (image.Id === c.Image || image.Id === previousId) continue;
      if ((image.RepoTags || []).length && image.RepoTags.every(t => families.includes(repo(t)))) {
        // listImages timestamps have only second precision. Inspect before
        // ordering builds that may have been produced within the same second.
        const detail = await inspectImage(image.Id);
        if (detail && Date.parse(detail.Created) < Date.parse(previous.Created)) queue(s, image.Id, 'manager');
      }
    }
    s.pending = true; s.trigger = { kind: 'manager-upgrade', deployment, at: now() };
    save(s);
    return true;
  }
  async function imageReferences(s, snap, excludeContainers = new Set()) {
    const refs = new Map();
    const add = (id, reason) => { if (!refs.has(id)) refs.set(id, new Set()); refs.get(id).add(reason); };
    for (const c of snap.containers) if (!excludeContainers.has(c.Id)) add(c.Image, `被容器 ${name(c)} 引用（${c.State.Status}）`);
    for (const m of Object.values(s.managers)) { add(m.current, '当前已验证的 Manager 版本'); add(m.previous, '保留上一版 Manager 用于回滚'); }
    for (const r of snap.all) {
      for (const ref of [r.image, r.rollbackImage]) {
        if (!ref) continue;
        if (digest(ref)) add(ref, `被实例或归档记录 ${r.name || r.id} 引用`);
        const image = await inspectImage(ref);
        if (image) add(image.Id, `被实例或归档记录 ${r.name || r.id} 引用`);
      }
    }
    return refs;
  }
  function rollbackTime(c, r) {
    const prefix = `${r.containerName}-rollback-`;
    const n = name(c);
    if (labels(c)['openclaw.managed'] !== 'true' || labels(c)['openclaw.instance'] !== r.id || !n.startsWith(prefix)) return null;
    const suffix = n.slice(prefix.length);
    return /^\d{13}$/.test(suffix) ? Number(suffix) : null;
  }
  async function buildPlan(s) {
    const snap = await snapshot();
    const health = new Map();
    for (const r of snap.active) health.set(r.id, await ready(r, snap.containers.find(c => c.Id === r.containerId)));
    const containers = [];
    const containerRefs = new Set(snap.all.flatMap(r => [r.containerId, r.rollbackContainerId]));
    for (const c of snap.containers.filter(c => name(c).includes('-rollback-'))) {
      const r = snap.active.find(r => rollbackTime(c, r) !== null);
      const reasons = [];
      if (!r) reasons.push('没有可验证的活动实例或容器归属，保守保留');
      if (containerRefs.has(c.Id)) reasons.push('被活动实例或归档记录引用');
      if (!stopped(c)) reasons.push('容器仍在运行或当前状态不允许删除');
      const copies = r ? snap.containers.filter(x => rollbackTime(x, r) !== null).sort((a,b) => rollbackTime(b,r)-rollbackTime(a,r)) : [];
      if (copies[0]?.Id === c.Id) reasons.push('每个实例保留最近一个回滚版本');
      if (r && !health.get(r.id)) reasons.push('当前实例未通过健康检查或配置尚未应用');
      const primary = r && snap.containers.find(x => x.Id === r.containerId);
      containers.push({ type:'rollback', id:c.Id, name:name(c), imageId:c.Image, state:c.State.Status,
        instanceId:r?.id || labels(c)['openclaw.instance'] || '', instanceName:r?.name || r?.id || '',
        decision:reasons.length?'keep':'delete', reasons:reasons.length?reasons:['已被较新的回滚版本替代，且没有记录引用'],
        primaryContainerId:r?.containerId || null, primaryStartedAt:primary?.State.StartedAt || null, rollbackContainerId:r?.rollbackContainerId || null });
    }
    const removing = new Set(containers.filter(c => c.decision==='delete').map(c => c.id));
    const imageRefs = await imageReferences(s, snap, removing);
    const eligible = new Map(s.retired.map(i => [i.id,i.kind]));
    for (const c of containers.filter(c => c.decision==='delete')) eligible.set(c.imageId,'runtime');
    const images = [];
    for (const summary of await dm.docker.listImages({all:true})) {
      const i = await inspectImage(summary.Id);
      if (!i) continue;
      const tags = (i.RepoTags || []).filter(t => t!=='<none>:<none>').sort();
      const kind = eligible.get(i.Id);
      const purpose = imagePurpose(tags,i.Config?.Labels || {});
      const reasons = [...(imageRefs.get(i.Id) || [])];
      if (!kind) reasons.push('未被成功升级流程标记为淘汰，保留本地镜像');
      else {
        if (purpose.kind !== (kind==='manager'?'manager':'runtime')) reasons.push('镜像归属无法确认，保守保留');
        if (kind==='runtime' && tags.some(t => imagePurpose([t]).kind!=='runtime')) reasons.push('含有无法确认归属的镜像标签');
        if (kind==='manager' && (tags.length?tags:[i.Id]).some(t => !Object.values(s.managers).some(m => m.families.includes(repo(t))))) reasons.push('Manager 镜像仓库归属不匹配');
      }
      images.push({ type:'image', id:i.Id, tags, name:tags.join(' / ') || i.Id, sizeBytes:summary.Size ?? i.Size ?? 0,
        decision:reasons.length?'keep':'delete', reasons:reasons.length?reasons:['已淘汰的旧镜像，清理旧回滚容器后无剩余引用'],
        dependsOn:containers.filter(c => c.imageId===i.Id && removing.has(c.id)).map(c => c.id).sort() });
    }
    containers.sort((a,b)=>a.id.localeCompare(b.id)); images.sort((a,b)=>a.id.localeCompare(b.id));
    const references = snap.all.map(r=>({id:r.id,containerId:r.containerId,rollbackContainerId:r.rollbackContainerId,image:r.image,rollbackImage:r.rollbackImage,envPending:r.envPending,configPending:r.configPending}))
      .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const stamp = crypto.createHash('sha256').update(JSON.stringify({containers,images,references,managers:s.managers})).digest('hex');
    return {snap,health,containers,images,stamp};
  }
  function manualManagerReady(s, snap) {
    if (env.MANAGER_CONTAINERIZED !== '1') return true;
    const host=String(env.HOSTNAME || '');
    if (!/^[a-f0-9]{12,64}$/.test(host)) return false;
    const own=snap.containers.filter(c=>c.Id.startsWith(host) && labels(c)['openclaw.manager']==='true');
    if (own.length!==1) return false;
    const c=own[0],m=s.managers[labels(c)['openclaw.deployment']];
    return Boolean(c.State.Running && c.State.Health?.Status==='healthy' && m?.current===c.Image);
  }
  function publicPlan(s,p) {
    const blockedReason = !manualManagerReady(s,p.snap) ? 'Manager 尚未完成升级健康验证，请稍后刷新预览' :
      guard.active || isBusy() ? '平台有变更或清理操作进行中，请稍后重新预览' : null;
    const count=(items,decision)=>items.filter(i=>i.decision===decision).length;
    return {policy,images:p.images,containers:p.containers,blockedReason,
      summary:{deleteImages:count(p.images,'delete'),keepImages:count(p.images,'keep'),deleteContainers:count(p.containers,'delete'),keepContainers:count(p.containers,'keep')}};
  }
  async function preview(owner='') {
    const s=load(),p=await buildPlan(s),view=publicPlan(s,p);
    const previewId=crypto.randomBytes(24).toString('hex'),expiresAt=now()+5*60*1000;
    for (const [key,value] of previews) if (value.expiresAt<=now()) previews.delete(key);
    while(previews.size>=16)previews.delete(previews.keys().next().value);
    previews.set(previewId,{owner:crypto.createHash('sha256').update(owner).digest('hex'),expiresAt,stamp:p.stamp,view});
    return {...view,previewId,createdAt:new Date(now()).toISOString(),expiresAt:new Date(expiresAt).toISOString()};
  }
  async function execute(previewId,owner='') {
    const reviewed=previews.get(previewId);
    if (!reviewed || reviewed.expiresAt<=now() || reviewed.owner!==crypto.createHash('sha256').update(owner).digest('hex')) throw failure('清理预览已过期或不属于当前会话，请重新预览');
    const result=await guard.clean(isBusy,async()=>{
      const s=load(),fresh=await buildPlan(s);
      if (!manualManagerReady(s,fresh.snap)) throw rejected('Manager 尚未完成健康验证，请稍后重新预览');
      if(fresh.stamp!==reviewed.stamp)throw rejected('引用或容器状态已变化，请刷新清理预览后重试');
      previews.delete(previewId);
      s.trigger={kind:'manual-cleanup',at:now()};
      try { return await sweep(s,fresh,'manual'); }
      catch (e) {
        s.pending=true;s.retryAfter=now()+60000;
        s.lastRun={...(s.lastRun?.state==='running'?s.lastRun:{at:new Date(now()).toISOString(),removedContainers:[],removedImages:[]}),
          source:'manual',trigger:s.trigger,state:'partial',error:historyStore.reason(e)};
        save(s);audit(s.lastRun);return s.lastRun;
      }
    }).catch(e=>{
      if(!e.historyRecorded) audit({at:new Date(now()).toISOString(),source:'manual',trigger:{kind:'manual-cleanup'},state:'failed',error:historyStore.reason(e)});
      throw e;
    });
    if(result?.deferred)throw rejected('平台有变更、镜像拉取或清理操作进行中，请稍后重试');
    return result;
  }
  async function sweep(s, reviewed=null, source='automatic') {
    const report = { at:new Date(now()).toISOString(), source, trigger:s.trigger, removedContainers:[], removedImages:[],
      deletedContainers:[],deletedImages:[],removedTags:[],skipped:[], errors:[], state:'running' };
    s.lastRun=report;
    const plan=reviewed || await buildPlan(s);
    for(const item of [...plan.images,...plan.containers].filter(i=>i.decision==='keep')) report.skipped.push({...detail(item),reason:item.reasons.join('；')});
    s.pendingInstances ||= {};
    for(const [id,containerId] of Object.entries(s.pendingInstances)) {
      if(!plan.snap.active.some(r=>r.id===id && r.containerId===containerId) || plan.health.get(id))delete s.pendingInstances[id];
      else report.skipped.push({type:'instance',id,name:plan.snap.active.find(r=>r.id===id)?.name || id,reason:'等待升级实例通过健康检查'});
    }
    for(const candidate of plan.containers.filter(c=>c.decision==='delete')) {
      const fresh=await buildPlan(s),actual=fresh.containers.find(c=>c.id===candidate.id);
      if(!actual || actual.decision!=='delete' || ['name','imageId','primaryContainerId','primaryStartedAt','rollbackContainerId'].some(k=>actual[k]!==candidate[k])) {
        report.skipped.push({...detail(candidate),reason:actual?.reasons?.join('；') || '引用或状态发生变化，保留'});continue;
      }
      queue(s,candidate.imageId,'runtime');save(s);
      try {await dm.docker.getContainer(candidate.id).remove({force:false,v:false});report.removedContainers.push(candidate.id);report.deletedContainers.push(detail(candidate));save(s);}
      catch(e){const row={...detail(candidate),status:e.statusCode || 500,reason:historyStore.reason(e)};if(e.statusCode===404)report.skipped.push(row);else report.errors.push(row);}
    }
    for(const candidate of plan.images.filter(i=>i.decision==='delete')) {
      const refs=candidate.tags.length?candidate.tags:[candidate.id];
      const remaining=new Set(candidate.tags);
      let removedAny=false;
      for(const ref of refs) {
        const fresh=await buildPlan(s),actual=fresh.images.find(i=>i.id===candidate.id);
        if(!actual){report.skipped.push({...detail(candidate),reason:'镜像已不存在，无需重复删除'});break;}
        const actualReferences=await imageReferences(s,fresh.snap);
        if(actualReferences.has(candidate.id) || actual.decision!=='delete' || JSON.stringify(actual.tags)!==JSON.stringify([...remaining].sort())) {
          report.skipped.push({...detail(candidate),reason:[...(actualReferences.get(candidate.id) || []),...(actual.reasons || []),'镜像引用或标签发生变化，保留'].join('；')});break;
        }
        const current=await inspectImage(ref);
        if(!current || current.Id!==candidate.id){report.skipped.push({...detail(candidate),reason:'镜像标签指向已变化或已不存在，保留'});break;}
        try {await dm.docker.getImage(ref).remove({force:false,noprune:true});removedAny=true;remaining.delete(ref);if(candidate.tags.length)report.removedTags.push({...detail(candidate),name:ref,reason:'标签已移除'});}
        catch(e){const row={...detail(candidate),status:e.statusCode || 500,reason:historyStore.reason(e)};if(e.statusCode===404)report.skipped.push(row);else report.errors.push(row);break;}
      }
      if(removedAny && !await inspectImage(candidate.id) && remaining.size===0){report.removedImages.push(candidate.id);report.deletedImages.push(detail(candidate));s.retired=s.retired.filter(r=>r.id!==candidate.id);}
    }
    const waiting=Object.keys(s.pendingInstances).length>0;
    s.pending=report.errors.length>0 || waiting;s.retryAfter=s.pending?now()+(report.errors.length?60000:15000):0;
    report.state=report.errors.length?'partial':waiting?'waiting':'completed';
    s.lastRun=report;save(s);audit(report);return report;
  }
  async function tick() {
    const initial = load();
    // No Docker calls or mutation gate on ordinary, already-verified restarts.
    if (!initial.pending && Object.values(initial.managers).some(m => m.containerId?.startsWith(env.HOSTNAME || '!'))) return { idle: true };
    return guard.clean(isBusy, async () => {
      const s = load();
      await observeManager(s);
      if (env.MANAGER_CONTAINERIZED === '1' && !managerReady) return { waitingForManagerHealth: true };
      if (!s.pending || (s.retryAfter || 0) > now()) return { idle: true };
      try { return await sweep(s); }
      catch (e) {
        s.pending = true; s.retryAfter = now() + 60000;
        s.lastRun = { ...(s.lastRun?.state === 'running' ? s.lastRun : { at: new Date(now()).toISOString(), removedContainers: [], removedImages: [] }),
          source:'automatic',trigger:s.trigger,state: 'partial', error: historyStore.reason(e) };
        save(s); audit(s.lastRun);
        return s.lastRun;
      }
    });
  }
  async function loop() {
    if (timerRunning) return;
    timerRunning = true;
    try { await tick(); } catch { console.warn('自动清理暂缓，请查看镜像管理中的状态'); }
    finally { timerRunning = false; if (!stoppedLoop) { timer = setTimeout(loop, 15000); timer.unref(); } }
  }
  function start() { stoppedLoop = false; if (!timer) { timer = setTimeout(loop, 15000); timer.unref(); } }
  function stop() { stoppedLoop = true; if (timer) clearTimeout(timer); timer = null; }
  return { status, recordSuccess, tick, start, stop, preview, execute, history };
}

let singleton;
function instance() { return singleton ||= createRetention(); }
module.exports = { createRetention, policy, status: () => instance().status(),
  history: query => instance().history(query),
  preview: owner => instance().preview(owner), execute: (id, owner) => instance().execute(id, owner),
  instanceSucceeded: value => instance().recordSuccess(value), start: () => instance().start(), stop: () => singleton?.stop() };
