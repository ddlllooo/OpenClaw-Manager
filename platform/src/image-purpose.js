'use strict';

function repository(tag) {
  return String(tag).replace(/^(?:docker.io|index.docker.io|registry-1.docker.io)\//, '').split('@')[0].replace(/:[^/:]+$/, '');
}

function imagePurpose(tags, labels = {}, defaultImage = '') {
  const repos = tags.map(repository);
  const leaf = repos.map(r => r.split('/').pop());
  if (leaf.some(r => r === 'openclaw-manager') || labels['openclaw.manager'] === 'true') {
    return { kind: 'manager', purpose: '管理平台', selectable: false };
  }
  if (leaf.some(r => r.startsWith('openclaw-base-') || ['node', 'docker'].includes(r))) {
    return { kind: 'build-base', purpose: '构建基础镜像', selectable: false };
  }
  const source = String(labels['org.opencontainers.image.source'] || '').replace(/\.git$/, '').replace(/\/$/, '');
  if (leaf.includes('openclaw') || source === 'https://github.com/openclaw/openclaw' || repos.includes(repository(defaultImage))) {
    return { kind: 'runtime', purpose: 'OpenClaw 实例运行镜像', selectable: true };
  }
  return { kind: 'other', purpose: '其他镜像', selectable: false };
}

module.exports = { imagePurpose };
