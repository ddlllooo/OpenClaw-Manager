'use strict';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const MEMORY_STEP = 128 * MiB;
const MIN_MEMORY = GiB;
let allocationTail = Promise.resolve();
// In-flight creates reserve capacity before pulling an image. These reservations
// disappear on failure or process exit; historical missing records do not reserve.
const pending = new Map();

async function withAllocationLock(fn) {
  const previous = allocationTail;
  let release;
  allocationTail = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await fn(); } finally { release(); }
}

const positive = v => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0;
const cores = r => positive(r.nanoCpus) / 1e9 || positive(r.cpus);
const floorCpu = v => Math.floor((v + 1e-9) * 10) / 10;

function planResources(info, records, containers, excludeId = null, reservations = pending) {
  const totalCores = positive(info.ncpu);
  const totalMemBytes = positive(info.memTotal);
  if (!totalCores || !totalMemBytes) throw new Error('Docker 资源容量不可用，无法计算分配预算');
  // Docker reports its engine/VM capacity, not the physical Mac's RAM. Leave
  // headroom for the Linux VM and daemon, then account for Manager separately.
  const systemReservedCores = Math.min(totalCores, Math.max(0.5, Math.ceil(totalCores * 0.1 * 10) / 10));
  const systemReservedMemBytes = Math.min(totalMemBytes, Math.max(512 * MiB, Math.ceil(totalMemBytes * 0.1 / MEMORY_STEP) * MEMORY_STEP));
  const warnings = [];
  const charged = new Map();
  const recordById = new Map(records.map(r => [r.id, r]));
  let otherReservedCores = 0, otherReservedMemBytes = 0, unbounded = false;
  function cost(r, name) {
    const cpu = cores(r), memory = positive(r.memoryBytes);
    if (!cpu || !memory) {
      unbounded = true;
      warnings.push(`${name} 未设置${!cpu ? ' CPU' : ''}${!memory ? ' 内存' : ''}上限，无法保证剩余容量，请先设置上限`);
    }
    return { cpus: cpu || totalCores, memoryBytes: memory || totalMemBytes };
  }
  for (const c of containers) {
    const record = recordById.get(c.instanceId);
    const rollback = /-rollback-/.test(c.name || '');
    const primary = c.managed && !rollback && record &&
      (record.containerId === c.id || record.containerName === c.name);
    if (primary) {
      if (record.id === excludeId) continue;
      // A stopped primary container keeps its budget for a later start. Use
      // actual Docker limits and persisted desired limits conservatively.
      const actual = cost(c.resources, record.name || record.id);
      const desired = record.resources || {};
      charged.set(record.id, {
        cpus: Math.max(actual.cpus, cores(desired)),
        memoryBytes: Math.max(actual.memoryBytes, positive(desired.memoryBytes)),
      });
    } else if (['running', 'restarting', 'paused'].includes(c.state)) {
      // Running rollback/orphan containers still consume resources; stopped
      // rollback copies share the image but do not consume an extra budget.
      const value = cost(c.resources, c.name || c.id);
      otherReservedCores += value.cpus;
      otherReservedMemBytes += value.memoryBytes;
    }
  }
  for (const [id, resources] of reservations) {
    if (id !== excludeId && !charged.has(id)) charged.set(id, cost(resources, '正在创建的实例'));
  }
  const missingInstanceCount = records.filter(r => r.id !== excludeId && !charged.has(r.id) && !containers.some(c => c.id === r.containerId)).length;
  if (missingInstanceCount) warnings.push(`${missingInstanceCount} 个无容器记录未占预算，启动时将重新校验`);
  let reservedCores = 0, reservedMemBytes = 0;
  for (const r of charged.values()) { reservedCores += r.cpus; reservedMemBytes += r.memoryBytes; }
  const rawCpu = totalCores - systemReservedCores - otherReservedCores - reservedCores;
  const rawMemory = totalMemBytes - systemReservedMemBytes - otherReservedMemBytes - reservedMemBytes;
  const remainCores = floorCpu(Math.max(0, rawCpu));
  const remainMemBytes = Math.max(0, rawMemory);
  const canRecommend = !unbounded && remainCores >= 0.5 && remainMemBytes >= MIN_MEMORY;
  // A predictable gateway profile, bounded by the available budget. Round
  // down; rounding to the nearest unit can over-allocate the final slot.
  const cpus = floorCpu(Math.min(2, remainCores, Math.max(1, remainCores / 4)));
  const memoryBytes = Math.floor(Math.min(2 * GiB, remainMemBytes) / MEMORY_STEP) * MEMORY_STEP;
  const reason = canRecommend ? null : '剩余预算不足以推荐 0.5 核 / 1 GiB；请先调整已有实例或 Docker 容量';
  return {
    totalCores, totalMemBytes, systemReservedCores, systemReservedMemBytes,
    reservedCores: Math.round(reservedCores * 1e9) / 1e9, reservedMemBytes,
    otherReservedCores, otherReservedMemBytes, remainCores, remainMemBytes,
    missingInstanceCount, overcommitted: rawCpu < -1e-9 || rawMemory < 0,
    unbounded, warnings, canRecommend, reason,
    recommended: canRecommend ? { cpus, memoryBytes, memory: `${memoryBytes / MiB}m`, pidsLimit: Math.max(192, Math.ceil(cpus) * 128) } : null,
  };
}

function assertCapacity(resources, plan, previous = null) {
  const cpu = cores(resources), memory = positive(resources.memoryBytes);
  const beforeCpu = previous && cores(previous), beforeMem = previous && positive(previous.memoryBytes);
  // Permit repairing an already overcommitted installation one dimension at a
  // time. An unchanged dimension cannot prevent lowering another dimension.
  const cpuRepair = previous && beforeCpu && cpu && cpu <= beforeCpu;
  const memRepair = previous && beforeMem && memory && memory <= beforeMem;
  const failures = [];
  if (!cpuRepair && (!cpu || cpu > plan.remainCores + 1e-9)) failures.push(`CPU 可用 ${plan.remainCores} 核`);
  if (!memRepair && (!memory || memory > plan.remainMemBytes)) failures.push(`内存可用 ${Math.floor(plan.remainMemBytes / MiB)} MiB`);
  if (failures.length) {
    const err = new Error(`资源预算不足或未设置明确上限：${failures.join('，')}。已扣除系统预留和其他容器额度`);
    err.statusCode = 409;
    throw err;
  }
}

module.exports = { planResources, assertCapacity, withAllocationLock, pending };
