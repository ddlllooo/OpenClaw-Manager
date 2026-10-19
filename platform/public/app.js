'use strict';

/* global io:false, Terminal:false, FitAddon:false */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const state = {
  instances: [],
  system: null,
  selectedId: null,
  stats: {},   // id -> latest stats
  health: {},  // id -> latest health
};

// Network rate accrual: SSE stats are cumulative byte counters, so per-sample
// rates come from the delta between consecutive samples (netRates[id] =
// { lastRx, lastTx, lastTs, rxRate, txRate }).
const netRates = {};

function netRateFor(id, net, ts) {
  const rx = Object.values(net || {}).reduce((a, n) => a + (n.rxBytes || 0), 0);
  const tx = Object.values(net || {}).reduce((a, n) => a + (n.txBytes || 0), 0);
  const acc = netRates[id] || {};
  if (Number.isFinite(acc.lastTs) && ts > acc.lastTs && rx >= acc.lastRx && tx >= acc.lastTx) {
    const dt = (ts - acc.lastTs) / 1000;
    acc.rxRate = Math.max(0, (rx - acc.lastRx) / dt);
    acc.txRate = Math.max(0, (tx - acc.lastTx) / dt);
  } else if (!Number.isFinite(acc.lastTs) || rx < acc.lastRx || tx < acc.lastTx) {
    // first sample or counter reset (container restarted) — skip this interval
    acc.rxRate = null;
    acc.txRate = null;
  }
  acc.lastRx = rx; acc.lastTx = tx; acc.lastTs = ts;
  netRates[id] = acc;
  return acc;
}

function fmtRate(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) return '–';
  return `${fmtBytes(bytesPerSec)}/s`;
}

// ── Utilities ────────────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let csrfToken = null;
let sessionPromise = null;
let viewEpoch = 0;
let pageActivity = null;
let liveSource = null;
const pendingActions = new Set();
async function ensureSession() {
  if (!sessionPromise) sessionPromise = fetch('/api/session', { credentials: 'same-origin' }).then(async response => {
    if (!response.ok) throw new Error('无法建立管理会话');
    csrfToken = (await response.json()).csrf;
  }).catch(error => { sessionPromise = null; throw error; });
  return sessionPromise;
}
async function api(path, opts = {}) {
  const epoch = viewEpoch;
  const requestId = /^\/api\/instances\/([a-z0-9_-]+)(?:\/|$)/i.exec(path)?.[1];
  const scoped = requestId && !['kept', 'recommendations'].includes(requestId);
  await ensureSession();
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    credentials: 'same-origin',
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (scoped && (epoch !== viewEpoch || requestId !== state.selectedId)) throw new DOMException('实例已切换', 'AbortError');
  if (res.status === 401) { csrfToken = null; sessionPromise = null; }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// Avoid replacing unchanged DOM nodes during monitoring and status refreshes.
function setHTML(element, html) {
  if (!element || element._lastHTML === html) return;
  element.innerHTML = html;
  element._lastHTML = html;
}

function logEvent(msg, cls = '') {
  const box = $('#eventLog');
  const line = document.createElement('div');
  line.className = `line ${cls}`;
  line.innerHTML = `<span class="t">${fmtTime(Date.now())}</span>${esc(msg)}`;
  box.prepend(line);
  while (box.children.length > 200) box.lastChild.remove();
}

const STATE_LABEL = {
  running: '运行中', exited: '已停止', paused: '已暂停', restarting: '重启中',
  created: '已创建', 'not-created': '待创建', missing: '容器缺失', dead: '异常',
  unknown: '未知', removing: '删除中',
};

function healthBadge(inst) {
  const h = state.health[inst.id] || inst.health;
  const s = inst.state;
  if (s !== 'running') {
    return `<span class="badge ${esc(s)}">${STATE_LABEL[s] || esc(s)}</span>`;
  }
  if (inst.error) return '<span class="badge health-degraded">状态不可用</span>';
  if (inst.dockerHealth === 'unhealthy') return '<span class="badge health-degraded">Docker 健康异常</span>';
  if (h && Date.now() - h.checkedAt > 30000) return '<span class="badge health-degraded">探测已过期</span>';
  if (h && h.live && h.ready) return '<span class="badge healthy">健康·就绪</span>';
  if (h && h.live && !h.ready) return '<span class="badge health-degraded">运行·未就绪</span>';
  if (h && h.liveCode === 0) return '<span class="badge health-degraded">启动中…</span>';
  return '<span class="badge health-degraded">健康检查失败</span>';
}

// ── Instance list ────────────────────────────────────────────────────────────
let instanceFilter = 'all';
function renderList() {
  const box = $('#instanceList');
  const countEl = $('#instanceCount');
  if (countEl) countEl.textContent = state.instances.length;
  const running = state.instances.filter(i => i.state === 'running').length;
  for (const [id, value] of Object.entries({totalInstances: state.instances.length, runningInstances: running, idleInstances: state.instances.length - running})) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }
  if (!state.instances.length) {
    setHTML(box, '<div class="empty">还没有实例<br>点击「开通新实例」开始使用</div>');
    return;
  }
  const kw = ($('#instanceSearch')?.value || '').trim().toLowerCase();
  const shown = state.instances.filter(i => (!kw || i.name.toLowerCase().includes(kw)) &&
    (instanceFilter === 'all' || (instanceFilter === 'running' ? i.state === 'running' : i.state !== 'running')));
  if (!shown.length) {
    setHTML(box, `<div class="empty">${kw ? `没有匹配「${esc(kw)}」的实例` : '当前状态下暂无实例'}<br><button class="btn small" data-reset-filter>重置筛选</button></div>`);
    return;
  }
  setHTML(box, shown.map((inst) => {
    const st = state.stats[inst.id];
    const statsTxt = st && inst.state === 'running'
      ? `<span>CPU ${st.cpuPercent}%</span><span>内存 ${fmtBytes(st.memUsed)}</span>`
      : '';    return `
      <button type="button" class="instance-item ${inst.id === state.selectedId ? 'active' : ''}" data-id="${esc(inst.id)}" aria-pressed="${inst.id === state.selectedId}">
        <div>
          <div class="name">${esc(inst.name)}</div>
          <div class="meta"><span>:${inst.port}</span>${statsTxt}</div>
        </div>
        ${healthBadge(inst)}
      </button>`;
  }).join(''));
}

function renderSystem() {
  const s = state.system;
  const el = $('#systemInfo');
  if (!s) { el.textContent = 'Docker 未连接'; return; }
  const memGiB = s.memTotalGiB ?? (s.memTotal ? (s.memTotal / 1024 ** 3).toFixed(1) : '–');
  el.innerHTML = `Docker <b>${esc(s.serverVersion)}</b> · ${s.ncpu} 核 · ${memGiB} GB 内存<br>
    ${s.disk ? `数据盘可用 <b>${fmtBytes(s.disk.available)}</b> / ${fmtBytes(s.disk.total)} · ` : ''}实例 <b>${s.instances ?? state.instances.length}</b> 个 · 运行中 <b>${state.instances.filter((i) => i.state === 'running').length}</b> 个`;
}

// ── Detail view ──────────────────────────────────────────────────────────────
// Detail page tabs. The active tab is remembered per session; switching tabs
// only toggles visibility (drafts in hidden tabs survive untouched).
const detailTabs = [
  { id: 'overview', label: '概览' },
  { id: 'channels', label: '模型与飞书' },
  { id: 'sessions', label: '会话' },
  { id: 'workspace', label: '工作区与记忆' },
  { id: 'automations', label: '定时任务' },
  { id: 'extensions', label: '技能与插件' },
  { id: 'failover', label: '模型故障切换' },
  { id: 'access', label: '飞书访问设置' },
  { id: 'agents', label: '多 Agent' },
  { id: 'terminal', label: '终端' },
  { id: 'config', label: '配置文件' },
  { id: 'logs', label: '日志' },
];
let activeDetailTab = 'overview';

function renderDetail() {
  const panel = $('#detailPanel');
  const inst = state.instances.find((i) => i.id === state.selectedId);
  if (!inst) {
    panel.innerHTML = `<div class="welcome">
      <div class="welcome-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><rect x="4" y="5" width="24" height="22" rx="4" stroke="currentColor" stroke-width="1.5"/><path d="M4 12h24M12 12v15" stroke="currentColor" stroke-width="1.5"/><path d="m17 18 3 3 5-5" stroke="currentColor" stroke-width="1.5"/></svg></div>
      <div class="eyebrow">你的本地 AI 工作空间</div>
      <h2>${state.instances.length ? '选择实例，继续你的工作' : '从第一个实例开始'}</h2>
      <p>${state.instances.length ? '在左侧选择实例，即可查看运行情况、管理模型与渠道，或打开控制台。' : '为不同任务创建独立的 OpenClaw 环境。配置、资源与运行状态，集中管理，一目了然。'}</p>
      <button class="btn primary" data-create-instance>＋ 开通新实例</button>
      <ol class="welcome-steps"><li><span class="step-number">01</span><b>选择镜像与资源</b><p>使用本地镜像，按推荐分配资源。</p></li><li><span class="step-number">02</span><b>开通独立实例</b><p>自动创建容器并分配访问端口。</p></li><li><span class="step-number">03</span><b>配置后开始使用</b><p>连接模型与渠道，打开控制台。</p></li></ol>
    </div>`;
    renderDetail._currentId = null;
    return;
  }
  // Same instance already on screen → patch live regions only, never rebuild
  // the panel (rebuilding would wipe in-progress edits in model/feishu forms).
  if (renderDetail._currentId === inst.id && $('#detailPanel .detail-title')) {
    renderDetailLive(inst);
    if (activeDetailTab === 'overview' && !document.hidden) drawSparkline();
    return;
  }
  // Instance actually changed: the old terminal socket would otherwise write
  // the old container's output into the new panel — tear it down first.
  if (renderDetail._currentId !== inst.id) { viewEpoch++; destroyTerminal(); resetInstanceFeatures(); lastModelConfig = null; clearInterval(logAutoTimer); logAutoTimer = null; }
  renderDetail._currentId = inst.id;
  const st = state.stats[inst.id];
  const h = state.health[inst.id] || inst.health;
  const r = inst.resources || {};
  const errBanner = inst.lastError
    ? `<div class="error-banner">⚠ 上次操作失败：${esc(inst.lastError)}
         <button class="btn small" data-act="clearError" style="margin-left:auto">清除提示</button>
         ${inst.state !== 'running' ? '<button class="btn small primary" data-act="start" style="margin-left:6px">重试启动</button>' : ''}
       </div>`
    : '';

  panel.innerHTML = `
    <div class="detail-title">
      <h2>${esc(inst.name)} ${healthBadge(inst)}
        <button class="btn small" data-act="rename" style="padding:1px 8px;font-size:11px" title="修改实例名称">改名</button>
      </h2>
      <div class="actions">
        <button class="btn small" data-act="chat">对话</button>
        <button class="btn small" data-act="openUI">打开控制台</button>
        ${inst.state === 'running'
          ? '<button class="btn small" data-act="restart">重启</button><button class="btn small danger" data-act="stop">停止</button>'
          : '<button class="btn small primary" data-act="start">启动</button>'}
        <button class="btn small danger" data-act="delete">删除</button>
      </div>
    </div>
    ${errBanner}
    <div class="detail-tabs">
      ${detailTabs.map((t) => `<button class="detail-tab ${t.id === activeDetailTab ? 'active' : ''}" data-detail-tab="${t.id}">${t.label}</button>`).join('')}
    </div>
    <div class="detail-body">

      <div class="detail-tabpage ${activeDetailTab === 'overview' ? '' : 'hidden'}" data-tabpage="overview">
      ${diagnosticsPanel()}
      <div class="detail-section">
        <h3>性能监测</h3>
        <div class="stat-cards">
          <div class="stat-card">
            <div class="label">CPU 占用（单核 100%）</div>
            <div class="value">${st ? st.cpuPercent : '–'}<small style="font-size:12px;color:var(--muted)"> %</small></div>
            <div class="sub">上限 ${r.cpus ? esc(r.cpus) + ' 核' : '未限制'}</div>
            <div class="bar"><i style="width:${Math.min(100, st ? st.cpuPercent / (r.cpus || state.system?.ncpu || 1) : 0)}%"></i></div>
          </div>
          <div class="stat-card">
            <div class="label">内存使用</div>
            <div class="value">${st ? fmtBytes(st.memUsed) : '–'}</div>
            <div class="sub">上限 ${r.memoryBytes ? fmtBytes(r.memoryBytes) : '未限制'}</div>
            <div class="bar"><i style="width:${st ? Math.min(100, st.memPercent) : 0}%"></i></div>
          </div>
          <div class="stat-card">
            <div class="label">网络速率</div>
            <div class="value" style="font-size:14px;line-height:1.5">
              ${st ? fmtRate(netRates[inst.id] ? netRates[inst.id].rxRate : null) : '–'} ↓<br>
              ${st ? fmtRate(netRates[inst.id] ? netRates[inst.id].txRate : null) : '–'} ↑
            </div>
            <div class="sub">${st ? '采样于 ' + fmtTime(st.ts) : '等待采样'}</div>
          </div>
        </div>
        <canvas id="perfSpark" class="perf-spark" width="600" height="48"></canvas>
        ${h && inst.state === 'running' ? `<div class="sub health-probe" style="margin-top:8px;color:var(--muted)">
          健康探测：/healthz ${h.live ? '✅' : '❌'}（HTTP ${h.liveCode}）· /readyz ${h.ready ? '✅' : '❌'}（HTTP ${h.readyCode}）· ${fmtTime(h.checkedAt)}</div>` : '<div class="sub health-probe" style="margin-top:8px;color:var(--muted)"></div>'}
      </div>

      <div class="detail-section">
        <h3>访问信息</h3>
        <div class="kv-grid">
          <div class="kv"><div class="k">控制台地址</div>
            <div class="v mono"><a href="${esc(inst.uiUrl)}" target="_blank" style="color:var(--accent-ink);font-weight:600">${esc(inst.uiUrl)}</a></div></div>
          <div class="kv"><div class="k">Gateway Token</div>
            <div class="v mono" id="tokenCell">
              <span id="tokenMasked">••••••••••••</span><span id="tokenFull" class="hidden"></span>
              <button class="btn small" data-act="toggleToken" style="margin-left:6px;padding:1px 8px;font-size:11px">显示</button>
              <button class="btn small" data-act="copyToken" style="padding:1px 8px;font-size:11px">复制</button>
            </div></div>
          <div class="kv"><div class="k">实例 ID</div><div class="v mono">${esc(inst.id)}</div></div>
          <div class="kv"><div class="k">镜像</div><div class="v mono">${esc(inst.image)}</div></div>
        </div>
        <div class="security-note">⚠ 配置目录含 Gateway Token 与凭据，请按敏感文件对待。</div>
      </div>

      <div class="detail-section">
        <h3>资源配置</h3>
        <div class="kv-grid res-grid">
          <div class="kv"><div class="k">CPU 核数</div><div class="v">${r.cpus ? esc(r.cpus) + ' 核' : '未限制'}</div></div>
          <div class="kv"><div class="k">内存上限</div><div class="v">${r.memoryBytes ? fmtBytes(r.memoryBytes) : '未限制'}</div></div>
          <div class="kv"><div class="k">CPU 份额</div><div class="v">${r.cpuShares ? esc(r.cpuShares) : '默认'}</div></div>
          <div class="kv"><div class="k">进程数上限</div><div class="v">${r.pidsLimit ? esc(r.pidsLimit) : '默认'}</div></div>
        </div>
        <div class="config-actions">
          <input type="number" id="resCpus" class="input" placeholder="CPU 核数" step="0.1" min="0.1" style="width:110px" value="${r.cpus ?? ''}">
          <input type="text" id="resMem" class="input" placeholder="内存 如 512m" style="width:120px" value="${r.memoryBytes ? String(r.memoryBytes) : ''}">
          <button class="btn small" data-act="saveRes">应用资源限制</button>
        </div>
      </div>
      </div>

      <div class="detail-tabpage ${activeDetailTab === 'channels' ? '' : 'hidden'}" data-tabpage="channels">
      <div class="detail-section">
        <h3>模型配置</h3>
        <div id="modelDefault" class="model-default-card">加载中…</div>
        <div id="modelList" class="model-list" style="margin:10px 0"></div>
        <div class="model-toolbar">
          <button class="btn small primary" id="btnToggleAddModel">＋ 添加模型</button>
          <button class="btn small" data-act="reloadModel" title="重新读取实例里已保存的模型">重新加载</button>
          <span class="save-hint" id="modelHint"></span>
        </div>
        <div id="addModelForm" class="add-model-form hidden">
          <div class="add-model-grid">
            <label class="am-label">模型名称
              <input type="text" id="mModel" class="input" placeholder="如 gpt-4o-mini / deepseek-chat" spellcheck="false">
            </label>
            <label class="am-label">上下文长度（tokens，新增留空自动识别；编辑留空保留）
              <input type="number" id="mContextWindow" class="input" placeholder="自动识别，支持 1M 等实际窗口" min="1024" max="10000000" step="1">
            </label>
            <label class="am-label">输入模态
              <select id="mInput" class="input"><option value="auto">自动识别</option><option value="text">文本</option><option value="image">文本＋图像（视觉）</option></select>
            </label>
            <label class="am-label">base_url
              <input type="text" id="mBaseUrl" class="input" placeholder="https://api.openai.com/v1" spellcheck="false">
            </label>
            <label class="am-label">api_key
              <input type="password" id="mApiKey" class="input" placeholder="留空 = 沿用该模型已存的 key" autocomplete="new-password">
            </label>
          </div>
          <div class="config-actions">
            <label class="am-copy">复用现有模型的凭据
              <select id="mCopyFrom" class="input"><option value="">不复制，手动填写</option></select>
            </label>
            <label class="am-copy" style="flex-direction:row;align-items:center;gap:6px">
              <input type="checkbox" id="mSetDefault" checked style="width:auto;margin:0"> 设为当前使用的模型
            </label>
            <span style="flex:1"></span>
            <button class="btn small" data-act="detectAddModel">识别模型能力</button>
            <button class="btn small" id="btnCancelAddModel">取消</button>
            <button class="btn small primary" data-act="saveModel">保存模型</button>
          </div>
          <div class="reco-note">同一供应商的多个模型可共用一个 api_key：填一个模型后，其余用「复用现有模型的凭据」即可，无需重复粘贴密钥。</div>
        </div>
        <div id="editModelForm" class="add-model-form hidden">
          <div class="am-title">编辑模型 <b id="emName"></b></div>
          <div class="add-model-grid">
            <label class="am-label">模型名称（修改后保存为改名）
              <input type="text" id="emNewName" class="input" placeholder="如 gpt-4o-mini" spellcheck="false">
            </label>
            <label class="am-label">上下文长度（tokens，新增留空自动识别；编辑留空保留）
              <input type="number" id="emContextWindow" class="input" placeholder="留空保留原值" min="1024" max="10000000" step="1">
            </label>
            <label class="am-label">输入模态
              <select id="emInput" class="input"><option value="keep">保持原值</option><option value="auto">重新自动识别</option><option value="text">文本</option><option value="image">文本＋图像（视觉）</option></select>
            </label>
            <label class="am-label">base_url
              <input type="text" id="emBaseUrl" class="input" placeholder="https://api.openai.com/v1" spellcheck="false">
            </label>
            <label class="am-label" id="emKeyLabel">api_key（留空 = 保持原值）
              <input type="password" id="emApiKey" class="input" placeholder="不修改请留空" autocomplete="new-password">
            </label>
          </div>
          <div class="config-actions">
            <span style="flex:1"></span>
            <button class="btn small" data-act="detectEditModel">识别模型能力</button>
            <button class="btn small" id="btnCancelEditModel">取消</button>
            <button class="btn small primary" id="btnSaveEditModel">保存修改</button>
          </div>
          <div class="reco-note" id="emNote"></div>
        </div>
      </div>

      <div class="detail-section">
        <h3>飞书频道</h3>
        <div class="kv-grid" id="feishuSummary">加载中…</div>
        <div class="config-actions" style="flex-wrap:wrap;gap:8px">
          <input type="text" id="fAppId" class="input" placeholder="飞书应用 App ID（cli_xxx）" style="width:240px">
          <input type="password" id="fAppSecret" class="input" placeholder="App Secret（留空保持不变）" style="width:220px">
        </div>
        <div class="config-actions">
          <button class="btn small" data-act="reloadFeishu">重新加载</button>
          <button class="btn small primary" data-act="saveFeishu">保存并连接飞书</button>
          <button class="btn small" data-act="testFeishu">检测连接</button>
          <span class="save-hint" id="feishuHint"></span>
        </div>
        <div class="security-note">需在飞书开放平台创建企业自建应用并开启机器人能力；保存后实例会自动重启以建立 WebSocket 长连接。</div>
      </div>
      </div>

      <div class="detail-tabpage ${activeDetailTab === 'sessions' ? '' : 'hidden'}" data-tabpage="sessions">
      <div class="detail-section">
        <h3>交互式会话管理</h3>
        <div class="config-actions" style="margin:0 0 10px;flex-wrap:wrap">
          <input type="search" id="sessFilter" class="input" placeholder="过滤会话…" style="width:170px">
          <select id="sessLimit" class="input" style="width:120px">
            <option value="50">最近 50 条</option>
            <option value="100" selected>最近 100 条</option>
            <option value="500">最近 500 条</option>
            <option value="all">全部</option>
          </select>
          <button class="btn small" data-act="reloadSessions">刷新列表</button>
          <button class="btn small danger" data-act="sessDelSelected">删除选中</button>
          <button class="btn small" data-act="sessArchiveSelected">归档选中</button>
          <span class="save-hint" id="sessHint"></span>
        </div>
        <div id="sessList" class="sess-list">加载中…</div>
      </div>
      <div class="detail-section" id="sessDetailSection" style="display:none">
        <div class="detail-head" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <h3 style="margin:0" id="sessDetailTitle">会话详情</h3>
          <span class="reco-note" id="sessDetailMeta" style="margin:0"></span>
          <span style="flex:1"></span>
          <button class="btn small" data-act="closeSession">关闭</button>
        </div>
        <div id="sessTranscript" class="sess-transcript"></div>
        <div class="config-actions" style="gap:8px">
          <input type="text" id="sessInput" class="input" placeholder="继续此会话：输入消息，Enter 发送" style="flex:1">
          <button class="btn small primary" id="btnSessSend">发送</button>
        </div>
        <div class="config-actions" style="gap:8px">
          <button class="btn small" data-act="sessCompact">压缩此会话（LLM 摘要）</button>
          <button class="btn small" data-act="sessCompactTail">截断保留末尾 200 行</button>
          <span class="save-hint" id="sessDetailHint"></span>
        </div>
        <div class="security-note">发送消息会通过实例网关在此会话中追加一个 agent 回合（tool 调用结果仅显示前 4000 字符）。</div>
      </div>
      </div>

      <div class="detail-tabpage ${activeDetailTab === 'terminal' ? '' : 'hidden'}" data-tabpage="terminal">
      <div class="detail-section">
        <h3>容器终端</h3>
        <div class="term-toolbar">
          <span class="term-target" id="termTarget">未连接</span>
          <span class="term-hint" id="termHint"></span>
          <span style="flex:1"></span>
          <button class="btn small" data-act="termReconnect" id="btnTermReconnect" title="关闭当前 shell 并重新连接">重新连接</button>
          <button class="btn small" data-act="termClear" title="清空终端屏幕">清屏</button>
        </div>
        <div id="termWrap" class="term-wrap"></div>
        <div class="security-note" id="termNote">终端直接进入实例容器（bash，node 用户，工作目录 /home/node），拥有配置文件与凭据的完整读写权限，请谨慎操作。顶部工具栏可重新连接或清屏。</div>
      </div>
      </div>

      <div class="detail-tabpage ${activeDetailTab === 'config' ? '' : 'hidden'}" data-tabpage="config">
      <div class="detail-section">
        <h3>OpenClaw 配置</h3>
        <div class="tabs" style="display:flex;gap:8px;margin-bottom:10px">
          <button class="btn small tab active" data-tab="json">openclaw.json</button>
          <button class="btn small tab" data-tab="env">环境变量 (.env)</button>
        </div>
        <div id="tab-json">
          <textarea id="configEditor" spellcheck="false">加载中…</textarea>
          <div class="json-error" id="jsonError"></div>
          <div class="config-actions">
            <button class="btn small" data-act="reloadCfg">重新加载</button>
            <button class="btn small" data-act="fmtCfg">格式化 JSON</button>
            <button class="btn small primary" data-act="saveCfg">保存配置</button>
            <button class="btn small" data-act="saveCfgRestart">保存并重启</button>
            <span class="save-hint" id="cfgHint"></span>
          </div>
        </div>
        <div id="tab-env" class="hidden">
          <textarea id="envEditor" spellcheck="false">加载中…</textarea>
          <div class="config-actions">
            <button class="btn small" data-act="reloadEnv">重新加载</button>
            <button class="btn small primary" data-act="saveEnv">保存环境变量</button>
            <span class="save-hint" id="envHint"></span>
          </div>
          <div class="security-note">保存后需重启实例生效。密钥值在读取时已脱敏显示；包含掩码（****）的行保存时会自动还原为原值。</div>
        </div>
      </div>
      </div>

      ${featurePages(activeDetailTab)}
      ${managementPages(activeDetailTab)}
      <div class="detail-tabpage ${activeDetailTab === 'logs' ? '' : 'hidden'}" data-tabpage="logs">
      <div class="detail-section">
        <h3>容器日志</h3>
        <div class="config-actions" style="margin:0 0 8px">
          <select id="logTail" class="input" style="width:110px">
            <option value="200">最近 200 行</option>
            <option value="500">最近 500 行</option>
            <option value="1000">最近 1000 行</option>
            <option value="5000">最近 5000 行</option>
          </select>
          <input type="search" id="logFilter" class="input" placeholder="关键字过滤…" style="width:180px">
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--muted);user-select:none">
            <input type="checkbox" id="logAuto" style="width:auto;margin:0"> 自动刷新
          </label>
          <button class="btn small" data-act="reloadLogs">刷新</button>
          <button class="btn small" data-act="downloadLogs">下载</button>
        </div>
        <textarea id="logView" readonly style="min-height:260px">加载中…</textarea>
      </div>
      </div>
    </div>`;

  if (activeDetailTab === 'config') { loadConfig('json'); loadConfig('env'); }
  if (activeDetailTab === 'logs') loadLogs();
  if (activeDetailTab === 'channels') { loadModelConfig(); loadFeishuConfig(); }
  if (activeDetailTab === 'sessions') { sessState.selectedId = null; sessState.messages = null; loadSessions(); }
  if (activeDetailTab === 'terminal') ensureTerminal();
  api(`/api/instances/${inst.id}/history`).then(data => {
    perfHistory[inst.id] = (data.samples || []).map(sample => ({cpu: sample.cpuPercent, mem: sample.memPercent, ts: sample.ts}));
    drawSparkline();
  }).catch(() => {});
  renderDetailLive(inst);
  loadFeatureTab(activeDetailTab);
}

// Patch the live regions of an already-rendered detail panel: title badge,
// health probe line, action buttons and resource readouts. Form sections
// (model/feishu/config editors) are deliberately untouched so user input
// survives background refreshes.
function renderDetailLive(inst) {
  const h = state.health[inst.id] || inst.health;
  const r = inst.resources || {};
  const title = $('#detailPanel .detail-title h2');
  if (title) {
    // Patch only the name text and badge — the inline 改名 button must
    // survive background refreshes (it lives inside the h2).
    const badgeHtml = healthBadge(inst);
    const nameSig = `${esc(inst.name)}|${badgeHtml}`;
    if (title.dataset.nameSig !== nameSig) {
      title.dataset.nameSig = nameSig;
      const renameBtn = title.querySelector('[data-act="rename"]');
      title.textContent = inst.name + ' ';
      title.insertAdjacentHTML('beforeend', badgeHtml);
      if (renameBtn) title.appendChild(renameBtn);
    }
  }

  const actions = $('#detailPanel .detail-title .actions');
  if (actions) {
    const want = inst.state === 'running'
      ? ['chat', 'openUI', 'restart', 'stop', 'delete']
      : ['chat', 'openUI', 'start', 'delete'];
    const have = [...actions.querySelectorAll('button')].map((b) => b.dataset.act);
    if (have.join(',') !== want.join(',')) {
      actions.innerHTML = `
        <button class="btn small" data-act="chat">对话</button>
        <button class="btn small" data-act="openUI">打开控制台</button>
        ${inst.state === 'running'
          ? '<button class="btn small" data-act="restart">重启</button><button class="btn small danger" data-act="stop">停止</button>'
          : '<button class="btn small primary" data-act="start">启动</button>'}
        <button class="btn small danger" data-act="delete">删除</button>`;
    } else {
      // Same action set: release buttons left disabled/busy by a finished action.
      for (const b of actions.querySelectorAll('button')) {
        const label = { chat: '对话', openUI: '打开控制台', restart: '重启', stop: '停止', start: '启动', delete: '删除' }[b.dataset.act];
        if (b.dataset.act in BUSY_ACTIONS) b.disabled = pendingActions.has(inst.id);
        if (label && b.textContent !== label && !pendingActions.has(inst.id)) b.textContent = label;
      }
    }
  }

  for (const button of $$('#detailPanel [data-act]')) {
    if (['chat','openUI','saveModel','saveFeishu','testModel','testFeishu','testModelConn','detectAddModel','detectEditModel'].includes(button.dataset.act)) button.disabled = inst.state !== 'running';
  }
  const probe = $('#detailPanel .health-probe');
  if (probe) {
    setHTML(probe, h && inst.state === 'running'
      ? `健康探测：/healthz ${h.live ? '✅' : '❌'}（HTTP ${h.liveCode}）· /readyz ${h.ready ? '✅' : '❌'}（HTTP ${h.readyCode}）· ${fmtTime(h.checkedAt)}`
      : '');
  }

  // lastError banner: appears/clears as the record changes; never rebuilt
  // blindly (that would wipe other live regions) — just add/remove the node.
  const existing = $('#detailPanel .error-banner');
  if (inst.lastError && !existing) {
    const bar = document.createElement('div');
    bar.className = 'error-banner';
    bar.innerHTML = `⚠ 上次操作失败：${esc(inst.lastError)}
      <button class="btn small" data-act="clearError" style="margin-left:auto">清除提示</button>
      ${inst.state !== 'running' ? '<button class="btn small primary" data-act="start" style="margin-left:6px">重试启动</button>' : ''}`;
    $('#detailPanel .detail-title').after(bar);
  } else if (!inst.lastError && existing) {
    existing.remove();
  }

  const resGrid = $('#detailPanel .res-grid');
  const resourceSignature = JSON.stringify(r);
  if (resGrid && resGrid.dataset.signature !== resourceSignature) {
    resGrid.dataset.signature = resourceSignature;
    resGrid.innerHTML = `
      <div class="kv"><div class="k">CPU 核数</div><div class="v">${r.cpus ? esc(r.cpus) + ' 核' : '未限制'}</div></div>
      <div class="kv"><div class="k">内存上限</div><div class="v">${r.memoryBytes ? fmtBytes(r.memoryBytes) : '未限制'}</div></div>
      <div class="kv"><div class="k">CPU 份额</div><div class="v">${r.cpuShares ? esc(r.cpuShares) : '默认'}</div></div>
      <div class="kv"><div class="k">进程数上限</div><div class="v">${r.pidsLimit ? esc(r.pidsLimit) : '默认'}</div></div>`;
  }
}

// ── Interactive terminal (per-instance docker exec shell) ────────────────────
// One WebSocket + xterm.js per open detail panel. Instance switches or panel
// rebuilds tear the socket down; reopening the 终端 tab reconnects. Output is
// written binary-frame → terminal.write; keystrokes go back as binary frames.
const termState = { id: null, ws: null, term: null, fit: null, resizeObs: null, manualClose: false, attempts: 0, reconnectTimer: null };

const TERM_MAX_ATTEMPTS = 5;
const TERM_RETRY_MS = 3000;

function termHint(msg, cls = '') {
  const el = $('#termHint');
  if (!el) return;
  el.textContent = msg || '';
  el.className = `term-hint ${cls}`;
}

function termTargetText(inst) {
  if (!inst) return '未选择实例';
  return `${inst.containerName || `openclaw-${inst.id}`} · :${inst.port}`;
}

function termTargetEl() {
  const el = $('#termTarget');
  const inst = state.instances.find((i) => i.id === termState.id);
  if (el) el.textContent = termTargetText(inst);
}

// xterm UMD bundles expose either the class or a namespace directly on window
// depending on the build; accept both shapes.
function termCtors() {
  const t = window.Terminal && typeof window.Terminal.Terminal === 'function' ? window.Terminal.Terminal : window.Terminal;
  const f = window.FitAddon && typeof window.FitAddon.FitAddon === 'function' ? window.FitAddon.FitAddon : window.FitAddon;
  return { t, f };
}

let terminalAssetsPromise = null;
function loadTerminalAssets() {
  if (terminalAssetsPromise) return terminalAssetsPromise;
  const load = (tag, attributes) => new Promise((resolve, reject) => {
    const element = document.createElement(tag);
    Object.assign(element, attributes);
    element.onload = resolve;
    element.onerror = () => { element.remove(); reject(new Error('终端组件加载失败，请重新打开终端重试')); };
    document.head.appendChild(element);
  });
  terminalAssetsPromise = Promise.all([
    load('link', {rel: 'stylesheet', href: '/vendor/xterm.css'}),
    load('script', {src: '/vendor/xterm.js'}).then(() => load('script', {src: '/vendor/addon-fit.js'})),
  ]).catch(error => { terminalAssetsPromise = null; throw error; });
  return terminalAssetsPromise;
}
async function ensureTerminal() {
  const id = state.selectedId;
  if (!id || document.hidden || activeDetailTab !== 'terminal') return;
  try {
    await loadTerminalAssets();
    if (state.selectedId === id && !document.hidden && activeDetailTab === 'terminal') ensureTerminalReady();
  } catch (error) { if (state.selectedId === id) termHint(error.message, 'err'); }
}
function ensureTerminalReady() {
  const inst = state.instances.find((i) => i.id === state.selectedId);
  const wrap = $('#termWrap');
  if (!wrap) return;
  if (!inst) {
    destroyTerminal();
    wrap.innerHTML = '<div class="empty">从左侧选择一个实例后打开终端。</div>';
    termHint('');
    return;
  }
  if (inst.state !== 'running') { destroyTerminal(); termHint('实例未运行，请先启动', 'warn'); return; }
  // Same instance with a live terminal surface → just sync its size and make
  // sure the socket is alive (a dead shell reconnects transparently).
  const alive = termState.id === inst.id && termState.term && termState.term.element && termState.term.element.isConnected;
  if (alive) {
    resizeTerminal();
    if (!termState.ws || termState.ws.readyState >= 2) connectTerminal(inst.id);
    return;
  }
  destroyTerminal();
  termState.id = inst.id;
  wrap.innerHTML = '';
  termTargetEl();
  connectTerminal(inst.id);
}

function connectTerminal(id) {
  if (termState.id !== id) return;
  if (termState.ws && termState.ws.readyState <= 1) return; // connecting or open
  const { t: TerminalCtor, f: FitCtor } = termCtors();
  if (typeof TerminalCtor !== 'function' || typeof FitCtor !== 'function') {
    termHint('xterm.js 未加载（public/vendor 缺失），终端不可用', 'err');
    return;
  }
  // Fresh terminal surface per connection (auto-reconnect path included).
  if (termState.term) { try { termState.term.dispose(); } catch { /* noop */ } termState.term = null; }
  const wrap = $('#termWrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  termState.manualClose = false;
  termHint('连接中…');

  const term = new TerminalCtor({
    cursorBlink: !document.hidden && activeDetailTab === 'terminal',
    fontSize: 12.5,
    fontFamily: '"SF Mono", Menlo, ui-monospace, monospace',
    theme: {
      background: '#202c28',
      foreground: '#f2ede6',
      cursor: '#527568',
      cursorAccent: '#2b2622',
      selectionBackground: 'rgba(126, 158, 139, .35)',
    },
    scrollback: 5000,
  });
  const fit = new FitCtor();
  term.loadAddon(fit);
  term.open(wrap);
  termState.term = term;
  termState.fit = fit;
  try { fit.fit(); } catch { /* container may be hidden */ }

  term.onData((data) => {
    const ws = termState.ws;
    if (ws && ws.readyState === 1) ws.send(new TextEncoder().encode(data));
  });

  // Panel/container resize: re-fit and propagate cols/rows as a JSON frame.
  if (termState.resizeObs) termState.resizeObs.disconnect();
  termState.resizeObs = new ResizeObserver(() => resizeTerminal());
  termState.resizeObs.observe(wrap);
  window.addEventListener('resize', resizeTerminal);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  termState.lastSize = null;
  const ws = new WebSocket(`${proto}://${location.host}/api/instances/${encodeURIComponent(id)}/terminal`);
  ws.binaryType = 'arraybuffer';
  termState.ws = ws;

  ws.onopen = () => {
    if (termState.ws !== ws) return;
    termState.attempts = 0;
    termHint('');
    sendTerminalResize();
  };
  ws.onmessage = (e) => {
    if (termState.ws !== ws) return;
    if (typeof e.data === 'string') {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'error') {
        term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
        termHint(msg.message, 'err');
      } else if (msg.type === 'exit') {
        term.write(`\r\n\x1b[33mshell 已退出（code ${msg.code}）。点击「重新连接」开启新会话。\x1b[0m\r\n`);
        termHint('shell 已退出，可重新连接', 'warn');
      }
      return;
    }
    term.write(new Uint8Array(e.data));
  };
  ws.onclose = () => {
    if (termState.ws !== ws) return; // a newer socket took over
    termState.ws = null;
    if (termState.id !== id || termState.manualClose) return;
    termState.attempts += 1;
    if (termState.attempts >= TERM_MAX_ATTEMPTS) {
      termHint('多次连接失败（实例未运行？），启动实例后点「重新连接」', 'err');
      return;
    }
    termHint('连接已断开，3 秒后自动重连…', 'warn');
    if (termState.reconnectTimer) clearTimeout(termState.reconnectTimer);
    termState.reconnectTimer = setTimeout(() => {
      termState.reconnectTimer = null;
      // Only reconnect while this instance's terminal tab is still on screen.
      const page = document.querySelector('[data-tabpage="terminal"]');
      if (!document.hidden && state.selectedId === id && page && !page.classList.contains('hidden')) connectTerminal(id);
    }, TERM_RETRY_MS);
  };
  ws.onerror = () => { /* onclose follows */ };
}

function sendTerminalResize() {
  const ws = termState.ws;
  const { term, fit } = termState;
  if (!ws || ws.readyState !== 1 || !term || !fit) return;
  try { fit.fit(); } catch { /* not renderable yet */ }
  const size = `${term.cols}x${term.rows}`;
  if (termState.lastSize === size) return;
  termState.lastSize = size;
  ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
}

function resizeTerminal() {
  if (!termState.term || !termState.fit || document.hidden) return;
  const page = document.querySelector('[data-tabpage="terminal"]');
  if (!page || page.classList.contains('hidden')) return;
  sendTerminalResize();
}

function destroyTerminal() {
  if (termState.reconnectTimer) { clearTimeout(termState.reconnectTimer); termState.reconnectTimer = null; }
  termState.manualClose = true;
  termState.attempts = 0;
  if (termState.resizeObs) { termState.resizeObs.disconnect(); termState.resizeObs = null; }
  window.removeEventListener('resize', resizeTerminal);
  if (termState.ws) {
    const ws = termState.ws;
    termState.ws = null;
    try { ws.close(); } catch { /* noop */ }
  }
  if (termState.term) {
    try { termState.term.dispose(); } catch { /* noop */ }
    termState.term = null;
    termState.fit = null;
  }
}

function reconnectTerminal() {
  const id = state.selectedId;
  if (!id) return;
  destroyTerminal();
  termState.id = id;
  const wrap = $('#termWrap');
  if (wrap) wrap.innerHTML = '';
  termTargetEl();
  connectTerminal(id);
}

// ── Model config ─────────────────────────────────────────────────────────────
// The model section is NEVER refreshed automatically (no polling, no SSE, no
// timer): it loads once when the detail panel opens, and afterwards updates
// only when the user clicks 重新加载 or after an explicit save. This guarantees
// nothing can wipe in-progress form input.
let lastModelConfig = null;

async function loadModelConfig() {
  const card = $('#modelDefault');
  if (!card) return;
  try {
    const m = await api(`/api/instances/${state.selectedId}/model`);
    lastModelConfig = m;
    renderModelDefaultCard(m);
    renderModelList(m);
    renderCopyFromOptions(m);
    fillAddModelForm(m);
    if (state.instances.find(i => i.id === state.selectedId)?.state !== 'running') {
      for (const button of $$('#modelList button, #modelDefault button')) button.disabled = true;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    card.textContent = `加载失败: ${err.message}`;
  }
}

// "Current model" hero card: what's live right now + test button.
function renderModelDefaultCard(m) {
  const card = $('#modelDefault');
  if (!card) return;
  if (!m.configured) {
    card.innerHTML = '<div class="md-name">未配置模型</div><div class="md-meta">在下方添加第一个模型；也可以用「复用现有模型的凭据」快速添加。</div>';
    return;
  }
  const dm = m.defaultModel || '';
  const mid = dm.includes('/') ? dm.split('/').slice(1).join('/') : (m.models[0] ? m.models[0].id : '');
  const entry = m.models.find((x) => x.id === mid);
  const ctx = entry && entry.contextWindow ? `${entry.contextWindow.toLocaleString()} tokens` : '未设置（建议识别）';
  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <div class="md-name">${esc(mid || '未设置')} <span class="badge healthy">当前使用</span></div>
        <div class="md-meta">${esc(m.baseUrl || '—')} · key ${m.hasApiKey ? esc(m.apiKeyMasked) : '未设置'} · ${modelInputLabel(entry)} · 上下文 ${ctx}</div>
      </div>
      <button class="btn small" data-act="testModel">测试连通</button>
    </div>`;
}

// Options for "复用现有模型的凭据" — one per saved model that has a key.
function renderCopyFromOptions(m) {
  const sel = $('#mCopyFrom');
  if (!sel) return;
  const opts = (m.models || []).filter((mm) => mm.hasApiKey);
  sel.innerHTML = '<option value="">不复制，手动填写</option>' +
    opts.map((mm) => `<option value="${esc(mm.id)}">${esc(mm.id)}（${esc(mm.apiKeyMasked)}）</option>`).join('');
}

// Prefill the add-form from the active provider so adding a sibling model is
// 3 keystrokes; user edits are never overwritten (data-dirty guards).
function fillAddModelForm(m) {
  const baseUrl = $('#mBaseUrl');
  if (baseUrl && m.configured && m.baseUrl && !baseUrl.dataset.dirty) baseUrl.value = m.baseUrl;
}

// Saved-model switcher: one row per model showing ITS OWN base_url/masked
// key, with inline 测试 / 设为默认 / 复制凭据 / 删除 actions.
function renderModelList(m) {
  const box = $('#modelList');
  if (!box) return;
  const models = (m && m.models) || [];
  if (!models.length) {
    box.innerHTML = '<div class="reco-note">尚未添加模型。点「＋ 添加模型」开始配置。</div>';
    return;
  }
  const defaultMid = (m.defaultModel || '').replace(`${m.providerId}/`, '');
  box.innerHTML = models.map((mm) => {
    const isDefault = mm.id === defaultMid;
    return `
    <div class="model-row">
      <div class="mr-main">
        <span class="mr-name">${esc(mm.id)}${isDefault ? ' <span class="badge healthy">当前使用</span>' : ''}</span>
        <span class="mr-cred">${esc(mm.baseUrl || '—')} · key ${mm.hasApiKey ? esc(mm.apiKeyMasked) : '未设置'}</span>
      </div>
      <div class="mr-actions">
        <span class="mr-ctx" title="已保存的输入模态与上下文窗口">${modelInputLabel(mm)} · ctx ${mm.contextWindow ? esc(String(mm.contextWindow)) : '未设置'}</span>
        <button class="btn small" data-model-test="${esc(mm.id)}" title="用该模型跑一次真实 agent 回合">测试</button>
        <button class="btn small" data-model-edit="${esc(mm.id)}" title="修改该模型的名称 / base_url / api_key / 上下文长度">编辑</button>
        ${isDefault
          ? '<span class="badge healthy">使用中</span>'
          : `<button class="btn small" data-model-switch="${esc(mm.id)}" title="切换整套配置：base_url/api_key/模型一并生效">设为默认</button>`}
        <button class="btn small danger" data-model-del="${esc(mm.id)}"${isDefault ? ' disabled title="先切换到其他模型后再删除"' : ''}>删除</button>
      </div>
    </div>`;
  }).join('');
}

async function switchDefaultModel(mid) {
  const hint = $('#modelHint');
  hint.textContent = '切换中…';
  try {
    const r = await api(`/api/instances/${state.selectedId}/model/default`, { method: 'PUT', body: JSON.stringify({ model: mid }) });
    hint.textContent = r.hint || '已切换';
    logEvent(`已切换整体配置到模型 ${r.model}`, 'ok');
    // The provider baseUrl changed with the switch; reload the whole section.
    const baseUrl = $('#mBaseUrl');
    if (baseUrl) baseUrl.dataset.dirty = '';
    loadModelConfig();
  } catch (err) {
    if (err.name === 'AbortError') return;
    hint.textContent = `失败: ${err.message}`;
    logEvent(`模型切换失败: ${err.message}`, 'err');
  }
}

// Per-row connectivity test for an already-saved model.
async function testSavedModel(mid) {
  const hint = $('#modelHint');
  hint.textContent = `测试 ${mid} 中（最长约 90 秒）…`;
  try {
    const r = await api(`/api/instances/${state.selectedId}/model/test`, { method: 'POST', body: JSON.stringify({ model: mid }) });
    hint.textContent = `${mid} 连通正常，回复：${r.reply || '(空)'}`;
    logEvent(`模型连通测试通过: ${mid}`, 'ok');
  } catch (err) {
    if (err.name === 'AbortError') return;
    hint.textContent = `${mid} 测试失败: ${err.message}`;
    logEvent(`模型连通测试失败: ${mid} — ${err.message}`, 'err');
  }
}

// Copy a saved model's base_url (+ its key id) into the add-form, so a
// sibling model on the same provider is one keystroke away.
function copyModelCred(mid) {
  const m = lastModelConfig;
  const entry = m && (m.models || []).find((x) => x.id === mid);
  if (!entry) return;
  const form = $('#addModelForm');
  if (form && form.classList.contains('hidden')) toggleAddModelForm(true);
  const baseUrl = $('#mBaseUrl');
  if (baseUrl) {
    baseUrl.value = entry.baseUrl || '';
    baseUrl.dataset.dirty = '1';
  }
  const copySel = $('#mCopyFrom');
  if (copySel) copySel.value = mid;
  const hint = $('#modelHint');
  hint.textContent = `已带入 ${mid} 的 base_url；保存时将复用它的 api_key，只需填写新模型名。`;
}

// ── Edit an existing model (name / base_url / key / contextWindow) ──────────
function modelInputLabel(entry) {
  return entry?.input?.includes('image') ? '文本＋图像' : entry?.input?.includes('text') ? '文本' : '模态未设置';
}
let editingModel = null;
let editingModelSnapshot = null;

function openEditModel(mid) {
  const m = lastModelConfig;
  const entry = m && (m.models || []).find((x) => x.id === mid);
  if (!entry) return;
  editingModel = mid;
  editingModelSnapshot = structuredClone(entry);
  // Hide the add-form to keep a single visible editor at a time.
  const addForm = $('#addModelForm');
  if (addForm && !addForm.classList.contains('hidden')) toggleAddModelForm(false);
  const form = $('#editModelForm');
  form.classList.remove('hidden');
  $('#emName').textContent = mid;
  $('#emNewName').value = mid;
  $('#emBaseUrl').value = entry.baseUrl || '';
  $('#emApiKey').value = '';
  $('#emContextWindow').value = entry.contextWindow || '';
  $('#emInput').value = entry.input?.includes('image') ? 'image' : entry.input?.includes('text') ? 'text' : 'keep';
  $('#emNote').textContent = '仅保存修改的字段；api_key 和上下文留空保留原值。识别结果可手动修正，保存后生效。';
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('#emNewName').focus();
}

function closeEditModel() {
  editingModel = null;
  const form = $('#editModelForm');
  if (form) form.classList.add('hidden');
}

async function saveEditModel() {
  if (!editingModel) return;
  const hint = $('#modelHint');
  hint.textContent = '保存中…';
  const mid = editingModel;
  const body = {};
  const original = editingModelSnapshot;
  const name = $('#emNewName').value.trim();
  if (!name) { hint.textContent = '模型名称不能为空'; return; }
  if (name !== original.id) body.model = name;
  const url = $('#emBaseUrl').value.trim();
  if (url && url !== original.baseUrl) body.baseUrl = url;
  const key = $('#emApiKey').value.trim();
  if (key) body.apiKey = key;
  const cwRaw = $('#emContextWindow').value.trim();
  if (cwRaw && Number(cwRaw) !== original.contextWindow) {
    const cw = Number(cwRaw);
    if (!Number.isInteger(cw) || cw < 1024 || cw > 10000000) {
      hint.textContent = '上下文长度需为 1024-10000000 的整数（tokens）'; return;
    }
    body.contextWindow = cw;
  }
  const input = $('#emInput').value;
  const previous = original.input?.includes('image') ? 'image' : original.input?.includes('text') ? 'text' : 'keep';
  if (input !== 'keep' && input !== previous) body.input = input === 'auto' ? 'auto' : input === 'image' ? ['text', 'image'] : ['text'];
  try {
    const r = await api(`/api/instances/${state.selectedId}/model/${encodeURIComponent(mid)}`, { method: 'PUT', body: JSON.stringify(body) });
    hint.textContent = r.hint || '已保存';
    logEvent(`模型已编辑: ${mid}${r.renamed ? ` → ${body.model}` : ''}`, 'ok');
    closeEditModel();
    loadModelConfig();
  } catch (err) {
    if (err.name === 'AbortError') return;
    hint.textContent = `失败: ${err.message}`;
    logEvent(`模型编辑失败: ${mid} — ${err.message}`, 'err');
  }
}

async function detectModelCapabilities(edit = false) {
  const instanceId = state.selectedId;
  const modelId = edit ? editingModel : null;
  const prefix = edit ? 'em' : 'm';
  const hint = $('#modelHint');
  const model = $(edit ? '#emNewName' : '#mModel').value.trim();
  const form = edit ? $('#editModelForm') : $('#addModelForm');
  const before = ['Model', 'NewName', 'BaseUrl', 'ApiKey', 'ContextWindow', 'Input', 'CopyFrom'].map(k => [k, $('#' + prefix + k)?.value]);
  const snapshot = () => before.every(([k, value]) => $('#' + prefix + k)?.value === value);
  hint.textContent = '正在识别模型能力…';
  try {
    const body = { model, baseUrl: $('#' + prefix + 'BaseUrl').value.trim() };
    const key = $('#' + prefix + 'ApiKey').value.trim();
    if (key) body.apiKey = key;
    if (edit && !key) body.copyKeyFrom = editingModel;
    if (!edit && $('#mCopyFrom').value) body.copyKeyFrom = $('#mCopyFrom').value;
    const result = await api(`/api/instances/${instanceId}/model/detect`, { method: 'POST', body: JSON.stringify(body) });
    if (state.selectedId !== instanceId || (edit && editingModel !== modelId) || !snapshot() || !form.isConnected || form.classList.contains('hidden')) return;
    if (result.contextWindow) $('#' + prefix + 'ContextWindow').value = result.contextWindow;
    if (result.input) $('#' + prefix + 'Input').value = result.input.includes('image') ? 'image' : 'text';
    hint.textContent = `识别结果：${modelInputLabel(result)}；上下文 ${result.contextWindow?.toLocaleString() || '未知'}；来源 ${[...new Set(Object.values(result.sources))].join('、') || '无'}。${result.unresolved.length ? '部分能力未知，请手动填写。' : '保存后生效。'}`;
  } catch (err) {
    if (err.name !== 'AbortError' && state.selectedId === instanceId) hint.textContent = `识别失败：${err.message}`;
  }
}

async function deleteModel(mid) {
  if (!confirm(`删除模型 ${mid} 的整套保存配置（含其 base_url/api_key）？`)) return;
  const hint = $('#modelHint');
  hint.textContent = '删除中…';
  try {
    await api(`/api/instances/${state.selectedId}/model/${encodeURIComponent(mid)}`, { method: 'DELETE' });
    hint.textContent = `已删除模型 ${mid}`;
    logEvent(`模型已删除: ${mid}`, 'ok');
    loadModelConfig();
  } catch (err) {
    if (err.name === 'AbortError') return;
    hint.textContent = `失败: ${err.message}`;
    logEvent(`模型删除失败: ${err.message}`, 'err');
  }
}

async function saveModelConfig() {
  const hint = $('#modelHint');
  hint.textContent = '保存中…';
  try {
    const body = {
      model: $('#mModel').value.trim(),
      baseUrl: $('#mBaseUrl').value.trim(),
      setDefault: $('#mSetDefault') ? $('#mSetDefault').checked : true,
    };
    if (!body.model) {
      hint.textContent = '请先填写要添加的模型名';
      return;
    }
    body.input = $('#mInput').value === 'auto' ? 'auto' : $('#mInput').value === 'image' ? ['text', 'image'] : ['text'];
    const cwRaw = $('#mContextWindow').value.trim();
    if (cwRaw !== '') {
      const cw = Number(cwRaw);
      if (!Number.isInteger(cw) || cw < 1024 || cw > 10000000) {
        hint.textContent = '上下文长度需为 1024-10000000 的整数（tokens），留空自动识别';
        return;
      }
      body.contextWindow = cw;
    } else {
      body.contextWindow = 'auto';
    }
    const key = $('#mApiKey').value.trim();
    if (key) body.apiKey = key;
    const copyFrom = $('#mCopyFrom') ? $('#mCopyFrom').value : '';
    if (copyFrom) body.copyKeyFrom = copyFrom;
    let r;
    try {
      r = await api(`/api/instances/${state.selectedId}/model`, { method: 'PUT', body: JSON.stringify(body) });
    } catch (err) {
    if (err.name === 'AbortError') return;
      // 新模型必须自带 key；只有更新已有条目时才允许留空沿用旧 key。
      if (/请填写 api_key/.test(err.message)) {
        hint.textContent = '该模型是新条目：请填写 api_key，或用「复用现有模型的凭据」选择一个已有模型';
        return;
      }
      throw err;
    }
    hint.textContent = r.hint || '已保存';
    logEvent(`模型已保存: ${body.model}${body.contextWindow ? `（上下文 ${body.contextWindow}）` : ''}${body.setDefault ? '，并设为当前使用' : ''}`, 'ok');
    if ($('#mBaseUrl')) $('#mBaseUrl').dataset.dirty = '';
    // Saved: reset the form for the next entry but keep base_url prefill.
    const apiKey = $('#mApiKey');
    if (apiKey) { apiKey.value = ''; apiKey.dataset.dirty = ''; }
    const mm = $('#mModel');
    if (mm) { mm.value = ''; mm.dataset.dirty = ''; }
    $('#mInput').value = 'auto';
    const cw = $('#mContextWindow');
    if (cw) { cw.value = ''; cw.dataset.dirty = ''; }
    if (!body.setDefault) {
      const baseUrl2 = $('#mBaseUrl');
      if (baseUrl2) baseUrl2.dataset.dirty = '';
    }
    loadModelConfig();
  } catch (err) {
    if (err.name === 'AbortError') return;
    hint.textContent = `失败: ${err.message}`;
    logEvent(`模型配置保存失败: ${err.message}`, 'err');
  }
}

async function testModelConn() {
  const hint = $('#modelHint');
  hint.textContent = '测试中（最长约 90 秒）…';
  try {
    // Test the current model from the hero card (no form involvement).
    const r = await api(`/api/instances/${state.selectedId}/model/test`, { method: 'POST', body: JSON.stringify({}) });
    hint.textContent = `连通正常，模型回复：${r.reply || '(空)'}`;
    logEvent('模型连通测试通过', 'ok');
  } catch (err) {
    if (err.name === 'AbortError') return;
    hint.textContent = `测试失败: ${err.message}`;
    logEvent(`模型连通测试失败: ${err.message}`, 'err');
  }
}

// Show/hide the add-model form; opening it keeps whatever the user typed.
function toggleAddModelForm(show) {
  const form = $('#addModelForm');
  if (!form) return;
  const willShow = show === undefined ? form.classList.contains('hidden') : show;
  form.classList.toggle('hidden', !willShow);
  $('#btnToggleAddModel').textContent = willShow ? '收起表单' : '＋ 添加模型';
  if (willShow) $('#mModel').focus();
}

// ── Feishu config ────────────────────────────────────────────────────────────
// Same policy as the model section: load once on panel open; afterwards only
// manual reload or post-save updates. Never touched by timers or SSE.
let feishuRefresh = null;
async function loadFeishuConfig() {
  const box = $('#feishuSummary');
  if (!box) return;
  try {
    const f = await api(`/api/instances/${state.selectedId}/feishu`);
    const status = !f.configured
      ? '未配置'
      : f.running && !f.lastError
        ? '<span style="color:var(--ok,#3fb950)">已连接</span>'
        : `<span style="color:#f85149">${esc(f.lastError || '未运行')}</span>`;
    box.innerHTML = `
      <div class="kv"><div class="k">状态</div><div class="v">${status}</div></div>
      <div class="kv"><div class="k">App ID</div><div class="v mono">${esc(f.appId || '—')}</div></div>
      <div class="kv"><div class="k">App Secret</div><div class="v mono">${f.hasAppSecret ? esc(f.appSecretMasked) : '—'}</div></div>`;
    const appId = $('#fAppId');
    if (appId && !appId.dataset.dirty) appId.value = f.appId || '';
  } catch (err) {
    if (err.name === 'AbortError') return;
    box.textContent = `加载失败: ${err.message}`;
  }
}

async function saveFeishuConfig() {
  const hint = $('#feishuHint');
  hint.textContent = '保存中（含实例重启，约 20-40 秒）…';
  try {
    const body = { appId: $('#fAppId').value.trim() };
    const secret = $('#fAppSecret').value.trim();
    if (secret) body.appSecret = secret;
    const r = await api(`/api/instances/${state.selectedId}/feishu`, { method: 'PUT', body: JSON.stringify(body) });
    hint.textContent = r.hint || '已保存';
    logEvent('飞书凭证已保存，实例重启中', 'ok');
    for (const selector of ['#fAppId', '#fAppSecret']) { const input = $(selector); if (input) input.dataset.dirty = ''; }
    $('#fAppSecret').value = '';
    // Explicit post-save status refresh only (user-initiated action).
    feishuRefresh = { id: state.selectedId, after: Date.now() + 15000 };
  } catch (err) {
    if (err.name === 'AbortError') return;
    hint.textContent = `失败: ${err.message}`;
    logEvent(`飞书配置保存失败: ${err.message}`, 'err');
  }
}

async function testFeishuConn() {
  const hint = $('#feishuHint');
  hint.textContent = '检测中…';
  try {
    const r = await api(`/api/instances/${state.selectedId}/feishu/test`, { method: 'POST', body: '{}' });
    if (r.ok) {
      hint.textContent = '飞书连接正常';
      logEvent('飞书连接检测通过', 'ok');
    } else {
      hint.textContent = `未就绪: ${r.error || 'WebSocket 未建立'}`;
      logEvent(`飞书检测未通过: ${r.error || 'WebSocket 未建立'}`, 'err');
    }
    loadFeishuConfig();
  } catch (err) {
    if (err.name === 'AbortError') return;
    hint.textContent = `检测失败: ${err.message}`;
  }
}

// Per-instance chat histories: switching instances never bleeds transcripts.
const chatHistories = {}; // instanceId -> [{role, text, pending?}]
const chatBusy = new Set(); // instanceIds with an in-flight turn

function chatStateFor(id) {
  id = `${id}:${selectedChatAgents.get(id) || 'main'}`;
  if (!chatHistories[id]) {
    chatHistories[id] = [{ role: 'assistant', text: '你好！我是该实例的 OpenClaw 助手，有什么可以帮你？' }];
  }
  return chatHistories[id];
}

function openChatModal(agentId) {
  const inst = state.instances.find((i) => i.id === state.selectedId);
  if (!inst) return;
  if (typeof agentId === 'string' && chatBusy.has(inst.id) && agentId !== selectedChatAgents.get(inst.id)) {
    logEvent('当前 Agent 仍在回复，请先停止生成或等待完成后切换。', 'err'); return;
  }
  if (typeof agentId === 'string') selectedChatAgents.set(state.selectedId, agentId);
  const history = chatStateFor(state.selectedId);
  let modal = $('#chatModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'chatModal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
      <div class="modal-card" style="width:560px;max-width:92vw;display:flex;flex-direction:column;max-height:80vh">
        <div class="modal-head" style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">OpenClaw 对话 <span class="reco-note" id="chatModel"></span></h3>
          <button class="btn small" id="chatClose">关闭</button>
        </div>
        <label>Agent <select id="chatAgent" class="input" aria-label="对话 Agent"><option value="main">main</option></select></label>
        <div id="chatLog" style="flex:1;overflow-y:auto;min-height:260px;margin:10px 0;border-radius:8px;padding:12px"></div>
        <div id="chatAttachments" class="chat-attachments"></div>
        <label class="chat-upload">添加图片或文件<input type="file" id="chatFiles" multiple accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.csv,.json,.docx,.xlsx"></label>
        <div id="chatStatus" class="save-hint" role="status"></div>
        <div style="display:flex;gap:8px">
          <input type="text" id="chatInput" class="input" placeholder="输入消息，Enter 发送" style="flex:1">
          <button class="btn small primary" id="chatSend">发送</button><button class="btn small" id="chatStop" data-feature="chatStop" disabled>停止生成</button>
        </div>
        <div class="reco-note" style="margin-top:6px">支持最多 4 个附件，单个 10MB、总计 20MB。图片需视觉模型；文档解析取决于模型和已启用工具。</div>
      </div>`;
    document.body.appendChild(modal);
  $('#chatClose').onclick = () => modal.classList.add('hidden');
  const send = () => sendChat();
  $('#chatSend').onclick = send;
  $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  $('#chatAgent').addEventListener('change', () => { selectedChatAgents.set(state.selectedId, $('#chatAgent').value); renderChatLog(); renderChatAgentModel(); });
  }
  modal.classList.remove('hidden');
  renderChatLog(history);
  renderChatAttachments(); syncChatControls();
  loadChatAgents();
  $('#chatInput').focus();
}

function renderChatLog(history = chatStateFor(state.selectedId)) {
  const log = $('#chatLog');
  const limit = chatVisibleMessages[state.selectedId] || 100;
  const hiddenCount = Math.max(0, history.length - limit);
  log.innerHTML = (hiddenCount ? `<button class="btn small" data-chat-earlier>加载更早消息（还有 ${hiddenCount} 条）</button>` : '') + history.slice(-limit).map((m) => `
    <div class="chat-row ${m.role}">
      <div class="chat-bubble ${m.role}${m.pending ? ' pending' : ''}">${esc(m.text)}</div>
    </div>`).join('');
  log.scrollTop = log.scrollHeight;
}

const chatVisibleMessages = {};
document.addEventListener('click', event => {
  if (!event.target.closest('[data-chat-earlier]')) return;
  const log = $('#chatLog'), height = log.scrollHeight, top = log.scrollTop;
  chatVisibleMessages[state.selectedId] = (chatVisibleMessages[state.selectedId] || 100) + 100;
  renderChatLog();
  log.scrollTop = log.scrollHeight - height + top;
});

async function sendChat() { return sendEnhancedChat(); }

// ── Session management (sessions tab) ────────────────────────────────────────
// Per-instance UI state: switching instances or rebuilding the detail panel
// resets the open session so a stale transcript is never shown.
const sessState = { selectedId: null, list: [], openKey: null, messages: null, sending: false, visibleMessages: 100 };

function sessFmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtTokensShort(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

async function loadSessions() {
  const id = state.selectedId;
  if (!id) return;
  const box = $('#sessList');
  if (state.instances.find(i => i.id === id)?.state !== 'running') { if (box) box.textContent = '实例未运行，请先启动以管理会话'; return; }
  if (!box) return;
  // Instance switched: drop the previously open transcript.
  if (sessState.selectedId !== id) {
    sessState.selectedId = id;
    sessState.openKey = null;
    sessState.messages = null;
  }
  const hint = $('#sessHint');
  if (hint) hint.textContent = '加载中…';
  try {
    const limit = ($('#sessLimit') || {}).value || '100';
    const data = await api(`/api/instances/${id}/sessions?limit=${encodeURIComponent(limit)}`);
    sessState.list = data.sessions || [];
    renderSessionList();
    if (hint) hint.textContent = data.hasMore ? `共 ${data.totalCount} 条，仅显示 ${sessState.list.length} 条（可切换“全部”）` : `共 ${sessState.list.length} 条`;
  } catch (err) {
    if (err.name === 'AbortError') return;
    box.innerHTML = `<div class="empty">加载失败: ${esc(err.message)}</div>`;
    if (hint) hint.textContent = '';
  }
}

function renderSessionList() {
  const box = $('#sessList');
  if (!box) return;
  const kw = ($('#sessFilter') && $('#sessFilter').value.trim().toLowerCase()) || '';
  let rows = sessState.list;
  if (kw) rows = rows.filter((s) => `${s.key} ${s.label || ''} ${s.model || ''} ${s.sessionId || ''}`.toLowerCase().includes(kw));
  if (!rows.length) {
    box.innerHTML = `<div class="empty">${kw ? '没有匹配的会话。' : '暂无会话记录。'}</div>`;
    return;
  }
  box.innerHTML = rows.map((s) => `
    <div class="sess-item ${sessState.openKey === s.key ? 'open' : ''}" data-sess-key="${esc(s.key)}">
      <input type="checkbox" class="sess-check" data-sess-check="${esc(s.key)}" title="选中用于批量操作">
      <div class="sess-main" title="${esc(s.key)}">
        <div class="sess-line1">
          <span class="sess-kind ${s.subagent ? 'sub' : ''}">${s.subagent ? '子代理' : s.kind === 'group' ? '群聊' : '会话'}</span>
          <span class="sess-label">${esc(s.label || s.key.split(':').slice(-1)[0] || s.key)}</span>
          ${s.status ? `<span class="badge ${s.status === 'done' ? 'running' : 'health-degraded'}">${esc(s.status)}</span>` : ''}
          ${s.abortedLastRun ? '<span class="badge health-degraded">上次中断</span>' : ''}
        </div>
        <div class="sess-line2">
          <span>${sessFmtTime(s.updatedAtMs)}</span>
          <span>${esc(s.model || '未指定模型')}</span>
          <span>${sessFmtTokens(s.totalTokens) ? `tokens ${sessFmtTokens(s.totalTokens)}` : ''}</span>
        </div>
      </div>
      <div class="sess-actions">
        <button class="btn small" data-sess-open="${esc(s.key)}">查看</button>
        <button class="btn small danger" data-sess-del="${esc(s.key)}">删除</button>
      </div>
    </div>`).join('');
}

function sessFmtTokens(n) {
  return Number.isFinite(n) && n > 0 ? fmtTokensShort(n) : '';
}

function sessKeyToTitle(key) {
  const parts = String(key).split(':');
  return parts.slice(2).join(':') || key;
}

let transcriptRequest = 0;
async function openSession(key) {
  const request = ++transcriptRequest;
  const id = state.selectedId;
  if (!id) return;
  sessState.openKey = key;
  sessState.visibleMessages = 100;
  sessState.messages = null;
  renderSessionList();
  const section = $('#sessDetailSection');
  const transcript = $('#sessTranscript');
  if (!section || !transcript) return;
  section.style.display = '';
  $('#sessDetailTitle').textContent = `会话 ${sessKeyToTitle(key)}`;
  $('#sessDetailMeta').textContent = '';
  $('#sessDetailHint').textContent = '';
  transcript.innerHTML = '<div class="empty">加载会话记录中…（大会话导出可能需要数十秒）</div>';
  try {
    const data = await api(`/api/instances/${id}/sessions/${encodeURIComponent(key)}/messages`);
    if (request !== transcriptRequest || sessState.openKey !== key) return;
    sessState.messages = data.messages || [];
    $('#sessDetailMeta').textContent = `${sessState.messages.length} 条消息`;
    renderTranscript();
  } catch (err) {
    if (err.name === 'AbortError') return;
    transcript.innerHTML = `<div class="empty">加载失败: ${esc(err.message)}</div>`;
  }
}

function closeSession() {
  transcriptRequest++;
  sessState.openKey = null;
  sessState.messages = null;
  const section = $('#sessDetailSection');
  if (section) section.style.display = 'none';
  renderSessionList();
}

function renderTranscript(earlier = false) {
  const transcript = $('#sessTranscript');
  if (!transcript) return;
  const msgs = sessState.messages || [];
  if (!msgs.length) {
    transcript.innerHTML = '<div class="empty">（空会话）</div>';
    return;
  }
  const oldHeight = transcript.scrollHeight, oldTop = transcript.scrollTop;
  const hiddenCount = Math.max(0, msgs.length - sessState.visibleMessages);
  const earlierButton = hiddenCount ? `<button class="btn small" data-sess-earlier>加载更早消息（还有 ${hiddenCount} 条）</button>` : '';
  transcript.innerHTML = earlierButton + msgs.slice(-sessState.visibleMessages).map((m) => {
    if (m.role === 'user') {
      return `<div class="chat-row user"><div class="chat-bubble user">${esc(m.text)}</div></div>`;
    }
    if (m.role === 'assistant') {
      const tools = (m.toolCalls || []).map((tc) => `
        <div class="tool-call">🔧 ${esc(tc.name)}<span class="tool-args">${tc.args ? esc(JSON.stringify(tc.args)) : ''}</span></div>`).join('');
      const meta = [];
      if (m.model) meta.push(esc(m.model));
      if (m.totalTokens) meta.push(`tokens ${fmtTokensShort(m.totalTokens)}`);
      return `<div class="chat-row bot">
        <div class="chat-bubble bot${m.text ? '' : ' no-text'}">
          ${tools}
          ${m.text ? `<div class="assistant-text">${esc(m.text)}</div>` : ''}
          ${meta.length ? `<div class="sess-msg-meta">${meta.join(' · ')}</div>` : ''}
        </div>
      </div>`;
    }
    if (m.role === 'tool') {
      return `<div class="chat-row bot"><div class="tool-result"><span class="tool-name">↳ ${esc(m.name)}</span><pre>${esc(truncateText(m.text, 4000))}</pre></div></div>`;
    }
    return `<div class="sess-note">${esc(m.text)}</div>`;
  }).join('');
  transcript.scrollTop = earlier ? transcript.scrollHeight - oldHeight + oldTop : transcript.scrollHeight;
}

document.addEventListener('click', event => {
  if (event.target.closest('[data-sess-earlier]')) { sessState.visibleMessages += 100; renderTranscript(true); }
});

function truncateText(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function sendSessionMessage() {
  const id = state.selectedId;
  const key = sessState.openKey;
  const input = $('#sessInput');
  if (!id || !key || sessState.sending) return;
  const text = (input.value || '').trim();
  if (!text) return;
  const transcript = $('#sessTranscript');
  sessState.sending = true;
  input.value = '';
  const btn = $('#btnSessSend');
  if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
  // Optimistic UI: append the user's message and a pending bubble immediately;
  // the transcript is reloaded from the store once the turn completes.
  if (sessState.messages) {
    sessState.messages.push({ role: 'user', text });
    renderTranscript();
    if (transcript) {
      transcript.insertAdjacentHTML('beforeend',
        `<div class="chat-row bot"><div class="chat-bubble bot pending">思考中…</div></div>`);
      transcript.scrollTop = transcript.scrollHeight;
    }
  }
  try {
    const r = await api(`/api/instances/${id}/sessions/${encodeURIComponent(key)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message: text }),
    });
    logEvent(`会话消息已回复（${r.model || '默认模型'}）`, 'ok');
    // Reload the transcript so the new turn shows in full context.
    await openSession(key);
  } catch (err) {
    if (err.name === 'AbortError') { sessState.sending = false; return; }
    if (transcript) transcript.insertAdjacentHTML('beforeend',
      `<div class="chat-row bot"><div class="chat-bubble bot">出错了：${esc(err.message)}</div></div>`);
    logEvent(`会话消息失败: ${err.message}`, 'err');
  }
  sessState.sending = false;
  if (btn) { btn.disabled = false; btn.textContent = '发送'; }
}

async function deleteSessions(keys) {
  if (!keys.length) return;
  if (!confirm(`删除 ${keys.length} 个会话？运行时产物一并移除（transcript 先归档），不可恢复。`)) return;
  const hint = $('#sessHint');
  try {
    const r = await api(`/api/instances/${state.selectedId}/sessions/delete`, {
      method: 'POST',
      body: JSON.stringify({ keys }),
    });
    if (hint) hint.textContent = r.hint || '已删除';
    logEvent(`已删除 ${keys.length} 个会话`, 'ok');
    if (sessState.openKey && keys.includes(sessState.openKey)) closeSession();
    loadSessions();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (hint) hint.textContent = `删除失败: ${err.message}`;
    logEvent(`会话删除失败: ${err.message}`, 'err');
  }
}

async function archiveSessions(keys) {
  if (!keys.length) return;
  if (!confirm(`归档 ${keys.length} 个会话？transcript 保留为归档文件，活跃会话列表中不再显示。`)) return;
  const hint = $('#sessHint');
  try {
    const r = await api(`/api/instances/${state.selectedId}/sessions/archive`, {
      method: 'POST',
      body: JSON.stringify({ keys }),
    });
    if (hint) hint.textContent = r.hint || '已归档';
    logEvent(`已归档 ${keys.length} 个会话`, 'ok');
    if (sessState.openKey && keys.includes(sessState.openKey)) closeSession();
    loadSessions();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (hint) hint.textContent = `归档失败: ${err.message}`;
    logEvent(`会话归档失败: ${err.message}`, 'err');
  }
}

async function compactSession(maxLines) {
  const key = sessState.openKey;
  if (!key) return;
  if (!confirm(maxLines ? `将此会话截断为末尾 ${maxLines} 行？更早的内容会被丢弃。` : '用 LLM 对此会话做摘要压缩？会压缩上下文占用，较早的原文不再可读。')) return;
  const hint = $('#sessDetailHint');
  if (hint) hint.textContent = '压缩中…（LLM 摘要可能需要 1-2 分钟）';
  try {
    const r = await api(`/api/instances/${state.selectedId}/sessions/compact`, {
      method: 'POST',
      body: JSON.stringify({ key, maxLines }),
    });
    if (hint) hint.textContent = r.hint || '已压缩';
    logEvent(`会话已压缩: ${sessKeyToTitle(key)}`, 'ok');
    await openSession(key);
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (hint) hint.textContent = `压缩失败: ${err.message}`;
    logEvent(`会话压缩失败: ${err.message}`, 'err');
  }
}

function checkedSessionKeys() {
  return $$('#sessList .sess-check:checked').map((c) => c.dataset.sessCheck);
}

async function loadConfig(kind) {
  const ta = kind === 'json' ? $('#configEditor') : $('#envEditor');
  if (!ta) return;
  try {
    const data = await api(`/api/instances/${state.selectedId}/${kind === 'json' ? 'config' : 'env'}`);
    ta.value = data.content;
    ta.dataset.savedValue = data.content; ta.dataset.dirty = '';
    ta.dataset.revision = data.revision;
  } catch (err) {
    if (err.name === 'AbortError') return;
    ta.value = `# 加载失败: ${err.message}`;
  }
}

let logsRequest = null;
function loadLogs() {
  const key = `${viewEpoch}:${state.selectedId}:${$('#logTail')?.value || 200}`;
  if (logsRequest?.key === key) return logsRequest.promise;
  const request = { key, promise: null };
  logsRequest = request;
  request.promise = fetchLogs(request).finally(() => { if (logsRequest === request) logsRequest = null; });
  return request.promise;
}
async function fetchLogs(request) {
  const ta = $('#logView');
  if (!ta) return;
  try {
    const tail = Number(($('#logTail') || {}).value) || 200;
    const data = await api(`/api/instances/${state.selectedId}/logs?tail=${tail}`);
    if (logsRequest !== request || $('#logView') !== ta) return;
    const nextLogs = data.logs || '（暂无日志）';
    if (ta.dataset.loaded === '1' && logsRaw === nextLogs) return;
    ta.dataset.loaded = '1';
    logsRaw = nextLogs;
    applyLogFilter();
    ta.scrollTop = ta.scrollHeight;
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (logsRequest === request && $('#logView') === ta) ta.value = `日志加载失败: ${err.message}`;
  }
}

let logsRaw = '';

function applyLogFilter() {
  const ta = $('#logView');
  if (!ta || document.hidden || activeDetailTab !== 'logs') return;
  const kw = ($('#logFilter') && $('#logFilter').value.trim().toLowerCase()) || '';
  if (!kw) { ta.value = logsRaw; return; }
  const lines = logsRaw.split('\n').filter((l) => l.toLowerCase().includes(kw));
  ta.value = `（过滤：${kw}，命中 ${lines.length} 行）\n${lines.join('\n')}`;
  ta.scrollTop = ta.scrollHeight;
}

function downloadLogs() {
  const inst = state.instances.find((i) => i.id === state.selectedId);
  const blob = new Blob([logsRaw], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${inst ? inst.name : 'instance'}-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function saveConfig(kind, thenRestart) {
  const ta = kind === 'json' ? $('#configEditor') : $('#envEditor');
  try {
    if (kind === 'json') JSON.parse(ta.value);
    const result = await api(`/api/instances/${state.selectedId}/${kind === 'json' ? 'config' : 'env'}`, {
      method: 'PUT',
      body: JSON.stringify({ content: ta.value, revision: ta.dataset.revision }),
    });
    ta.dataset.revision = result.revision; ta.dataset.savedValue = ta.value; ta.dataset.dirty = '';
    const hint = kind === 'json' ? $('#cfgHint') : $('#envHint');
    hint.textContent = '已保存 ✓';
    logEvent(`配置已保存（${kind}）`, 'ok');
    if (thenRestart) {
      await api(`/api/instances/${state.selectedId}/restart`, { method: 'POST' });
      logEvent('实例已重启以应用配置', 'ok');
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (kind === 'json') {
      $('#jsonError').textContent = `保存失败: ${err.message}`;
    } else {
      logEvent(`保存失败: ${err.message}`, 'err');
    }
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────
async function instanceAction(act, id = state.selectedId) {
  if (pendingActions.has(id) && act in BUSY_ACTIONS) return;
  try {
    if (act === 'openUI') {
      const inst = state.instances.find((i) => i.id === id);
      try {
        await navigator.clipboard.writeText((await api(`/api/instances/${id}/token`)).token);
        logEvent('Gateway Token 已复制：在控制台登录页粘贴到 Gateway secret 后点击 Connect', 'ok');
      } catch {
        logEvent('打开控制台：Gateway Token 见实例详情，粘贴后点击 Connect', '');
      }
      window.open(inst.uiUrl, '_blank');
      return;
    }
    if (act === 'toggleToken' || act === 'copyToken') {
      const inst = state.instances.find((i) => i.id === id);
      if (!inst) return;
      if (act === 'copyToken') {
        try {
          await navigator.clipboard.writeText((await api(`/api/instances/${id}/token`)).token);
          logEvent('Gateway Token 已复制到剪贴板', 'ok');
        } catch {
          logEvent('复制失败：请用「显示」后手动选择复制', 'err');
        }
      } else {
        const value = await api(`/api/instances/${id}/token`);
        const masked = $('#tokenMasked');
        const full = $('#tokenFull');
        const btn = $('#detailPanel [data-act="toggleToken"]');
        const showing = !full.classList.contains('hidden');
        full.textContent = showing ? '' : value.token;
        full.classList.toggle('hidden', showing);
        masked.classList.toggle('hidden', !showing);
        if (btn) btn.textContent = showing ? '显示' : '隐藏';
      }
      return;
    }
    if (act === 'delete') {
      const choice = await chooseDelete(id);
      if (choice === null) return;
      const keep = choice;
      pendingActions.add(id); setActionBusy(act);
      await api(`/api/instances/${id}${keep ? '?keepData=1' : ''}`, { method: 'DELETE' });
      if (state.selectedId === id) {
        state.selectedId = null;
        renderDetail._currentId = null;
        $('#detailPanel').innerHTML = '<div class="empty">从左侧选择一个实例查看详情</div>';
      }
      logEvent(`实例已删除${keep ? '（数据保留在 data/instances/<id>.kept）' : '（含数据）'}`, 'ok');
    } else {
      if (act in BUSY_ACTIONS) { pendingActions.add(id); setActionBusy(act); }
      await api(`/api/instances/${id}/${act}`, { method: 'POST' });
      logEvent(`实例 ${act} 成功`, 'ok');
    }
    await refresh();
    renderDetail();
  } catch (err) {
    if (err.name === 'AbortError') return;
    logEvent(`${act} 失败: ${err.message}`, 'err');
    // Release the disabled buttons so the user can retry.
    const inst = state.instances.find((i) => i.id === state.selectedId);
    if (inst && $('#detailPanel .detail-title')) renderDetailLive(inst);
  } finally {
    pendingActions.delete(id);
    const inst = state.instances.find(i => i.id === state.selectedId);
    if (inst) renderDetailLive(inst);
  }
}

async function saveResources() {
  const cpus = $('#resCpus').value;
  const memory = $('#resMem').value;
  try {
    const body = {};
    if (cpus !== '' && cpus !== $('#resCpus').defaultValue) body.cpus = Number(cpus);
    if (memory !== '' && memory !== $('#resMem').defaultValue) body.memory = memory;
    if (!Object.keys(body).length) return;
    await api(`/api/instances/${state.selectedId}/resources`, { method: 'PATCH', body: JSON.stringify(body) });
    logEvent('资源配置已更新', 'ok');
    await refresh();
    renderDetail();
  } catch (err) {
    if (err.name === 'AbortError') return;
    logEvent(`资源更新失败: ${err.message}`, 'err');
  }
}

// ── Local image store ────────────────────────────────────────────────────────
async function refreshLocalImages() {
  try {
    const data = await api('/api/images');
    renderImageList(data);
    renderImageChips(data);
  } catch (err) {
    if (err.name === 'AbortError') return;
    const box = $('#imageList');
    if (box) box.innerHTML = `<div class="empty">加载失败: ${esc(err.message)}</div>`;
  }
}

function renderImageList(data) {
  const box = $('#imageList');
  const retention = $('#retentionStatus');
  if (retention && data.retention) {
    const r = data.retention, last = r.lastRun;
    retention.textContent = '升级成功后自动清理：每个实例保留最近一个回滚版本，Manager 保留上一版；仍被引用的项目不会删除。' +
      (r.error ? ` ${r.error}` : last?.error ? ` ${last.error}，稍后自动重试。` : last ?
        ` 上次检查 ${new Date(last.at).toLocaleString('zh-CN')}：删除 ${last.removedContainers.length} 个容器、${last.removedImages.length} 个镜像。` +
        (last.errors?.length ? ' 部分项目仍被占用，稍后自动重试。' : r.pending ? ' 等待升级实例通过健康检查。' : '') : ' 等待升级健康检查通过。');
  }
  if (!data.images.length) {
    box.innerHTML = '<div class="empty">本地暂无镜像。点击上方“下载到本地”预下载 OpenClaw 镜像。</div>';
    return;
  }
  box.innerHTML = data.images.map((img) => `
    <div class="image-item">
      <div class="tag">${img.tags.map(tag => esc(tag)).join('<br>')}
        <span class="openclaw-mark">${esc(img.purpose || '其他镜像')}</span>
        ${img.tags.length > 1 ? '<small>同一镜像的多个标签，共享存储</small>' : ''}
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="size">${fmtBytes(img.size)}</span>
      </div>
    </div>`).join('');
}

function renderImageChips(data) {
  const box = $('#localImageChips');
  if (!box) return;
  const runtimeImages = data.images.filter(img => img.selectable === true);
  if (!runtimeImages.length) {
    box.innerHTML = '<span style="color:var(--amber);font-size:11px">本地无可选的 OpenClaw 运行镜像，请先下载。管理平台和构建基础镜像不用于开通实例。</span>';
    return;
  }
  box.innerHTML = '<span style="color:var(--green);font-size:11px">本地运行镜像（点击选用）：</span>' +
    runtimeImages.map(img => {
      const tag = img.tags.includes(data.defaultImage) ? data.defaultImage : img.tags[0];
      return `<span class="image-chip" data-pick-image="${esc(tag)}">${esc(tag)}<span class="chip-size">${fmtBytes(img.size)}</span></span>`;
    }).join('') + '<span class="hint">管理平台和构建基础镜像可在“本地镜像”中查看。</span>';
}

let cleanupPreviewData = null;
let cleanupBusy = false;
let cleanupRequest = 0;
let cleanupExpiryTimer = null;
function updateCleanupButtons() {
  const p = cleanupPreviewData;
  const count = p ? p.summary.deleteImages + p.summary.deleteContainers : 0;
  $('#btnCleanupRun').disabled = cleanupBusy || !p || Boolean(p.blockedReason) || !count;
  $('#btnCleanupRun').textContent = cleanupBusy ? '正在清理…' : count ? `按预览清理（${count} 项）` : '按预览清理';
  $('#btnCleanupPreview').disabled = cleanupBusy;
}
function invalidateCleanupPreview(message) {
  cleanupRequest++;
  cleanupPreviewData = null;
  clearTimeout(cleanupExpiryTimer);
  $('#cleanupNotice').textContent = message;
  updateCleanupButtons();
}
function renderCleanupPreview(data) {
  cleanupPreviewData = data;
  const items = [...data.images, ...data.containers];
  const group = (decision, label) => {
    const rows = items.filter(item => item.decision === decision);
    return `<details class="cleanup-group" open><summary>${label}（${rows.length} 项）</summary>` +
      (rows.length ? `<ul class="cleanup-items">${rows.map(item => `<li class="cleanup-item" data-decision="${decision}">
        <div class="cleanup-object"><span class="cleanup-kind">${item.type === 'image' ? '镜像' : '回滚容器'}</span><strong>${esc(item.name)}</strong></div>
        <div class="cleanup-meta"><code title="${esc(item.id)}">${esc(item.id.replace(/^sha256:/, '').slice(0, 12))}</code>${item.type === 'image' ? ` · ${fmtBytes(item.sizeBytes)}` : ` · ${esc(STATE_LABEL[item.state] || item.state)}${item.instanceName ? ' · ' + esc(item.instanceName) : ''}`}</div>
        <div class="cleanup-reasons">${item.reasons.map(reason => esc(reason)).join('；')}${item.dependsOn?.length ? '；需先删除对应的旧回滚容器' : ''}</div>
      </li>`).join('')}</ul>` : '<p class="hint">暂无项目。</p>') + '</details>';
  };
  $('#cleanupPreview').innerHTML = group('delete', '将删除') + group('keep', '将保留');
  $('#cleanupPreview').classList.remove('hidden');
  $('#cleanupNotice').textContent = data.blockedReason || (data.summary.deleteImages + data.summary.deleteContainers ?
    '预览有效期为 5 分钟。确认清单后，可按预览清理；引用或状态变化时需重新预览。镜像大小包含共享层，不等于实际释放空间。' : '当前没有可以安全清理的项目。');
  clearTimeout(cleanupExpiryTimer);
  cleanupExpiryTimer = setTimeout(() => invalidateCleanupPreview('清理预览已过期，请刷新预览'), Math.max(0, Date.parse(data.expiresAt) - Date.now()));
  updateCleanupButtons();
}
async function loadCleanupPreview() {
  if (cleanupBusy) return;
  invalidateCleanupPreview('正在检查镜像、回滚版本及引用关系…');
  $('#cleanupResult').textContent = '';
  const request = cleanupRequest;
  $('#btnCleanupPreview').disabled = true;
  try {
    const data = await api('/api/images/cleanup/preview');
    if (request !== cleanupRequest) return;
    renderCleanupPreview(data);
  } catch (err) {
    if (request === cleanupRequest) $('#cleanupNotice').textContent = `无法生成清理预览：${err.message}`;
  } finally { if (request === cleanupRequest) updateCleanupButtons(); }
}
async function runManualCleanup() {
  if (cleanupBusy || !cleanupPreviewData || cleanupPreviewData.blockedReason || !(cleanupPreviewData.summary.deleteImages + cleanupPreviewData.summary.deleteContainers)) return;
  const preview = cleanupPreviewData;
  if (Date.parse(preview.expiresAt) <= Date.now()) { invalidateCleanupPreview('清理预览已过期，请重新预览'); return; }
  cleanupBusy = true;
  updateCleanupButtons();
  $('#cleanupResult').textContent = '正在重新检查引用并清理预览中的项目…';
  try {
    const result = await api('/api/images/cleanup', { method: 'POST', body: JSON.stringify({ previewId: preview.previewId }) });
    $('#cleanupResult').textContent = `已删除 ${result.removedImages.length} 个镜像、${result.removedContainers.length} 个回滚容器。` +
      (result.error ? ` ${result.error}，其余项目保留。` : result.errors.length ? ' 部分项目仍被占用，已保留并登记重试。' : result.skipped.length ? ' 引用或状态变化的项目已跳过。' : ' 保留版本与实例数据未改动。');
    logEvent('手动清理已完成，请查看本地镜像仓库中的结果', 'ok');
    invalidateCleanupPreview('清理完成，请刷新预览查看当前项目');
    await refreshLocalImages();
  } catch (err) {
    invalidateCleanupPreview('请刷新清理预览后再试');
    $('#cleanupResult').textContent = `清理未完成：${err.message}`;
  } finally { cleanupBusy = false; updateCleanupButtons(); await loadCleanupHistory(); }
}

let cleanupHistoryRows = [];
let cleanupHistoryCursor = null;
let cleanupHistoryRequest = 0;
let cleanupHistoryBusy = false;
function renderCleanupHistory() {
  const stateLabels = {completed:'已完成',partial:'部分失败',waiting:'等待健康检查',failed:'失败',skipped:'已跳过',running:'处理中'};
  const typeLabels = {image:'镜像',rollback:'回滚容器',instance:'实例',operation:'操作',unknown:'对象'};
  const time = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN',{hour12:false}) : '时间未知';
  const list = (label,rows,open=false) => rows.length ? `<details class="cleanup-history-group"${open?' open':''}><summary>${label}（${rows.length} 项）</summary><ul class="cleanup-items">${rows.map(row=>`<li class="cleanup-item"><div class="cleanup-object"><span class="cleanup-kind">${esc(typeLabels[row.type] || '对象')}</span><strong>${esc(row.name || row.id || '清理操作')}</strong></div>${row.id ? `<div class="cleanup-meta"><code>${esc(row.id)}</code>${row.instanceName ? ' · '+esc(row.instanceName) : ''}</div>` : ''}${row.reason ? `<div class="cleanup-reasons">${esc(row.reason)}</div>` : ''}</li>`).join('')}</ul></details>` : `<p class="hint">${label}：无</p>`;
  $('#cleanupHistory').innerHTML = cleanupHistoryRows.length ? cleanupHistoryRows.map((row,index)=>{
    const trigger=row.trigger==='instance-upgrade'?'实例升级后清理':row.trigger==='manager-upgrade'?'Manager 升级后清理':row.source==='automatic' && row.trigger==='manual-cleanup'?'自动重试手动清理任务':row.source==='manual'?'手动发起清理':'自动清理任务';
    return `<details class="cleanup-history-entry"${index===0?' open':''}><summary><span>${esc(time(row.at))} · ${row.source==='manual'?'手动清理':'自动清理'}</span> <span class="cleanup-history-state">${esc(stateLabels[row.state] || '状态未知')}</span><span class="cleanup-history-counts">删除镜像 ${row.deletedImages.length} · 回滚容器 ${row.deletedContainers.length} · 跳过 ${row.skipped.length} · 失败 ${row.errors.length+(row.error?1:0)}</span></summary><p class="hint">${trigger}${row.completedAt ? ' · 结束于 '+esc(time(row.completedAt)) : ''}</p>${row.legacy ? '<p class="hint">旧记录可能仅保存对象 ID，未保存的名称和详细原因无法补全。</p>' : ''}${list('已删除镜像',row.deletedImages,true)}${list('已删除回滚容器',row.deletedContainers,true)}${row.removedTags?.length?list('已移除标签（镜像尚未确认删除）',row.removedTags,true):''}${list('跳过或保留',row.skipped)}${list('失败项目',row.errors,true)}${row.error ? `<p class="cleanup-history-error">${esc(row.error)}</p>` : ''}</details>`;
  }).join('') : '<p class="hint">暂无清理记录。</p>';
}
async function loadCleanupHistory(append=false) {
  if(append && (cleanupHistoryBusy || !cleanupHistoryCursor)) return;
  const cursor=append?cleanupHistoryCursor:null,request=++cleanupHistoryRequest;
  cleanupHistoryBusy=true;
  $('#btnCleanupHistory').disabled=true;
  $('#btnCleanupHistoryMore').disabled=true;
  $('#cleanupHistoryNotice').textContent='正在读取清理历史…';
  try {
    const data=await api('/api/images/cleanup/history?limit=10'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    if(request!==cleanupHistoryRequest)return;
    cleanupHistoryRows=append?[...cleanupHistoryRows,...data.entries.filter(row=>!cleanupHistoryRows.some(existing=>existing.id===row.id))]:data.entries;
    cleanupHistoryCursor=data.nextCursor;
    renderCleanupHistory();
    $('#cleanupHistoryNotice').textContent=[...(data.warnings || []),data.retention].filter(Boolean).join('；');
    $('#btnCleanupHistoryMore').classList.toggle('hidden',!cleanupHistoryCursor);
  } catch(err) {
    if(request===cleanupHistoryRequest)$('#cleanupHistoryNotice').textContent='无法读取清理历史：'+err.message+'。可刷新重试。';
  } finally {
    if(request===cleanupHistoryRequest){cleanupHistoryBusy=false;$('#btnCleanupHistory').disabled=false;$('#btnCleanupHistoryMore').disabled=false;}
  }
}

function bindImageModal() {
  const modal = $('#imagesModal');
  $('#btnImages').addEventListener('click', () => {
    modal.classList.remove('hidden');
    refreshLocalImages();
    loadCleanupPreview();
    loadCleanupHistory();
  });
  $('#btnCloseImages').addEventListener('click', () => { modal.classList.add('hidden'); invalidateCleanupPreview('请刷新清理预览'); });
  $('#btnCleanupPreview').addEventListener('click', loadCleanupPreview);
  $('#btnCleanupRun').addEventListener('click', runManualCleanup);
  $('#btnCleanupHistory').addEventListener('click',()=>loadCleanupHistory());
  $('#btnCleanupHistoryMore').addEventListener('click',()=>loadCleanupHistory(true));

  $('#btnPullImage').addEventListener('click', async () => {
    invalidateCleanupPreview('镜像列表可能变化，请重新预览');
    const input = $('#imagePullName');
    const image = input.value.trim() || (await api('/api/images')).defaultImage;
    const progress = $('#imagePullProgress');
    progress.classList.remove('hidden');
    progress.textContent = `正在请求下载 ${image} …`;
    try {
      await api('/api/images/pull', { method: 'POST', body: JSON.stringify({ image }) });
      progress.textContent = `下载中: ${image}（进度见下方实时日志）`;
    } catch (err) {
    if (err.name === 'AbortError') return;
      progress.textContent = `下载请求失败: ${err.message}`;
    }
  });

  document.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-pick-image]');
    if (pick) {
      $('#imageInput').value = pick.dataset.pickImage;
      $('#imagesModal').classList.add('hidden');
      $('#createModal').classList.remove('hidden');
      fillRecommendedResources();
    }
  });
}

// ── Create modal ─────────────────────────────────────────────────────────────
// ── Recommended resources ────────────────────────────────────────────────────
let resourceRecommendationRequest = 0;
async function fillRecommendedResources() {
  const note = $('#recoNote');
  const request = ++resourceRecommendationRequest;
  note.textContent = '正在读取 Docker 容量与容器额度…';
  try {
    const data = await api('/api/instances/recommendations');
    if (request !== resourceRecommendationRequest) return;
    const r = data.recommended;
    // Empty fields require deliberate manual input when no safe recommendation
    // exists. In particular, never insert 0, which Docker interprets as unlimited.
    $('#resCpusInput').value = r ? r.cpus : '';
    $('#resMemInput').value = r ? r.memory : '';
    $('#resPidsInput').value = r ? r.pidsLimit : 192;
    const gib = bytes => (bytes / 1024 ** 3).toFixed(2);
    note.textContent = `Docker 总容量 ${data.totalCores} 核 / ${gib(data.totalMemBytes)} GiB；` +
      `系统预留 ${data.systemReservedCores} 核 / ${gib(data.systemReservedMemBytes)} GiB，` +
      `管理平台及其他运行容器 ${data.otherReservedCores} 核 / ${gib(data.otherReservedMemBytes)} GiB，` +
      `已有实例上限合计 ${data.reservedCores} 核 / ${gib(data.reservedMemBytes)} GiB（含已停止的主容器）。` +
      `剩余预算 ${data.remainCores} 核 / ${gib(data.remainMemBytes)} GiB。` +
      (r ? ` 推荐 ${r.cpus} 核 / ${r.memory} / 进程数 ${r.pidsLimit}，可自行修改。` : ` ${data.reason}；也可手动填写预算内的较小上限。`) +
      (data.warnings?.length ? ' ' + data.warnings.join('；') + '。' : '');
  } catch (err) {
    if (err.name === 'AbortError' || request !== resourceRecommendationRequest) return;
    $('#resCpusInput').value = '';
    $('#resMemInput').value = '';
    note.textContent = `推荐配置计算失败: ${err.message}，请手动填写；提交时会再次校验。`;
  }
}

function bindCreateModal() {
  const modal = $('#createModal');
  $('#btnNew').addEventListener('click', () => {
    modal.classList.remove('hidden');
    $('#pullProgress').classList.add('hidden');
    fillRecommendedResources();
    fillCloneSources();
    requestAnimationFrame(() => modal.querySelector('[name="name"]').focus());
  });
  $('#btnCancelCreate').addEventListener('click', () => modal.classList.add('hidden'));

  $('#createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {};
    for (const [k, v] of fd.entries()) if (String(v).trim()) body[k] = v.trim();
    if (Object.keys(body).some((k) => ['cpus', 'memory', 'pidsLimit'].includes(k))) body.resources = {};
    if (body.cpus) { body.resources.cpus = body.cpus; delete body.cpus; }
    if (body.memory) { body.resources.memory = body.memory; delete body.memory; }
    if (body.pidsLimit) { body.resources.pidsLimit = body.pidsLimit; delete body.pidsLimit; }

    const btn = $('#btnCreate');
    btn.disabled = true;
    btn.textContent = '正在开通…';
    const progress = $('#pullProgress');
    progress.classList.remove('hidden');
    progress.textContent = '正在创建实例…';
    try {
      const { instance } = await api('/api/instances', { method: 'POST', body: JSON.stringify(body) });
      logEvent(`实例 ${instance.name} 开通成功，端口 ${instance.port}`, 'ok');
      modal.classList.add('hidden');
      e.target.reset();
      state.selectedId = instance.id;
      await refresh();
      renderDetail();
    } catch (err) {
    if (err.name === 'AbortError') return;
      progress.textContent = `开通失败: ${err.message}`;
      logEvent(`开通失败: ${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '确认开通';
    }
  });
}

// Populate the "clone config from" dropdown with existing instances.
async function fillCloneSources() {
  const sel = $('#cloneFromSelect');
  if (!sel) return;
  try {
    const data = await api('/api/instances');
    sel.innerHTML = '<option value="">不复制，使用全新配置</option>' +
      data.instances.map((i) => `<option value="${esc(i.id)}">${esc(i.name)}（${esc(i.id)}）</option>`).join('');
  } catch { /* keep the empty option */ }
}

// ── Kept (archived) instances ────────────────────────────────────────────────
async function refreshKept() {
  const btn = $('#btnKept');
  let kept = [];
  try {
    kept = (await api('/api/instances/kept')).kept || [];
  } catch { /* ignore */ }
  btn.style.display = kept.length ? '' : 'none';
  return kept;
}

function bindKeptModal() {
  const modal = $('#keptModal');
  $('#btnKept').addEventListener('click', async () => {
    modal.classList.remove('hidden');
    const kept = await refreshKept();
    const box = $('#keptList');
    if (!kept.length) {
      box.innerHTML = '<div class="empty">没有保留的实例数据。</div>';
      return;
    }
    box.innerHTML = kept.map((k) => `
      <div class="image-item">
        <div>
          <div class="tag">${esc(k.name)}</div>
          <div style="color:var(--muted);font-size:11px">${esc(k.id)}${k.createdAt ? ` · 删除于 ${new Date(k.mtime).toLocaleString('zh-CN', { hour12: false })}` : ''}</div>
        </div>
        <button class="btn small primary" data-restore-kept="${esc(k.id)}">恢复</button>
      </div>`).join('');
  });
  $('#btnCloseKept').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', async (e) => {
    const r = e.target.closest('[data-restore-kept]');
    if (!r) return;
    const id = r.dataset.restoreKept;
    if (!confirm(`恢复实例 ${id}？容器需要点击「启动」重新创建。`)) return;
    try {
      const { instance } = await api(`/api/instances/kept/${encodeURIComponent(id)}/restore`, { method: 'POST' });
      logEvent(`实例 ${instance.name} 已恢复（原 ID: ${id}）`, 'ok');
      modal.classList.add('hidden');
      state.selectedId = instance.id;
      await refresh();
      renderDetail();
    } catch (err) {
    if (err.name === 'AbortError') return;
      logEvent(`恢复失败: ${err.message}`, 'err');
    }
  });
}

// ── SSE ──────────────────────────────────────────────────────────────────────
function connectSSE() {
  if (document.hidden || liveSource) return;
  const es = liveSource = new EventSource('/api/events');

  es.addEventListener('stats', (e) => {
    if (document.hidden) return;
    const d = JSON.parse(e.data);
    netRateFor(d.id, d.net, d.ts); state.stats[d.id] = d; pushPerfSample(d.id, d);
    pageActivity.queueRender();
  });
  es.addEventListener('health', (e) => {
    if (document.hidden) return;
    const d = JSON.parse(e.data); state.health[d.id] = d.health;
    pageActivity.queueRender();
  });
  es.addEventListener('lifecycle', (e) => {
    const d = JSON.parse(e.data);
    logEvent(`生命周期事件: ${d.action}（${STATE_LABEL[d.state] || d.state || '-'}）`);
    refresh().then(() => {
      // Rebuild the panel only when the selected instance is gone; even then
      // keep the dirty-guard behavior below so editors are re-populated first.
      if (!state.selectedId || !state.instances.find((i) => i.id === state.selectedId)) renderDetail();
    });
  });

  es.addEventListener('pull', (e) => {
    const d = JSON.parse(e.data);
    if (d.status === 'started') logEvent(`开始拉取镜像 ${d.image}`);
    if (d.status === 'done') logEvent(`镜像拉取完成${d.fromCache ? '（使用本地缓存）' : ''}`, 'ok');
    if (d.status === 'error') logEvent(`镜像拉取失败: ${d.error}`, 'err');
    // image-store pull: update the modal progress line
    const progress = $('#imagePullProgress');
    if (d.id === 'image-store' && progress && !progress.classList.contains('hidden')) {
      if (d.status === 'done') { progress.textContent = `✓ ${d.image} 已下载到本地`; refreshLocalImages(); }
      else if (d.status === 'error') progress.textContent = `✗ 下载失败: ${d.error}`;
      else if (d.status === 'progress' && d.progress) progress.textContent = `下载中: ${d.progress}`;
    }
  });
}

// Update just the perf numbers without re-rendering (keeps textarea focus).
const perfHistory = {}; // id -> [{cpu, mem, ts}] last 120 samples (≈6 min)

function pushPerfSample(id, st) {
  const arr = perfHistory[id] || (perfHistory[id] = []);
  arr.push({ cpu: st.cpuPercent || 0, mem: st.memPercent || 0, ts: st.ts });
  if (arr.length > 120) arr.shift();
}

function drawSparkline() {
  const canvas = $('#perfSpark');
  if (!canvas || document.hidden || activeDetailTab !== 'overview') return;
  const inst = state.instances.find((i) => i.id === state.selectedId);
  const arr = inst ? (perfHistory[inst.id] || []) : [];
  const ctx = canvas.getContext('2d');
  const w = canvas.width, hgt = canvas.height;
  ctx.clearRect(0, 0, w, hgt);
  if (arr.length < 2) {
    ctx.fillStyle = '#63756d';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('CPU / 内存 趋势（每 3 秒采样，最多保留 120 个点）', 4, hgt / 2 + 4);
    return;
  }
  const series = [
    { color: '#527568', get: (p) => p.cpu / (inst?.resources?.cpus || state.system?.ncpu || 1) },
    { color: '#7d91a8', get: (p) => p.mem },
  ];
  for (const s of series) {
    ctx.beginPath();
    arr.forEach((p, i) => {
      const x = (i / (arr.length - 1)) * (w - 2) + 1;
      const y = hgt - 2 - (Math.min(100, s.get(p)) / 100) * (hgt - 4);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.fillStyle = '#527568';
  ctx.fillRect(w - 74, 4, 10, 2);
  ctx.fillStyle = '#7d91a8';
  ctx.fillRect(w - 74, 12, 10, 2);
  ctx.fillStyle = '#63756d';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.fillText('CPU', w - 60, 8);
  ctx.fillText('内存', w - 60, 16);
}

// Update just the perf numbers without re-rendering (keeps textarea focus).
function renderDetailStatsOnly(st) {
  const inst = state.instances.find((i) => i.id === st.id);
  const r = (inst && inst.resources) || {};
  const cards = $$('#detailPanel .stat-card');
  if (cards.length >= 3) {
    cards[0].querySelector('.value').innerHTML = `${st.cpuPercent}<small style="font-size:12px;color:var(--muted)"> %</small>`;
    cards[0].querySelector('.bar i').style.width = `${Math.min(100, st.cpuPercent / (r.cpus || state.system?.ncpu || 1))}%`;
    cards[1].querySelector('.value').textContent = fmtBytes(st.memUsed);
    cards[1].querySelector('.sub').textContent = `上限 ${r.memoryBytes ? fmtBytes(r.memoryBytes) : '未限制'}`;
    cards[1].querySelector('.bar i').style.width = `${Math.min(100, st.memPercent)}%`;
    cards[2].querySelector('.value').innerHTML =
      `${fmtRate(netRates[st.id] && netRates[st.id].rxRate)} ↓<br>${fmtRate(netRates[st.id] && netRates[st.id].txRate)} ↑`;
    cards[2].querySelector('.sub').textContent = `采样于 ${fmtTime(st.ts)}`;
  }
  drawSparkline();
}

// ── Detail tabs / rename / busy / modals ─────────────────────────────────────
function switchDetailTab(tabId) {
  activeDetailTab = tabId;
  loadFeatureTab(tabId);
  $$('#detailPanel .detail-tab').forEach((t) => t.classList.toggle('active', t.dataset.detailTab === tabId));
  $$('#detailPanel .detail-tabpage').forEach((p) => p.classList.toggle('hidden', p.dataset.tabpage !== tabId));
  // Lazy-load content for tabs that may never have been opened.
  if (tabId === 'channels' && $('#modelDefault') && !lastModelConfig) { loadModelConfig(); loadFeishuConfig(); }
  if (tabId === 'config' && $('#configEditor') && $('#configEditor').value === '加载中…') { loadConfig('json'); loadConfig('env'); }
  if (tabId === 'logs' && $('#logView')) { if ($('#logView').dataset.loaded === '1') applyLogFilter(); else loadLogs(); }
  if (tabId === 'sessions' && $('#sessList') && $('#sessList').textContent === '加载中…') loadSessions();
  if (tabId === 'overview') drawSparkline();
  syncTerminalAnimation();
}

const BUSY_ACTIONS = {
  start: '启动中…', stop: '停止中…', restart: '重启中…',
  delete: '删除中…',
};

// Disable lifecycle buttons while an action is in flight.
// renderDetailLive restores labels/disabled state on the
// next refresh tick after the action completes.
function setActionBusy(act) {
  for (const b of $$('#detailPanel .actions [data-act]')) {
    const a = b.dataset.act;
    if (!(a in BUSY_ACTIONS)) continue;
    if (a === act) {
      b.disabled = true;
      b.textContent = BUSY_ACTIONS[a];
    } else {
      b.disabled = true;
    }
  }
}

function bindModalDismiss() {
  // Keep keyboard navigation inside the active dialog and return focus to
  // its opener when closed, including dialogs opened by an empty-state action.
  let outsideFocus = document.activeElement;
  document.addEventListener('focusin', event => {
    if (!event.target.closest('.modal')) outsideFocus = event.target;
  });
  for (const modal of $$('.modal')) {
    let opener = null;
    const card = modal.querySelector('.modal-card');
    if (card && !card.hasAttribute('role')) {
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-label', card.querySelector('h3')?.textContent || '对话框');
    }
    new MutationObserver(() => {
      if (modal.classList.contains('hidden')) {
        if (opener?.isConnected) opener.focus();
      } else {
        opener = outsideFocus;
        const first = modal.querySelector('input:not([disabled]), select:not([disabled]), button:not([disabled])');
        if (first) first.focus();
      }
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  }
  document.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const modal = $$('.modal:not(.hidden)').at(-1);
    if (!modal) return;
    const controls = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex="0"]')]
      .filter(element => element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (!first) return;
    if (!modal.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });
  // ESC closes any open modal.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const id of ['imagesModal', 'createModal', 'chatModal', 'renameModal', 'keptModal']) {
      const m = document.getElementById(id);
      if (m && !m.classList.contains('hidden')) m.classList.add('hidden');
    }
  });
  // Backdrop click closes the create/images modals (the chat modal keeps its
  // own close button only, so a stray click never discards a pending reply).
  document.addEventListener('mousedown', (e) => {
    for (const id of ['imagesModal', 'createModal']) {
      const m = document.getElementById(id);
      if (m && !m.classList.contains('hidden') && e.target === m) m.classList.add('hidden');
    }
  });
}

async function promptRename() {
  const inst = state.instances.find((i) => i.id === state.selectedId);
  if (!inst) return;
  // Modal-based rename (replaces the bare window.prompt).
  $('#renameHint').textContent = `正在为「${inst.name}」（${inst.id}）改名。`;
  $('#renameInput').value = inst.name;
  $('#renameModal').classList.remove('hidden');
  const input = $('#renameInput');
  input.focus();
  input.select();
}

async function confirmRename() {
  const inst = state.instances.find((i) => i.id === state.selectedId);
  if (!inst) return;
  const trimmed = $('#renameInput').value.trim();
  if (!trimmed) { $('#renameInput').focus(); return; }
  if (trimmed === inst.name) { $('#renameModal').classList.add('hidden'); return; }
  try {
    await api(`/api/instances/${state.selectedId}`, { method: 'PATCH', body: JSON.stringify({ name: trimmed }) });
    logEvent(`实例已改名为「${trimmed}」`, 'ok');
    $('#renameModal').classList.add('hidden');
    renderDetail._currentId = null; // force rebuild to refresh the title
    await refresh();
    renderDetail();
  } catch (err) {
    if (err.name === 'AbortError') return;
    logEvent(`改名失败: ${err.message}`, 'err');
    $('#renameHint').textContent = `改名失败: ${err.message}`;
  }
}

// Enter confirms, ESC closes, focus returns to the input on reopen.
function bindRenameModal() {
  $('#btnConfirmRename').addEventListener('click', confirmRename);
  $('#btnCancelRename').addEventListener('click', () => $('#renameModal').classList.add('hidden'));
  $('#renameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmRename(); }
  });
  $('#renameModal').addEventListener('mousedown', (e) => {
    if (e.target === $('#renameModal')) $('#renameModal').classList.add('hidden');
  });
}

async function clearError() {
  try {
    await api(`/api/instances/${state.selectedId}/clear-error`, { method: 'POST' });
    logEvent('已清除错误提示', 'ok');
    await refresh();
    const inst = state.instances.find((i) => i.id === state.selectedId);
    if (inst) renderDetailLive(inst);
  } catch (err) {
    if (err.name === 'AbortError') return;
    logEvent(`清除失败: ${err.message}`, 'err');
  }
}

// ── Data refresh ─────────────────────────────────────────────────────────────
let instancesRefresh = null;
function refresh() {
  if (instancesRefresh) return instancesRefresh;
  instancesRefresh = refreshInstances().finally(() => { instancesRefresh = null; });
  return instancesRefresh;
}
async function refreshInstances() {
  try {
    const data = await api('/api/instances');
    state.instances = data.instances;
    state.system = data.system;
    for (const inst of state.instances) {
      if (inst.health) state.health[inst.id] = inst.health;
    }
    renderList();
    renderSystem();
  } catch (err) {
    if (err.name === 'AbortError') return;
    $('#systemInfo').textContent = `连接失败: ${err.message}`;
  }
}

// ── Event delegation ─────────────────────────────────────────────────────────
document.addEventListener('click', async (e) => {
  // Detail tab switching (visibility only; lazy-loads hidden tab content).
  const dtab = e.target.closest('[data-detail-tab]');
  if (dtab) {
    switchDetailTab(dtab.dataset.detailTab);
    return;
  }
  if (e.target.id === 'btnToggleAddModel') { toggleAddModelForm(); return; }
  if (e.target.id === 'btnCancelAddModel') { toggleAddModelForm(false); return; }
  if (e.target.id === 'btnCancelEditModel') { closeEditModel(); return; }
  if (e.target.id === 'btnSaveEditModel') { await saveEditModel(); return; }
  // Model list row actions (test / copy cred / switch default / delete)
  const testBtn = e.target.closest('[data-model-test]');
  if (testBtn) {
    await testSavedModel(testBtn.dataset.modelTest);
    return;
  }
  const copyBtn = e.target.closest('[data-model-copycred]');
  if (copyBtn) {
    copyModelCred(copyBtn.dataset.modelCopycred);
    return;
  }
  const editBtn = e.target.closest('[data-model-edit]');
  if (editBtn) {
    openEditModel(editBtn.dataset.modelEdit);
    return;
  }
  // Model list row actions (switch default / delete)
  const switchBtn = e.target.closest('[data-model-switch]');
  if (switchBtn) {
    await switchDefaultModel(switchBtn.dataset.modelSwitch);
    return;
  }
  const delBtn = e.target.closest('[data-model-del]');
  if (delBtn && !delBtn.disabled) {
    await deleteModel(delBtn.dataset.modelDel);
    return;
  }
  // Session list interactions (open transcript / delete one / checkbox row).
  const sessOpen = e.target.closest('[data-sess-open]');
  if (sessOpen) {
    await openSession(sessOpen.dataset.sessOpen);
    return;
  }
  if (e.target.id === 'btnSessSend') { await sendSessionMessage(); return; }
  const sessDel = e.target.closest('[data-sess-del]');
  if (sessDel) {
    await deleteSessions([sessDel.dataset.sessDel]);
    return;
  }
  const sessItem = e.target.closest('.sess-item');
  if (sessItem && !e.target.closest('.sess-check') && !e.target.closest('button')) {
    await openSession(sessItem.dataset.sessKey);
    return;
  }
  const item = e.target.closest('.instance-item');
  if (item) {
    if (item.dataset.id !== state.selectedId && hasUnsaved() && !confirm('当前实例有未保存的修改，切换后放弃这些修改？')) return;
    state.selectedId = item.dataset.id;
    renderList();
    renderDetail();
    return;
  }
  const tab = e.target.closest('.tab');
  if (tab) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#tab-json').classList.toggle('hidden', tab.dataset.tab !== 'json');
    $('#tab-env').classList.toggle('hidden', tab.dataset.tab !== 'env');
    return;
  }
  const actBtn = e.target.closest('[data-act]');
  if (actBtn) {
    const act = actBtn.dataset.act;
    if (act === 'start' || act === 'stop' || act === 'restart' || act === 'delete' || act === 'openUI' || act === 'toggleToken' || act === 'copyToken') {
      instanceAction(act);
    } else if (act === 'chat') openChatModal();
    else if (act === 'rename') promptRename();
    else if (act === 'clearError') clearError();
    else if (act === 'saveRes') saveResources();
    else if (act === 'reloadModel') loadModelConfig();
    else if (act === 'detectAddModel') detectModelCapabilities(false);
    else if (act === 'detectEditModel') detectModelCapabilities(true);
    else if (act === 'saveModel') saveModelConfig();
    else if (act === 'testModel') testModelConn();
    else if (act === 'reloadFeishu') loadFeishuConfig();
    else if (act === 'saveFeishu') saveFeishuConfig();
    else if (act === 'testFeishu') testFeishuConn();
    else if (act === 'reloadCfg') loadConfig('json');
    else if (act === 'fmtCfg') formatJson();
    else if (act === 'saveCfg') saveConfig('json', false);
    else if (act === 'saveCfgRestart') saveConfig('json', true);
    else if (act === 'reloadEnv') loadConfig('env');
    else if (act === 'saveEnv') saveConfig('env', false);
    else if (act === 'reloadLogs') loadLogs();
    else if (act === 'downloadLogs') downloadLogs();
    else if (act === 'reloadSessions') loadSessions();
    else if (act === 'sessDelSelected') deleteSessions(checkedSessionKeys());
    else if (act === 'sessArchiveSelected') archiveSessions(checkedSessionKeys());
    else if (act === 'closeSession') closeSession();
    else if (act === 'sessCompact') compactSession(null);
    else if (act === 'sessCompactTail') compactSession(200);
    else if (act === 'termReconnect') reconnectTerminal();
    else if (act === 'termClear') { if (termState.term) termState.term.clear(); }
  }
});

// Pretty-print the JSON editor content in place (invalid JSON → keep hint).
function formatJson() {
  const ta = $('#configEditor');
  const err = $('#jsonError');
  if (!ta) return;
  try {
    ta.value = JSON.stringify(JSON.parse(ta.value), null, 2) + '\n';
    if (err) err.textContent = '';
  } catch (e) {
    if (err) err.textContent = `JSON 无效，无法格式化: ${e.message}`;
  }
}

$('#btnClearLog').addEventListener('click', () => { $('#eventLog').innerHTML = ''; });
$('#btnToggleLog').addEventListener('click', () => {
  const panel = $('#logPanel');
  const collapsed = panel.classList.toggle('collapsed');
  $('#btnToggleLog').textContent = collapsed ? '展开' : '收起';
});
$('#instanceSearch').addEventListener('input', renderList);
document.addEventListener('click', event => {
  if (event.target.closest('[data-create-instance]')) $('#btnNew').click();
  const filter = event.target.closest('[data-instance-filter]');
  const reset = event.target.closest('[data-reset-filter]');
  if (!filter && !reset) return;
  instanceFilter = reset ? 'all' : filter.dataset.instanceFilter;
  if (reset) $('#instanceSearch').value = '';
  for (const button of $$('[data-instance-filter]')) {
    const active = button.dataset.instanceFilter === instanceFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  renderList();
});

// Log toolbar interactions (delegated: the toolbar re-renders with the panel).
document.addEventListener('change', (e) => {
  if (e.target.id === 'logTail') loadLogs();
  if (e.target.id === 'sessLimit') loadSessions();
  if (e.target.id === 'logAuto' && e.target.checked) loadLogs();
});
const filterTimers = new Map();
function scheduleFilter(input, apply) {
  clearTimeout(filterTimers.get(input.id));
  input.dataset.pendingFilter = '1';
  filterTimers.set(input.id, setTimeout(() => {
    filterTimers.delete(input.id);
    if (!document.hidden && input.isConnected) { input.dataset.pendingFilter = ''; apply(); }
  }, 150));
}
document.addEventListener('input', (e) => {
  if (e.target.id === 'logFilter') scheduleFilter(e.target, applyLogFilter);
  if (e.target.id === 'sessFilter') scheduleFilter(e.target, renderSessionList);
});
// Session detail: Enter in the input sends the message (delegated so it
// survives panel rebuilds).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'sessInput') {
    e.preventDefault();
    sendSessionMessage();
  }
});
let logAutoTimer = null;

// ── Boot ─────────────────────────────────────────────────────────────────────
// Protect every editable area from silent overwrite:
//  - data-dirty is set on first user keystroke in model/feishu inputs; loaders
//    then skip prefill for those fields.
//  - config editors (openclaw.json / .env): snapshot user content before any
//    re-render and restore it afterwards, so a panel rebuild can't drop edits.
const EDITABLE_SELECTORS = ['#configEditor', '#envEditor', '#mBaseUrl', '#mApiKey', '#mModel', '#mContextWindow', '#fAppId', '#fAppSecret', '#emNewName', '#emBaseUrl', '#emApiKey', '#emContextWindow'];

function bindFormDirtyGuards() {
  for (const sel of EDITABLE_SELECTORS) {
    document.addEventListener('input', (e) => {
      if (e.target && e.target.matches && e.target.matches(sel)) {
        e.target.dataset.dirty = '1';
      }
    });
  }
}

function snapshotEditorDrafts() {
  return {
    selectedId: state.selectedId,
    config: $('#configEditor') ? $('#configEditor').value : null,
    env: $('#envEditor') ? $('#envEditor').value : null,
    logs: $('#logView') ? $('#logView').value : null,
  };
}

function restoreEditorDrafts(snap) {
  if (!snap || snap.selectedId !== state.selectedId) return; // real instance switch
  const cfg = $('#configEditor');
  const env = $('#envEditor');
  const logs = $('#logView');
  // A rebuild re-triggers loadConfig/loadLogs; wait for those writes, then put
  // the user's draft back if they differ.
  const restore = () => {
    if (cfg && snap.config !== null && cfg.value !== snap.config) cfg.value = snap.config;
    if (env && snap.env !== null && env.value !== snap.env) env.value = snap.env;
    if (logs && snap.logs !== null && logs.value !== snap.logs) logs.value = snap.logs;
  };
  setTimeout(restore, 50);
  setTimeout(restore, 400);
}

bindFormDirtyGuards();
bindModalDismiss();
bindRenameModal();

bindCreateModal();
bindImageModal();
bindKeptModal();
refreshKept();
refreshLocalImages();
let refreshingBackup = false;
async function refreshBackupStatus() {
  if (refreshingBackup) return;
  refreshingBackup = true;
  try {
    const data = await api('/api/backups/status');
    const panel = $('#backupStatus');
    const signature = JSON.stringify([data.state, data.lastError, data.lastSuccess, data.schedule, data.nextRunAt]);
    $('#btnBackupNow').disabled = data.state === 'running';
    if (panel.dataset.signature === signature) return;
    panel.dataset.signature = signature;
    const failed = ['failed', 'overdue'].includes(data.state);
    panel.classList.toggle('failed', failed);
    panel.classList.toggle('running', data.state === 'running');
    $('#backupSummary').textContent = data.state === 'running' ? '正在备份，实例继续运行' : failed
      ? `备份失败或未完成：${data.lastError || '请重试'}` : data.lastSuccess
        ? `最近成功：${new Date(data.lastSuccess.completedAt).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false})}`
        : data.schedule.enabled ? '等待首次备份' : '尚未启用每日备份';
    const schedule = data.schedule;
    const time = `${String(schedule.hour).padStart(2,'0')}:${String(schedule.minute).padStart(2,'0')}`;
    $('#backupDetail').textContent = `${schedule.enabled ? `每天 ${time}（上海时间）` : '每日计划未启用'} · 保留最近 7 天` +
      (data.lastSuccess ? ` · 已备份 ${data.lastSuccess.instanceCount} 个实例（含保留数据），${fmtBytes(data.lastSuccess.bytes)}` : '') +
      (data.nextRunAt ? ` · 下次 ${new Date(data.nextRunAt).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false})}` : '');
    $('#btnBackupNow').disabled = data.state === 'running';
    $('#btnBackupNow').textContent = failed ? '立即重试' : '立即备份';
  } catch(error) {
    $('#backupStatus').dataset.signature = '';
    $('#backupStatus').classList.add('failed');
    $('#backupSummary').textContent = `无法读取备份状态：${error.message}`;
    $('#btnBackupNow').disabled = false;
  } finally { refreshingBackup = false; }
}
$('#btnBackupNow').addEventListener('click', async () => {
  $('#btnBackupNow').disabled = true;
  try { await api('/api/backups/run', {method:'POST',body:'{}'}); }
  catch(error) { logEvent(`启动备份失败：${error.message}`, 'err'); }
  await refreshBackupStatus();
});

function hasUnsaved() { return $$('#detailPanel [data-dirty="1"]').some(element => element.type === 'checkbox' ? String(element.checked) !== element.dataset.savedValue : element.value !== element.dataset.savedValue); }
window.addEventListener('beforeunload', event => { if (hasUnsaved()) { event.preventDefault(); event.returnValue = ''; } });
function chooseDelete(id) {
  return new Promise(resolve => {
    const inst = state.instances.find(i => i.id === id);
    const dialog = document.createElement('dialog');
    dialog.innerHTML = `<h3>删除实例：${esc(inst?.name || id)}</h3><p>选择数据处理方式。彻底删除会移除配置、凭据与工作区。</p><div style="display:flex;gap:12px"><button data-choice="cancel">取消</button><button data-choice="keep">删除并保留数据</button><button data-choice="all">删除全部数据</button></div>`;
    document.body.appendChild(dialog);
    const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    dialog.addEventListener('click', event => {
      const choice = event.target.dataset.choice;
      if (choice === 'cancel') finish(null);
      if (choice === 'keep') finish(true);
      if (choice === 'all' && confirm(`永久删除「${inst?.name || id}」的全部数据？此操作不可恢复。`)) finish(false);
    });
    dialog.showModal();
  });
}

function syncTerminalAnimation(visible = !document.hidden) {
  if (termState.term) termState.term.options.cursorBlink = visible && activeDetailTab === 'terminal';
  if (!visible || activeDetailTab !== 'terminal') {
    if (termState.reconnectTimer) clearTimeout(termState.reconnectTimer);
    termState.reconnectTimer = null;
  } else ensureTerminal();
}
function renderRealtime() {
  renderList();
  const inst = state.instances.find(item => item.id === state.selectedId);
  if (!inst || !$('#detailPanel .detail-title')) return;
  renderDetailLive(inst);
  if (activeDetailTab === 'overview' && inst.state === 'running' && state.stats[inst.id]) renderDetailStatsOnly(state.stats[inst.id]);
}
let lastInstancesPoll = 0;
pageActivity = createPageActivity({
  document, window,
  onActivate() { ensureSession().then(() => { if (pageActivity.isActive()) connectSSE(); }).catch(error => logEvent(error.message, 'err')); },
  onDeactivate() { if (liveSource) { liveSource.close(); liveSource = null; } },
  onVisibility(visible) {
    syncTerminalAnimation(visible);
    if (!visible) { for (const timer of filterTimers.values()) clearTimeout(timer); filterTimers.clear(); }
    else {
      if (activeDetailTab === 'logs') applyLogFilter();
      if (activeDetailTab === 'sessions' && $('#sessFilter')?.dataset.pendingFilter === '1') {
        $('#sessFilter').dataset.pendingFilter = ''; renderSessionList();
      }
    }
  },
  onRender: renderRealtime,
  async onPoll(resumed) {
    const tasks = [refreshBackupStatus()];
    if (feishuRefresh && feishuRefresh.id !== state.selectedId) feishuRefresh = null;
    if (feishuRefresh && activeDetailTab === 'channels' && Date.now() >= feishuRefresh.after) {
      feishuRefresh = null; tasks.push(loadFeishuConfig());
    }
    if (resumed || Date.now() - lastInstancesPoll >= 30000) {
      lastInstancesPoll = Date.now();
      tasks.push(refresh().then(() => renderDetail()));
    }
    if (activeDetailTab === 'logs' && $('#logAuto')?.checked) tasks.push(loadLogs());
    await Promise.allSettled(tasks);
  },
});
pageActivity.start();
