'use strict';

const path = require('path');
const crypto = require('crypto');
const Docker = require('dockerode');

// Docker Desktop on macOS exposes the socket under the user's home directory;
// fall back to the conventional /var/run/docker.sock for Linux hosts.
const runtimePlatform = require('./runtime-platform');
const resolveSocketPath = runtimePlatform.socketPath;
const SOCKET_PATH = runtimePlatform.dockerSocket();
// Keep CLI-based exec and API-based operations on the same Docker engine.
process.env.DOCKER_HOST = (SOCKET_PATH.startsWith('//./pipe/') ? 'npipe://' : 'unix://') + SOCKET_PATH;
delete process.env.DOCKER_CONTEXT; // DOCKER_CONTEXT would override DOCKER_HOST for CLI execs.

const docker = new Docker({ socketPath: SOCKET_PATH, timeout: 60000 });
const previousStats = new Map();

const DEFAULT_IMAGE = process.env.OPENCLAW_IMAGE || 'docker.io/openclaw/openclaw:latest';

// Docker Hub is unreachable from some networks; a registry mirror prefix
// (e.g. docker.1ms.run) makes pulls work. Applied when the image reference has
// no explicit registry host.
const MIRROR_PREFIX = process.env.DOCKER_MIRROR_PREFIX || '';
const DOCKER_IO_HOSTS = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io', '']);

function resolveImage(image) {
  image = String(image).trim();
  if (!image || /\s/.test(image)) throw new Error('镜像引用不合法');
  if (/^sha256:[a-f0-9]{64}$/.test(image)) return image;
  if (!MIRROR_PREFIX) return image;
  const normalized = image.replace(/^(docker.io|index.docker.io|registry-1.docker.io)\//, '');
  const first = normalized.split('/')[0];
  if (normalized.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) return image;
  return `${MIRROR_PREFIX.replace(/\/$/, '')}/${normalized.includes('/') ? normalized : 'library/' + normalized}`;
}
function splitImageTag(image) {
  if (image.includes('@')) return [image, null];
  const idx = image.lastIndexOf(':');
  if (idx > image.lastIndexOf('/')) return [image.slice(0, idx), image.slice(idx + 1)];
  return [image, 'latest'];
}
const GATEWAY_PORT_INTERNAL = 18789;

function isDockerError(err) {
  return err && (err.reason || err.statusCode) && err.message;
}

function shortDockerError(err) {
  if (!isDockerError(err)) return err.message || String(err);
  const m = /driver failed programming external connectivity.*port is already allocated/i.exec(err.message);
  if (m) return '宿主机端口已被占用，请更换端口后重试';
  const c = /Conflict\. The container name .* is already in use/i.exec(err.message);
  if (c) return '同名容器已存在，请先删除旧实例';
  const n = /No such (image|container)/i.exec(err.message);
  if (n) return '镜像或容器不存在';
  return err.message.slice(0, 300);
}

async function dockerInfo() {
  const info = await docker.info();
  return {
    serverVersion: info.ServerVersion,
    ncpu: info.NCPU,
    memTotal: info.MemTotal,
    containers: info.Containers,
    containersRunning: info.ContainersRunning,
    images: info.Images,
    driver: info.Driver,
    operatingSystem: info.OperatingSystem,
    platform: process.platform,
    architecture: info.Architecture,
    disk: runtimePlatform.diskInfo(require('./instances').instancesRoot()),
    deploymentTarget: process.env.OPENCLAW_DEPLOYMENT_TARGET || '本机',
  };
}

async function listContainersByLabel() {
  const containers = await docker.listContainers({ all: true });
  return containers
    .filter((c) => c.Labels && c.Labels['openclaw.instance'] && c.Labels['openclaw.managed'] === 'true')
    .map((c) => ({
      containerId: c.Id,
      name: c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : '',
      state: c.State,
      status: c.Status,
      instanceId: c.Labels['openclaw.instance'],
      dockerHealth: /\(unhealthy\)/.test(c.Status) ? 'unhealthy' : /\(healthy\)/.test(c.Status) ? 'healthy' : null,
    }));
}

function getContainer(containerId) {
  return docker.getContainer(containerId);
}

async function pullImageInternal(image, onProgress) {
  const resolved = resolveImage(image);
  const [repo, tag] = splitImageTag(resolved);
  const stream = await docker.createImage({ fromImage: repo, ...(tag ? { tag } : {}) });
  const timeout = setTimeout(() => stream.destroy(new Error('镜像拉取超过 10 分钟')), 600000);
  stream.once('end', () => clearTimeout(timeout));
  stream.once('error', () => clearTimeout(timeout));
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()), (evt) => {
      if (onProgress && evt.progressDetail) onProgress(evt);
    });
  });
  if (resolved !== image && !image.includes('@')) {
    const [originalRepo, originalTag] = splitImageTag(image);
    await docker.getImage(resolved).tag({ repo: originalRepo, tag: originalTag });
  }
}

async function imageExists(image) {
  try {
    await docker.getImage(image).inspect().catch(err => {
      if (err.statusCode !== 404 || resolveImage(image) === image) throw err;
      return docker.getImage(resolveImage(image)).inspect();
    });
    return true;
  } catch {
    return false;
  }
}

// cpuDelta / systemDelta ratio converted to a percentage of a single core.
function computeCpuPercent(stats) {
  const cpu = stats.cpu_stats || {};
  const pre = stats.precpu_stats || {};
  const cpuDelta = (cpu.cpu_usage && cpu.cpu_usage.total_usage || 0) - (pre.cpu_usage && pre.cpu_usage.total_usage || 0);
  const sysDelta = (cpu.system_cpu_usage || 0) - (pre.system_cpu_usage || 0);
  const online = cpu.online_cpus || (cpu.cpu_usage && cpu.cpu_usage.percpu_usage ? cpu.cpu_usage.percpu_usage.length : 1);
  if (sysDelta > 0 && cpuDelta > 0) return (cpuDelta / sysDelta) * online * 100;
  return 0;
}

async function getStats(containerId) {
  const container = docker.getContainer(containerId);
  const stats = await container.stats({ stream: false, 'one-shot': true });
  if (!stats.precpu_stats?.cpu_usage?.total_usage && previousStats.has(containerId)) stats.precpu_stats = previousStats.get(containerId);
  previousStats.set(containerId, stats.cpu_stats);
  const mem = stats.memory_stats || {};
  const net = {};
  const networks = (stats.networks) || {};
  for (const [name, n] of Object.entries(networks)) {
    net[name] = { rxBytes: n.rx_bytes || 0, txBytes: n.tx_bytes || 0 };
  }
  return {
    cpuPercent: computeCpuPercent(stats),
    memUsed: mem.usage || 0,
    memLimit: mem.limit || 0,
    memCache: (mem.stats && (mem.stats.inactive_file || mem.stats.cache)) || 0,
    net: net,
    read: stats.read,
  };
}

async function inspectContainer(containerId) {
  const container = docker.getContainer(containerId);
  return container.inspect();
}

async function startContainer(containerId) {
  await docker.getContainer(containerId).start();
}

async function stopContainer(containerId, timeout = 20) {
  await docker.getContainer(containerId).stop({ t: timeout });
}

async function restartContainer(containerId, timeout = 20) {
  await docker.getContainer(containerId).restart({ t: timeout });
}

async function removeContainer(containerId, force = false) {
  await docker.getContainer(containerId).remove({ force, v: false });
}

async function updateResources(containerId, { cpuShares, nanoCpus, memory, pidsLimit }) {
  const update = {};
  if (cpuShares !== undefined && cpuShares !== null) update.CpuShares = cpuShares;
  if (nanoCpus !== undefined && nanoCpus !== null) update.NanoCpus = nanoCpus;
  if (memory !== undefined && memory !== null) { update.Memory = memory; update.MemorySwap = memory ? memory * 2 : -1; }
  if (pidsLimit !== undefined && pidsLimit !== null) update.PidsLimit = pidsLimit;
  if (Object.keys(update).length === 0) return;
  await docker.getContainer(containerId).update(update);
}

// Create the gateway container for one instance. Ownership (config dir, files)
// is passed to the image's node user (uid 1000) via HostConfig chown flags.
async function createInstanceContainerInternal(opts) {
  const {
    instanceId, name, image, hostPort, hostIP,
    configDir, workspaceDir, authDir,
    env, cpuShares, nanoCpus, memory, pidsLimit,
  } = opts;

  const binds = [
    `${runtimePlatform.bindPath(configDir)}:/home/node/.openclaw`,
    `${runtimePlatform.bindPath(workspaceDir)}:/home/node/.openclaw/workspace`,
    `${runtimePlatform.bindPath(authDir)}:/home/node/.config/openclaw`,
  ];

  const template = opts.template;
  const imageInfo = await docker.getImage(image).inspect().catch(err => {
    if (err.statusCode !== 404 || resolveImage(image) === image) throw err;
    return docker.getImage(resolveImage(image)).inspect();
  });
  const imageConfig = imageInfo.Config || {};
  const purpose = require('./image-purpose').imagePurpose(imageInfo.RepoTags || [image], imageConfig.Labels || {}, DEFAULT_IMAGE);
  if (['manager', 'build-base'].includes(purpose.kind)) throw new Error(`${purpose.purpose}不能用于创建 OpenClaw 实例`);
  let healthcheck = template?.Config?.Healthcheck || imageConfig.Healthcheck;
  if (healthcheck?.Test?.[0] === 'CMD' && healthcheck.Test[1] === 'node' && healthcheck.Test[2] === 'dist/docker-healthcheck.js') {
    healthcheck = { ...healthcheck, Test: ['CMD', 'node', path.posix.join(imageConfig.WorkingDir || '/app', 'dist/docker-healthcheck.js')] };
  }
  const configuredEnv = new Map((imageConfig.Env || []).map(line => { const i = line.indexOf('='); return [line.slice(0,i), line.slice(i+1)]; }));
  for (const line of env || []) { const i = line.indexOf('='); configuredEnv.set(line.slice(0,i), line.slice(i+1)); }
  if(runtimePlatform.instanceUser()){
    // Numeric host UID may have no passwd entry in the image. Keep OpenClaw's
    // state and cache on the writable mounts rather than falling back to '/'.
    configuredEnv.set('HOME','/home/node');
    configuredEnv.set('OPENCLAW_STATE_DIR','/home/node/.openclaw');
    configuredEnv.set('XDG_CACHE_HOME','/home/node/.openclaw/.cache');
  }
  const container = await docker.createContainer({
    ...(template?.Config || {}),
    name, Image: imageInfo.Id || image,
    Labels: { ...(template?.Config?.Labels || {}), 'openclaw.managed': 'true', 'openclaw.instance': instanceId },
    Env: [...configuredEnv].map(([key,value]) => `${key}=${value}`),
    ExposedPorts: { [`${GATEWAY_PORT_INTERNAL}/tcp`]: {} },
    HostConfig: {
      ...(template?.HostConfig || {}),
      PortBindings: { [`${GATEWAY_PORT_INTERNAL}/tcp`]: [{ HostIp: hostIP || '127.0.0.1', HostPort: String(hostPort) }] },
      Binds: template?.HostConfig?.Binds || binds,
      RestartPolicy: require('./startup-settings').restartPolicy(instanceId, template?.HostConfig?.RestartPolicy || { Name: 'unless-stopped' }),
      Memory: memory || 0,
      MemorySwap: memory ? Math.max(memory * 2, template?.HostConfig?.MemorySwap || 0) : -1,
      NanoCpus: nanoCpus || 0, CpuShares: cpuShares || 0, PidsLimit: pidsLimit || 0,
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
    ...(healthcheck ? { Healthcheck: healthcheck } : {}),
    WorkingDir: template?.Config?.WorkingDir || '/home/node',
    User: runtimePlatform.instanceUser() || template?.Config?.User || 'node',
    Entrypoint: template?.Config?.Entrypoint || ['openclaw'],
    Tty: false, OpenStdin: false,
    Cmd: template?.Config?.Cmd || ['gateway', '--allow-unconfigured'],
  });
  try {
    await require('./control-ui-patch').applyControlUiPatch(container, imageInfo.Id || image);
  } catch (error) {
    await container.remove({force: true}).catch(() => {});
    throw error;
  }
  return container.id;
}

async function getContainerLogs(containerId, tail = 200) {
  const container = docker.getContainer(containerId);
  const raw = await container.logs({
    stdout: true, stderr: true, tail, follow: false,
  });
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const chunks = [];
  let offset = 0;
  while (offset + 8 <= buffer.length && [1, 2].includes(buffer[offset]) && buffer[offset+1] === 0) {
    const length = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + length > buffer.length) break;
    chunks.push(buffer.subarray(offset + 8, offset + 8 + length)); offset += 8 + length;
  }
  return offset === buffer.length ? Buffer.concat(chunks).toString('utf8') : buffer.toString('utf8');

}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ── Local image cache management ─────────────────────────────────────────────
// Pre-pulling images into the local Docker store avoids registry timeouts at
// instance-creation time; createInstanceContainer then runs fully offline.

async function listLocalImages() {
  const images = await docker.listImages();
  return images
    .map((img) => ({
      id: img.Id.replace('sha256:', '').slice(0, 12),
      tags: img.RepoTags || [],
      size: img.Size,
      createdAt: new Date(img.Created * 1000).toISOString(),
      ...require('./image-purpose').imagePurpose(img.RepoTags || [], img.Labels || {}, DEFAULT_IMAGE),
    }))
    .filter((img) => img.tags.length > 0)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function listResourceContainers() {
  const rows = await docker.listContainers({ all: true });
  const result = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      let data;
      try { data = await docker.getContainer(row.Id).inspect(); }
      catch (err) { if (err.statusCode === 404) continue; throw err; }
      const h = data.HostConfig || {}, labels = data.Config?.Labels || {};
      const nanoCpus = h.NanoCpus || (h.CpuQuota > 0 ? h.CpuQuota / (h.CpuPeriod || 100000) * 1e9 : 0);
      result.push({ id: data.Id, name: (data.Name || '').replace(/^\//, ''),
        state: data.State?.Status, managed: labels['openclaw.managed'] === 'true',
        instanceId: labels['openclaw.instance'], resources: { nanoCpus, memoryBytes: h.Memory || 0 } });
    }
  }));
  return result;
}

async function removeImageInternal(image) {
  await docker.getImage(image).remove({ force: false });
}

// All entry points that can consume or change image references participate in
// the same cleanup guard, including asynchronous pulls after HTTP has replied.
async function pullImage(...args) {
  return require(path.join(__dirname, 'maintenance-guard')).use(() => pullImageInternal(...args));
}
async function createInstanceContainer(...args) {
  return require(path.join(__dirname, 'maintenance-guard')).use(() => createInstanceContainerInternal(...args));
}
async function removeImage(...args) {
  return require(path.join(__dirname, 'maintenance-guard')).use(() => removeImageInternal(...args));
}

function resourceOptions(r) {
  return { nanoCpus: r.nanoCpus ?? 0, cpuShares: r.cpuShares ?? 0, memory: r.memoryBytes ?? 0, pidsLimit: r.pidsLimit ?? 0 };
}
module.exports = {
  resolveImage, splitImageTag, resourceOptions, resolveSocketPath,
  docker,
  DEFAULT_IMAGE,
  MIRROR_PREFIX,
  GATEWAY_PORT_INTERNAL,
  shortDockerError,
  dockerInfo,
  listContainersByLabel,
  getContainer,
  pullImage,
  imageExists,
  getStats,
  inspectContainer,
  startContainer,
  stopContainer,
  restartContainer,
  removeContainer,
  updateResources,
  createInstanceContainer,
  getContainerLogs,
  randomToken,
  listLocalImages,
  listResourceContainers,
  removeImage,
};
