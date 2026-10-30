'use strict';

// Portable accounting plus verified host XFS quotas and a bounded drain guard.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const tar = require('tar-stream');
const { pipeline } = require('stream/promises');
const store = require('./instances');
const GiB = 1024 ** 3;
const folders = { openclaw: '/home/node/.openclaw', workspace: '/home/node/.openclaw/workspace', auth: '/home/node/.config/openclaw' };
const defaults = { mode:'soft',limitGiB:0,warnPercent:80,admissionPercent:90,stopPercent:95,minFreeGiB:1,drainSeconds:30,hardInodes:100000 };
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const home = () => path.join(path.dirname(store.instancesRoot()), 'storage');
const backupRoot = () => process.env.OPENCLAW_INSTANCE_BACKUP_DIR || path.join(path.dirname(store.instancesRoot()), 'instance-backups');
const volatileBlocks = new Map();
const inside = (root, target) => { const r = path.relative(path.resolve(root), path.resolve(target)); return !r || (!r.startsWith('..') && !path.isAbsolute(r)); };

function safe(target) {
  const full = path.resolve(target), parsed = path.parse(full);
  let current = parsed.root;
  for (const part of full.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw fail('存储路径包含符号链接，已拒绝操作'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return full;
}
function stateFile(id) { store.instanceDir(id); return safe(path.join(home(), id + '.json')); }
function state(id) {
  try {
    const value=JSON.parse(fs.readFileSync(stateFile(id), 'utf8'));
    if(!value || Array.isArray(value) || typeof value!=='object' || !value.policy || (value.blocked && typeof value.blocked!=='object') || (value.recovery && !/^[a-f0-9]{24}$/.test(value.recovery)))throw fail('存储策略或恢复记录损坏，请检查管理数据');
    normalize(value.policy); value.blocked ||= volatileBlocks.get(id) || null; return value;
  }
  catch (e) { if (e.code === 'ENOENT') return { policy: { ...defaults }, blocked: volatileBlocks.get(id) || null }; throw e; }
}
function reserveFile() { return safe(path.join(home(),'.emergency-reserve')); }
function prepareReserve() {
  try {
    fs.mkdirSync(safe(home()),{recursive:true,mode:0o700});
    if(!fs.existsSync(reserveFile()) && require('./runtime-platform').diskInfo(home())?.available > 4*1024**2)fs.writeFileSync(reserveFile(),Buffer.alloc(1024**2),{flag:'wx',mode:0o600});
  } catch { /* A reserve is best effort; Docker stop must still be attempted. */ }
}
function save(id, value) {
  try { store.atomicWrite(stateFile(id), JSON.stringify(value, null, 2)); }
  catch(e) {
    if(!['ENOSPC','EDQUOT'].includes(e.code) || !fs.existsSync(reserveFile()))throw e;
    fs.unlinkSync(reserveFile());store.atomicWrite(stateFile(id),JSON.stringify(value,null,2));
  }
}
function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(defaults,k))) throw fail('存储策略字段不合法', 400);
  const p = { ...defaults };
  if(input.mode!==undefined&&!['soft','hard'].includes(input.mode))throw fail('存储模式应为 soft 或 hard',400);
  p.mode=input.mode||'soft';
  for (const key of Object.keys(defaults)) {
    if(key==='mode')continue;
    if (input[key] === undefined) continue;
    if (typeof input[key] === 'boolean' || input[key] === '' || input[key] === null) throw fail('存储策略必须为数字', 400);
    p[key] = Number(input[key]);
    if (!Number.isFinite(p[key])) throw fail('存储策略必须为有限数字', 400);
  }
  if (p.limitGiB < 0 || p.limitGiB > 1048576 || p.minFreeGiB < 0 || p.minFreeGiB > 1048576 || p.warnPercent < 1 || p.warnPercent >= p.stopPercent || p.stopPercent > 100) throw fail('容量需非负，阈值需满足 1 ≤ 告警 < 停机 ≤ 100', 400);
  if(input.admissionPercent===undefined)p.admissionPercent=Math.min(90,(p.warnPercent+p.stopPercent)/2);
  if(p.warnPercent>=p.admissionPercent||p.admissionPercent>=p.stopPercent||!Number.isInteger(p.drainSeconds)||p.drainSeconds<1||p.drainSeconds>30||!Number.isInteger(p.hardInodes)||p.hardInodes<100||p.hardInodes>100000000)throw fail('阈值需满足 告警 < 停止接单 < 停机；收尾时间为 1-30 秒，文件数至少 100',400);
  if(p.mode==='hard'&&(p.limitGiB*GiB<1024**2||p.stopPercent>=100))throw fail('硬配额至少 1MiB，保护停机阈值必须低于 100%',400);
  return p;
}
async function walk(root, relative = '', result = [], allowLinks = false, volumeMetadata = false) {
  const target = path.join(root, relative);
  // Accounting may inspect a link's own inode, never its target. Maintenance
  // retains the stricter policy, including rejection of links in ancestors.
  safe(allowLinks && relative ? path.dirname(target) : target);
  let stat;
  try { stat = await fsp.lstat(target); } catch (e) { if (e.code === 'ENOENT') return result; throw e; }
  if (stat.isDirectory()) {
    result.push({ path: relative, kind: 'directory', mode: stat.mode & 0o777 });
    for (const entry of await fsp.readdir(target)) {
      if(volumeMetadata&&!relative&&['.Spotlight-V100','.fseventsd','.Trashes','.TemporaryItems','.metadata_never_index'].includes(entry))continue;
      await walk(root, relative ? relative + '/' + entry : entry, result, allowLinks, volumeMetadata);
    }
  } else if (stat.isFile()) result.push({ path: relative, kind: 'file', bytes: stat.size, allocated: typeof stat.blocks === 'number' && stat.blocks > 0 ? stat.blocks * 512 : stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, mode: stat.mode & 0o777 });
  else if (allowLinks && stat.isSymbolicLink()) result.push({ path: relative, kind: 'link', bytes: stat.size, allocated: typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size });
  else throw fail('实例含链接或特殊文件，无法完整统计或安全维护');
  return result;
}
async function usage(id) {
  const current = state(id);
  const rows = await walk(store.instanceDir(id), '', [], true,current.hard?.backend==='apfs-volume');
  const files = rows.filter(r => r.kind === 'file');
  const accounted = rows.filter(r => r.kind === 'file' || r.kind === 'link');
  const linkCount = rows.filter(r => r.kind === 'link').length;
  let bytes = accounted.reduce((n, r) => n + Math.max(r.bytes, r.allocated), 0);
  // statfs(project-directory) can report project quota headroom on XFS. Query
  // its unassigned parent for the separate filesystem-wide reserve threshold.
  const disk = require('./runtime-platform').diskInfo(store.instancesRoot());
  if (!disk) throw fail('无法读取实例所在文件系统的可用空间');
  const p = normalize(current.policy);
  let quota=null,quotaError=null;
  if(p.mode==='hard'){
    try{
      if(current.hard?.phase!=='verified')throw fail('硬配额尚未通过宿主验证，请停机后重新应用');
      quota=await require('./storage-quota').status(id);
      if(!quota.verified||quota.hardBytes!==current.hard.hardBytes||(quota.inodeQuota!==false&&quota.hardInodes!==p.hardInodes))throw fail('宿主硬配额与策略不符，启动已被保护');
      if(quota.backend==='apfs-volume'&&quota.volumeUUID!==current.hard.volumeUUID)throw fail('APFS 卷 UUID 与平台策略不符');
      if(quota.backend==='apfs-volume')assertVolumeView(id,quota.volumeUUID);
      bytes=quota.usedBytes;
    }catch(error){quotaError=error.message;quota=null;}
  }
  if(quota?.filesystemAvailable!==undefined)disk.available=quota.filesystemAvailable;
  const percent = p.limitGiB ? Math.max(bytes/(quota?.hardBytes||p.limitGiB*GiB)*100,quota?.hardInodes?quota.usedInodes/quota.hardInodes*100:0) : null;
  const reason = quotaError || (p.limitGiB > 0 && (percent >= p.stopPercent ? '实例数据空间或文件数达到停机阈值' : disk.available < p.minFreeGiB * GiB ? '实例所在文件系统的剩余空间低于保留值' : null));
  return { bytes, logicalBytes: accounted.reduce((n,r) => n + r.bytes, 0), fileCount: files.length, linkCount,
    maintenanceWarning: linkCount ? '目录含符号链接：用量仅计链接本身，不跟随目标；此实例的清理、修复与备份请使用支持链接的全量维护工具。' : null, disk, percent, policy:p,
    blocked: current.blocked, drain:current.drain||null,recoveryPending: Boolean(current.recovery), reason,quota,quotaError,
    status: reason || current.blocked ? 'blocked' : percent >= p.warnPercent && percent !== null ? 'warning' : 'ok',
    enforcement: quota?(quota.backend||'xfs-project'):'poll-and-stop', hardQuota: Boolean(quota?.verified), checkedAt: new Date().toISOString(),
    mounts: Object.entries(folders).map(([folder, target]) => ({ folder, source: path.join(store.instanceDir(id), folder), target,
      bytes: accounted.filter(r => r.path.startsWith(folder + '/')).reduce((n,r) => n + Math.max(r.bytes,r.allocated),0) })),
    coverage: '统计整个实例目录；不含 Docker 镜像、容器可写层、Docker 日志和独立执行卷。Docker 日志另按 10MB × 3 轮转。' };
}
function setPolicy(id, input) { const s = state(id);const p=normalize(input);if(p.mode==='hard'||s.policy.mode==='hard')throw fail('硬配额必须通过宿主探测、停机应用与读回验证');s.policy=p;prepareReserve();save(id,s);return s; }
async function configurePolicy(id,input) {
  const s=state(id),p=normalize(input);
  if(p.mode==='soft')return setPolicy(id,p);
  const backend=require('./storage-quota');
  const capability=await backend.probe(id);
  if(!capability.supported)throw fail('不支持启用实例硬配额：'+capability.reason,422);
  standard(id);await stopped(id);
  const hardBytes=Math.floor(p.limitGiB*GiB/4096)*4096;
  // Persist intent first: a timeout, crash or partial host apply never enables
  // an unchecked start and never silently falls back to soft protection.
  s.policy=p;s.hard={...s.hard,phase:'applying',hardBytes,hardInodes:p.hardInodes};save(id,s);
  try{
    const result=await backend.apply(id,hardBytes,p.hardInodes);
    if(!result.verified||result.hardBytes!==hardBytes||(result.inodeQuota!==false&&result.hardInodes!==p.hardInodes))throw fail('宿主读回配额与请求不符');
    const latest=state(id);latest.hard={phase:'verified',hardBytes,hardInodes:result.inodeQuota===false?null:p.hardInodes,backend:result.backend||'xfs-project',volumeUUID:result.volumeUUID,mountpoint:result.mountpoint,projectId:result.projectId,verifiedAt:new Date().toISOString()};save(id,latest);
    return latest;
  }catch(error){const latest=state(id);latest.hard.phase='failed';latest.blocked||={at:new Date().toISOString(),reason:'硬配额应用未验证，请停机后重新应用'};save(id,latest);throw error;}
}
function assertVolumeView(id,uuid) {
  for(const folder of ['',...Object.keys(folders)]){
    const marker=safe(path.join(store.instanceDir(id),folder,'.openclaw-volume-id'));
    if(fs.readFileSync(marker,'utf8').trim()!==uuid)throw fail('Manager 看到的 APFS 卷与宿主登记不符，禁止启动');
  }
}
function requiresMountGuard(id){return state(id).hard?.backend==='apfs-volume';}
function isMigrating(id){return Boolean(state(id).migration);}
function isBlocked(id) { const s = state(id); return Boolean(s.blocked || s.drain || s.recovery || s.migration || (s.policy.mode==='hard'&&s.hard?.phase!=='verified')); }
async function beginDrain(id){const s=state(id);s.blocked||={at:new Date().toISOString(),reason:'管理员请求停机维护'};save(id,s);return enforce(id);}
async function assertAdmission(id) {
  const s=state(id),p=normalize(s.policy);
  if(isBlocked(id))throw fail('实例因数据空间保护停止接单，请清理或扩容后解除保护',507);
  if(!p.limitGiB)return;
  const u=await usage(id);
  if(u.reason||u.percent>=p.admissionPercent)throw fail('数据空间达到停止接单阈值，请清理或扩容；本次任务未提交',507);
}
function reportWriteFailure(id) {
  const s=state(id);s.blocked||={at:new Date().toISOString(),reason:'运行时报告空间或配额不足，本次任务可能未保存；已停止接单与自动重试'};
  volatileBlocks.set(id,s.blocked);
  try{save(id,s);volatileBlocks.delete(id);}catch{}
  const timer=setTimeout(()=>enforce(id).catch(()=>{}),0);timer.unref();
}
async function assertCanStart(id) {
  const s=state(id);
  if(s.migration)throw fail('实例正在 APFS 数据迁移，禁止启动');
  if(s.policy.mode==='hard')await require('./storage-quota').status(id,true);
  const u = await usage(id);
  if (u.reason || u.blocked || u.drain || u.recoveryPending || (u.percent!==null&&u.percent>=u.policy.admissionPercent)) throw fail(u.reason || (u.recoveryPending ? '数据恢复尚未完成，请先执行恢复回滚' : '存储保护已锁定或达到停止接单阈值，请清理或扩容后手动解除'));
}
async function release(id) {
  if(isMigrating(id))throw fail('实例正在 APFS 数据迁移，禁止解除保护');
  const u = await usage(id);
  if (u.reason || u.recoveryPending) throw fail(u.reason || '请先完成恢复回滚');
  if(u.percent!==null&&u.percent>=u.policy.warnPercent)throw fail('请先将空间和文件数用量降至告警阈值以下，再解除保护');
  await stopped(id);
  if(u.policy.mode==='hard')await require('./storage-quota').status(id,true);
  for(const folder of Object.keys(folders))if(!fs.statSync(safe(path.join(store.instanceDir(id),folder))).isDirectory())throw fail('挂载目录异常，请先修复');
  const raw=store.readOpenclawConfig(id);if(!raw)throw fail('实例配置缺失，请先修复或恢复备份');
  const config=JSON.parse(raw);if(!config||typeof config!=='object'||Array.isArray(config))throw fail('实例配置无效，请先修复');require('./container-policy').assertAgentConfig(config);
  const s = state(id); s.blocked = null;delete s.drain;save(id,s);volatileBlocks.delete(id);prepareReserve();
}
function standard(id) {
  const record = store.loadInstance(id);
  if (record.security?.profile || record.pluginIsolation || record.channelIsolation) throw fail('该实例含独立执行卷或隔离凭据，请使用平台全量备份及对应隔离迁移工具维护；此入口仅支持普通实例的三个挂载目录');
  return record;
}
async function stopped(id) {
  const dm = require('./docker');
  const rows = await dm.listContainersByLabel();
  if (rows.some(r => r.instanceId === id && !['exited','created','dead'].includes(r.state))) throw fail('请先停止该实例及其关联容器，再执行数据维护');
}
function backupDir(id) {
  store.instanceDir(id);
  const root = safe(backupRoot());
  if (inside(store.instancesRoot(), root) || inside(root, store.instancesRoot())) throw fail('实例备份目录必须位于实例数据目录之外');
  return safe(path.join(root,id));
}
function keyFile() {
  const file = safe(process.env.OPENCLAW_BACKUP_KEY_FILE || path.join(path.dirname(store.instancesRoot()), 'backup-keys','key'));
  if (inside(store.instancesRoot(),file) || inside(backupRoot(),file) || inside(require('./backups').root,file)) throw fail('备份密钥必须位于实例及备份目录之外');
  if (!fs.existsSync(file)) {
    // Losing a key must not silently replace it with an unusable new key.
    if (fs.existsSync(backupRoot()) && fs.readdirSync(backupRoot()).some(id => fs.statSync(path.join(backupRoot(),id)).isDirectory() && fs.readdirSync(path.join(backupRoot(),id)).some(n => n.endsWith('.enc')))) throw fail('备份密钥缺失，请找回原密钥');
    if (fs.existsSync(require('./backups').root) && fs.readdirSync(require('./backups').root).some(n => n.endsWith('.enc'))) throw fail('全量备份密钥缺失，请找回原密钥');
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700}); fs.writeFileSync(file,crypto.randomBytes(32),{flag:'wx',mode:0o600});
  }
  if (fs.readFileSync(file).length !== 32) throw fail('备份密钥长度无效');
  return file;
}
async function hash(file) { const h = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(safe(file))) h.update(chunk); return h.digest('hex'); }
function snapshotFile(id, name) {
  if (!/^\d{13}-[a-f0-9]{16}\.tar\.gz\.enc$/.test(name || '')) throw fail('备份标识无效',400);
  return safe(path.join(backupDir(id),name));
}
function listBackups(id) {
  const dir = backupDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => /^\d{13}-[a-f0-9]{16}\.tar\.gz\.enc$/.test(n)).sort().reverse().map(name => {
    const file = snapshotFile(id,name); let meta = {};
    try { meta = JSON.parse(fs.readFileSync(safe(file+'.json'),'utf8')); } catch {}
    return { name, bytes:fs.statSync(file).size, createdAt:meta.createdAt || null, contentBytes:meta.contentBytes || null };
  });
}
async function deleteBackup(id,name) {
  const file=snapshotFile(id,name), remaining=listBackups(id).filter(row=>row.name!==name);
  if(!remaining.length)throw fail('保留最后一份实例备份；请先创建并校验新备份');
  // Never discard the only usable copy merely because another file exists.
  let valid=false;
  for(const other of remaining){try{await verify(id,other.name);valid=true;break;}catch{}}
  if(!valid)throw fail('其余备份均未通过校验，已保留所选备份');
  await fsp.unlink(file);if(fs.existsSync(file+'.json'))await fsp.unlink(safe(file+'.json'));
  return {ok:true,hint:'所选备份已删除，已确认另有可用备份'};
}
function space(root, required) {
  const disk = require('./runtime-platform').diskInfo(root);
  if (!disk || disk.available < required + 256 * 1024 ** 2) throw fail('空间不足，需预留临时校验空间及至少 256MB 恢复余量',507);
}
async function snapshot(id) {
  const record = standard(id); await stopped(id);
  if (state(id).recovery) throw fail('请先完成恢复回滚');
  const root = store.instanceDir(id), rows = [];
  for (const folder of Object.keys(folders)) {
    const source=safe(path.join(root,folder));
    if(!fs.existsSync(source) || !fs.statSync(source).isDirectory())throw fail('挂载目录缺失，拒绝发布不完整备份');
    await walk(root,folder,rows);
  }
  const contentBytes = rows.reduce((n,r) => n+(r.bytes||0),0);
  const dir = backupDir(id); fs.mkdirSync(dir,{recursive:true,mode:0o700}); space(dir,contentBytes*3);
  const name = Date.now()+'-'+crypto.randomBytes(8).toString('hex')+'.tar.gz.enc';
  const file = snapshotFile(id,name), tmp = file+'.tmp';
  const key = fs.readFileSync(keyFile()), nonce = crypto.randomBytes(12), magic = Buffer.from('OCBK1');
  const cipher = crypto.createCipheriv('aes-256-gcm',key,nonce); cipher.setAAD(magic);
  fs.writeFileSync(tmp,Buffer.concat([magic,nonce]),{flag:'wx',mode:0o600});
  const pack = tar.pack();
  const writing = pipeline(pack,zlib.createGzip(),cipher,fs.createWriteStream(tmp,{flags:'a'}));
  writing.catch(()=>{});
  const manifest = { version:1, id, createdAt:new Date().toISOString(), files:[], gatewayTokenHash:store.revision(record.gatewayToken || '') };
  try {
    for (const row of rows) {
      const header = { name:row.path, type:row.kind === 'directory' ? 'directory' : 'file', mode:row.mode, size:row.bytes||0 };
      if (row.kind === 'directory') await new Promise((resolve,reject) => pack.entry(header,e=>e?reject(e):resolve()));
      else {
        const src = safe(path.join(root,row.path)), before = await hash(src);
        await pipeline(fs.createReadStream(src),pack.entry(header));
        if (before !== await hash(src)) throw fail('备份时文件变化，请确认所有写入进程已停止');
        manifest.files.push({path:row.path,bytes:row.bytes,sha256:before});
      }
    }
    await new Promise((resolve,reject) => pack.entry({name:'manifest.json',mode:0o600},JSON.stringify(manifest),e=>e?reject(e):resolve()));
    pack.finalize(); await writing; fs.appendFileSync(tmp,cipher.getAuthTag());
    // Authenticate and hash every file before publishing the snapshot.
    await verifyArchive(id,tmp,contentBytes);
    const published=await fsp.open(tmp,'r+');try{await published.sync();}finally{await published.close();}
    fs.renameSync(tmp,file);
    store.atomicWrite(file+'.json',JSON.stringify({createdAt:manifest.createdAt,contentBytes}));
    return {name,contentBytes};
  } catch(e) { pack.destroy(e); await writing.catch(()=>{}); throw e; }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
async function verifyArchive(id,file,expectedBytes,destination) {
  const temp = safe(path.join(backupDir(id),'.verify-'+crypto.randomBytes(12).toString('hex')));
  try {
    // No plaintext is parsed or installed until GCM authentication succeeds.
    await require('../scripts/backup_crypto.cjs').transform('decrypt',file,temp,keyFile());
    const extract = tar.extract(), seen = new Map(); let manifest, total = 0, entries = 0;
    const diskBudget = destination ? require('./runtime-platform').diskInfo(destination)?.available : Infinity;
    const budget = Math.min(expectedBytes ?? 1024*GiB, diskBudget === undefined ? 0 : diskBudget - 256*1024**2);
    extract.on('entry',(header,stream,next) => {
      (async () => {
        const name = header.name;
        if (++entries > 1000000 || name.includes('\\') || name.includes('\0') || name.split('/').some(p=>!p || p==='.' || p==='..') || seen.has(name) || !['file','directory'].includes(header.type)) throw fail('备份包含非法路径、重复项或不支持的文件类型');
        if (name === 'manifest.json') {
          if (manifest || header.type !== 'file' || header.size > 64*1024*1024) throw fail('备份清单无效');
          const chunks = []; for await (const chunk of stream) chunks.push(chunk);
          manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')); return;
        }
        if (!Object.hasOwn(folders,name.split('/')[0])) throw fail('备份路径不属于实例挂载目录');
        if (header.type === 'directory') {
          seen.set(name,null); if(destination) await fsp.mkdir(safe(path.join(destination,name)),{recursive:true,mode:0o700}); stream.resume(); return;
        }
        if (!Number.isSafeInteger(header.size) || header.size < 0 || (total += header.size) > budget) throw fail('备份展开大小超过允许空间',507);
        const h = crypto.createHash('sha256'); let length=0, output;
        if (destination) { const target=safe(path.join(destination,name)); await fsp.mkdir(path.dirname(target),{recursive:true,mode:0o700}); output=await fsp.open(target,'wx',header.mode & 0o777 & ~0o022); }
        try { for await (const chunk of stream) { h.update(chunk); length+=chunk.length; if(output) await output.writeFile(chunk); } }
        finally { await output?.close(); }
        if(length!==header.size)throw fail('备份文件长度不符');
        seen.set(name,{bytes:length,sha256:h.digest('hex')});
      })().then(()=>next(),e=>extract.destroy(e));
    });
    await pipeline(fs.createReadStream(temp),zlib.createGunzip(),extract);
    if (manifest?.version!==1 || manifest.id!==id || !Array.isArray(manifest.files) || manifest.files.length !== [...seen.values()].filter(Boolean).length) throw fail('备份清单与实例不符');
    const names = new Set();
    for (const row of manifest.files) {
      if (names.has(row.path) || seen.get(row.path)?.sha256!==row.sha256 || seen.get(row.path)?.bytes!==row.bytes) throw fail('备份文件校验失败');
      names.add(row.path);
    }
    return manifest;
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
async function verify(id,name) { const file=snapshotFile(id,name); space(backupDir(id),fs.statSync(file).size*2); const m=await verifyArchive(id,file); return {ok:true,createdAt:m.createdAt,files:m.files.length}; }
function recoveryPaths(id, token) {
  if (!/^[a-f0-9]{24}$/.test(token||'')) throw fail('恢复事务标识损坏');
  const root=safe(store.instanceDir(id));
  return {root,stage:safe(path.join(root,'.restore-'+token)),old:safe(path.join(root,'.previous-'+token))};
}
async function rollback(id) {
  await stopped(id);
  const s=state(id); if(!s.recovery)return;
  const p=recoveryPaths(id,s.recovery);
  for(const folder of Object.keys(folders)) {
    const old=safe(path.join(p.old,folder)), target=safe(path.join(p.root,folder));
    if(fs.existsSync(old)) { await fsp.rm(target,{recursive:true,force:true}); await fsp.rename(old,target); }
  }
  await fsp.rm(p.stage,{recursive:true,force:true}); await fsp.rm(p.old,{recursive:true,force:true});
  delete s.recovery; save(id,s);
}
async function restore(id,name) {
  const record=standard(id); await stopped(id);
  if(state(id).recovery)throw fail('已有未完成的恢复，请先回滚');
  // Ensure there is a known-good escape path before replacing any live data.
  const previous=await snapshot(id), token=crypto.randomBytes(12).toString('hex'), p=recoveryPaths(id,token);
  const file=snapshotFile(id,name); space(backupDir(id),fs.statSync(file).size*2);
  await fsp.mkdir(p.stage,{mode:0o700});
  try {
    const manifest=await verifyArchive(id,file,undefined,p.stage);
    if(manifest.gatewayTokenHash!==store.revision(record.gatewayToken||''))throw fail('备份网关身份与当前实例不符，请通过独立恢复流程迁移');
    const config=JSON.parse(await fsp.readFile(safe(path.join(p.stage,'openclaw','openclaw.json')),'utf8'));
    require('./container-policy').assertAgentConfig(config);
    for(const folder of Object.keys(folders))if(!fs.statSync(safe(path.join(p.stage,folder))).isDirectory())throw fail('备份缺少必要挂载目录');
    await fsp.mkdir(p.old,{mode:0o700});
    const s=state(id); s.recovery=token; save(id,s);
    for(const folder of Object.keys(folders)) {
      const target=safe(path.join(p.root,folder));
      if(!fs.statSync(target).isDirectory())throw fail('原挂载目录缺失，已停止恢复');
      await fsp.rename(target,path.join(p.old,folder));
      await fsp.rename(path.join(p.stage,folder),target);
    }
    // Match the existing bind-mount owner after extraction (Linux manager may be root).
    if(process.platform!=='win32' && process.getuid?.()===0) {
      for(const folder of Object.keys(folders)) {
        const owner=fs.statSync(path.join(p.old,folder));
        for(const row of await walk(p.root,folder))await fsp.chown(safe(path.join(p.root,row.path)),owner.uid,owner.gid);
      }
    }
    const latest=store.loadInstance(id); latest.envPending=true; latest.configPending=true; store.saveInstance(latest);
    // Commit before deleting old data; a crash can leave harmless .previous data.
    delete s.recovery; save(id,s);
    await fsp.rm(p.old,{recursive:true,force:true}).catch(()=>{});
    return {ok:true,previous:previous.name,hint:'数据已恢复，实例保持停止；启动时将重建容器以应用环境变量'};
  } catch(e) { if(state(id).recovery)await rollback(id); throw e; }
  finally { if(!state(id).recovery)await fsp.rm(p.stage,{recursive:true,force:true}); }
}

// Only rotated .log files under openclaw/logs are eligible. Sessions, memory,
// databases, active logs and arbitrary workspace files are never selected.
async function cleanupPreview(id) {
  const root=store.instanceDir(id), rows=await walk(root,'openclaw/logs');
  const candidates=rows.filter(r=>r.kind==='file' && /\.log\.(?:\d+|\d{4}-\d{2}-\d{2})(?:\.gz)?$/.test(r.path) && Date.now()-r.mtimeMs>7*86400000);
  return { candidates, bytes:candidates.reduce((n,r)=>n+r.allocated,0), revision:store.revision(JSON.stringify(candidates)) };
}
async function cleanup(id,revision) {
  await stopped(id); if(state(id).recovery)throw fail('请先完成恢复回滚');
  const preview=await cleanupPreview(id); if(preview.revision!==revision)throw fail('文件已变化，请重新预览');
  for(const row of preview.candidates) { const file=safe(path.join(store.instanceDir(id),row.path)), s=await fsp.lstat(file); if(!s.isFile()||s.size!==row.bytes||s.mtimeMs!==row.mtimeMs||s.ino!==row.ino)throw fail('文件已变化，请重新预览'); await fsp.unlink(file); }
  return {ok:true,removed:preview.candidates.length,bytes:preview.bytes};
}
async function diagnostics(id) {
  const checks=[];
  for(const folder of Object.keys(folders)) { try { const s=await fsp.stat(safe(path.join(store.instanceDir(id),folder))); checks.push({name:folder,ok:s.isDirectory()}); } catch { checks.push({name:folder,ok:false}); } }
  for(const name of ['openclaw.json','openclaw.json.last-good','openclaw.json.bak.1','openclaw.json.bak.2','openclaw.json.bak.3']) {
    try { const p=safe(path.join(store.configDir(id),name)); const cfg=JSON.parse(await fsp.readFile(p,'utf8')); if(!cfg||Array.isArray(cfg)||typeof cfg!=='object')throw fail('JSON 非对象'); require('./container-policy').assertAgentConfig(cfg); checks.push({name,ok:true}); }
    catch(e) { checks.push({name,ok:false,missing:e.code==='ENOENT'}); }
  }
  return {checks,recoveryPending:Boolean(state(id).recovery),hint:'数据库损坏请停止实例，校验备份后恢复。此处不对数据库执行原地修复。'};
}
async function repairConfig(id,name) {
  standard(id); await stopped(id); if(state(id).recovery)throw fail('请先完成恢复回滚');
  if(!['openclaw.json.last-good','openclaw.json.bak.1','openclaw.json.bak.2','openclaw.json.bak.3'].includes(name))throw fail('请选择可用的配置历史文件',400);
  const content=await fsp.readFile(safe(path.join(store.configDir(id),name)),'utf8');
  const cfg=JSON.parse(content); require('./container-policy').assertAgentConfig(cfg);
  const before=await snapshot(id);
  store.writeOpenclawConfig(id,content);
  const record=store.loadInstance(id);record.configPending=true;store.saveInstance(record);
  return {ok:true,previous:before.name,hint:'配置已从历史版本恢复，原数据已加密备份；实例保持停止'};
}

let protection;
async function enforce(id) {
  protection ||= require('./storage-guard').createGuard({
    read:state,usage,dm:require('./docker'),rpc:(...args)=>require('./gateway-rpc').rpc(...args),
    emit:(...args)=>require('./monitor').broadcast(...args),
    write:(id,value)=>{
      if(value.blocked)volatileBlocks.set(id,value.blocked);
      save(id,value);volatileBlocks.delete(id);
    },
  });
  return protection.enforce(id);
}
let timer,loopRunning=false;
async function tick() {
  if(loopRunning)return;loopRunning=true;
  const operations=require('./operations'),guard=require('./maintenance-guard');
  try {
    const ids=new Set(store.listInstanceIds());
    if(fs.existsSync(home()))for(const name of fs.readdirSync(home()))if(/^[a-z0-9_-]+\.json$/i.test(name)){
      const id=name.slice(0,-5);try{if(requiresMountGuard(id))ids.add(id);}catch{}
    }
    for(const id of ids) {
      if(require('./resource-planner').pending.has(id)||isMigrating(id))continue;
      const op={description:'storage-guard'},ownsLock=!operations.busy.has(id)&&!guard.active;if(ownsLock)operations.busy.set(id,op);
      try{await enforce(id);}catch{require('./monitor').broadcast('storage',{id,status:'error',reason:'存储检测或保护停机失败，请检查 Docker、目录权限和链接'});}
      finally{if(ownsLock&&operations.busy.get(id)===op)operations.busy.delete(id);}
    }
  } finally{loopRunning=false;}
}
function start(){if(timer)return;prepareReserve();tick();timer=setInterval(tick,5000);timer.unref();}
function stop(){clearInterval(timer);timer=null;}
module.exports={usage,normalize,setPolicy,configurePolicy,requiresMountGuard,isMigrating,isBlocked,beginDrain,assertAdmission,reportWriteFailure,assertCanStart,release,cleanupPreview,cleanup,snapshot,listBackups,deleteBackup,verify,restore,rollback,diagnostics,repairConfig,enforce,tick,start,stop,safe,walk,verifyArchive};
