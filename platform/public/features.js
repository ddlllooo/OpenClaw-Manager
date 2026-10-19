'use strict';
/* Shared classic-script scope with app.js; requests retain its instance guards. */
let workspaceState = null;
let workspaceLoadSequence = 0;
let automationState = { jobs: [], models: [], editing: null, offset: 0 };
const chatAttachments = new Map();
const chatFileReading = new Set();
function resetInstanceFeatures() {
  resetManagement();
  workspaceState = null;
  workspaceLoadSequence++;
  automationState = { jobs: [], models: [], editing: null, offset: 0 };
}
function featurePages(tab) {
  return `<div class="detail-tabpage ${tab === 'workspace' ? '' : 'hidden'}" data-tabpage="workspace">
    <div class="detail-section"><h3>工作区与记忆</h3>
      <div class="feature-toolbar"><label>文件<select id="wsPath" class="input"></select></label><button class="btn small" data-feature="wsReload">重新加载</button>
      <label>新建记忆文件<input id="wsNewPath" class="input" placeholder="memory/2026-10-15.md"></label><button class="btn small" data-feature="wsNew">打开 / 新建</button></div>
      <div id="wsHint" class="save-hint" role="status"></div>
      <textarea id="wsEditor" class="feature-editor" spellcheck="false" aria-label="工作区文件内容" placeholder="选择文件后开始编辑"></textarea>
      <div class="feature-toolbar"><button class="btn small primary" data-feature="wsPreview">预览修改</button>
      <label>历史版本<select id="wsHistory" class="input"><option value="">暂无历史版本</option></select></label><button class="btn small" data-feature="wsVersion">预览历史版本</button></div>
      <div id="wsDiff" class="feature-review hidden"><div id="wsDiffLabel"></div><div class="feature-diff"><div><b>当前已保存</b><pre id="wsBefore"></pre></div><div><b>待保存内容</b><pre id="wsAfter"></pre></div></div>
      <button class="btn small primary" data-feature="wsCommit">确认保存</button><button class="btn small" data-feature="wsCancel">取消</button></div>
      <p class="reco-note">管理当前默认工作区中的角色、规则和记忆。保存前预览差异，保留最近 20 个历史版本；助手通常在下一次加载这些文件时使用新内容。</p>
    </div></div>
    <div class="detail-tabpage ${tab === 'automations' ? '' : 'hidden'}" data-tabpage="automations">
    <div class="detail-section"><h3>定时任务</h3><div class="feature-toolbar"><button class="btn small primary" data-feature="cronNew">新建任务</button><button class="btn small" data-feature="cronReload">刷新</button><button class="btn small" data-feature="cronPrev">上一页</button><button class="btn small" data-feature="cronNext">下一页</button><span id="cronPage"></span></div>
    <div id="cronHint" class="save-hint" role="status"></div><div id="cronList">打开页签后加载任务。</div>
    <div id="cronEditor" class="feature-review hidden"><h4 id="cronEditorTitle">新建任务</h4><div class="feature-form">
      <label>任务名称<input class="input" id="cronName" maxlength="120"></label>
      <label>执行方式<select class="input" id="cronKind"><option value="cron">Cron 周期</option><option value="every">固定间隔</option><option value="at">单次执行</option></select></label>
      <label>执行时间 / 间隔<input class="input" id="cronSchedule" placeholder="0 9 * * *"></label>
      <label>时区<input class="input" id="cronTimezone" value="Asia/Shanghai" placeholder="Asia/Shanghai"></label>
      <label>模型<select class="input" id="cronModel"><option value="">使用默认模型</option></select></label>
      <label>执行 Agent<select class="input" id="cronAgent"><option value="main">main</option></select></label>
      <label>结果推送<select class="input" id="cronDelivery"><option value="none">仅保存执行记录，不推送</option><option value="feishu">推送到飞书</option><option value="last">使用最近渠道</option></select></label>
      <label>接收目标<input class="input" id="cronTo" placeholder="指定群或用户 ID"></label>
      <label>渠道账号（可选）<input class="input" id="cronAccount" placeholder="默认账号"></label>
    </div><label class="feature-message">任务内容<textarea class="feature-editor short" id="cronMessage" placeholder="说明需要完成的任务与输出要求"></textarea></label>
    <label class="feature-check"><input type="checkbox" id="cronEnabled"> 启用任务</label><p id="cronScheduleHelp" class="reco-note">Cron 示例：0 9 * * * 表示每天 09:00；间隔填分钟数；单次时间填写带时区的 ISO 时间。</p>
    <div class="feature-toolbar"><button class="btn small primary" data-feature="cronSave">保存任务</button><button class="btn small" data-feature="cronCancel">取消</button></div></div>
    <div id="cronRuns" class="feature-review hidden"></div><p class="reco-note">任务由当前实例的 OpenClaw 调度。实例停止时无法执行；新建任务默认不启用，推送目标由你指定。</p>
    </div></div>`;
}
function diagnosticsPanel() {
  return `<div class="detail-section"><h3>一键诊断</h3><button class="btn small" data-feature="diagnose">检查实例</button><span id="diagHint" class="save-hint" role="status"></span><div id="diagResult"></div></div>`;
}
function loadFeatureTab(tab) {
  loadManagementTab(tab);
  if (tab === 'workspace' && !workspaceState) loadWorkspace();
  if (tab === 'automations' && !$('#cronList')?.dataset.loaded) loadAutomations();
}
function featureFailure(error, selector) {
  if (error.name !== 'AbortError' && $(selector)) $(selector).textContent = `失败：${error.message}`;
}
async function loadWorkspace(relative) {
  const hint = $('#wsHint'); if (!hint) return;
  const sequence = ++workspaceLoadSequence;
  const selected = relative || workspaceState?.path || 'AGENTS.md';
  hint.textContent = '正在读取工作区…';
  try {
    const listing = await api(`/api/instances/${state.selectedId}/workspace`);
    if (sequence !== workspaceLoadSequence) return;
    $('#wsPath').innerHTML = listing.files.map(row => `<option value="${esc(row.path)}">${esc(row.path)}${row.exists ? '' : '（未创建）'}</option>`).join('');
    if (!listing.files.some(r => r.path === selected)) $('#wsPath').insertAdjacentHTML('beforeend', `<option value="${esc(selected)}">${esc(selected)}</option>`);
    $('#wsPath').value = selected;
    const row = await api(`/api/instances/${state.selectedId}/workspace/file?path=${encodeURIComponent(selected)}`);
    if (sequence !== workspaceLoadSequence) return;
    workspaceState = { ...row, restoreVersion: null, pending: null };
    const editor = $('#wsEditor'); editor.value = row.content; editor.dataset.savedValue = row.content; editor.dataset.dirty = '';
    $('#wsDiff').classList.add('hidden');
    const history = await api(`/api/instances/${state.selectedId}/workspace/history?path=${encodeURIComponent(selected)}`);
    if (sequence !== workspaceLoadSequence) return;
    $('#wsHistory').innerHTML = '<option value="">选择历史版本</option>' + history.versions.map(v => `<option value="${esc(v.version)}">${esc(new Date(v.savedAt).toLocaleString('zh-CN'))} · ${v.bytes} 字节</option>`).join('');
    hint.textContent = row.exists ? `已加载 ${row.path}` : `${row.path} 尚未创建，保存后创建文件。`;
  } catch (error) { featureFailure(error, '#wsHint'); }
}
function workspaceDirty() { return $('#wsEditor')?.dataset.dirty === '1'; }
function reviewWorkspace(content, label, restoreVersion = null) {
  if (!workspaceState) return;
  workspaceState.pending = content; workspaceState.restoreVersion = restoreVersion;
  $('#wsBefore').textContent = workspaceState.content;
  $('#wsAfter').textContent = content;
  $('#wsDiffLabel').textContent = label;
  $('#wsDiff').classList.remove('hidden');
}
async function saveWorkspace() {
  if (!workspaceState || workspaceState.pending === null) return;
  const snapshot = workspaceState;
  $('#wsHint').textContent = '保存中…';
  try {
    const body = { path: workspaceState.path, revision: workspaceState.revision };
    const restore = workspaceState.restoreVersion;
    Object.assign(body, restore ? { version: restore } : { content: workspaceState.pending });
    await api(`/api/instances/${state.selectedId}/workspace/${restore ? 'restore' : 'file'}`, { method: restore ? 'POST' : 'PUT', body: JSON.stringify(body) });
    if (workspaceState !== snapshot) return;
    $('#wsEditor').dataset.dirty = '';
    await loadWorkspace(workspaceState.path);
    $('#wsHint').textContent = restore ? '历史版本已恢复，恢复前的内容也已保留。' : '已保存，原有内容已保留到历史版本。';
  } catch (error) { featureFailure(error, '#wsHint'); }
}
function cronTime(value) { return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'; }
function cronScheduleLabel(schedule) {
  if (schedule?.kind === 'cron') return `${schedule.expr} · ${schedule.tz || '网关时区'}`;
  if (schedule?.kind === 'every') return `每 ${schedule.everyMs / 60000} 分钟`;
  if (schedule?.kind === 'at') return cronTime(schedule.at);
  return schedule?.kind || '未知';
}
async function loadAutomations(offset = automationState.offset) {
  if (!$('#cronList')) return;
  $('#cronHint').textContent = '读取任务中…';
  try {
    const [data, models, agents] = await Promise.all([api(`/api/instances/${state.selectedId}/automations?offset=${offset}`), api(`/api/instances/${state.selectedId}/model`), api(`/api/instances/${state.selectedId}/agents`)]);
    automationState.agents = agents.agents;
    automationState.jobs = data.jobs || []; automationState.models = models.models || []; automationState.offset = offset;
    automationState.hasMore = data.hasMore === true || (Number(data.total) > offset + automationState.jobs.length);
    $('#cronList').dataset.loaded = '1';
    $('#cronList').innerHTML = automationState.jobs.length ? automationState.jobs.map(job => `<div class="feature-row"><div><b>${esc(job.displayName || job.name || job.id)}</b> <span class="badge">${job.enabled ? '已启用' : '已停用'}</span>
      <div class="reco-note">${esc(cronScheduleLabel(job.schedule))} · 下次 ${esc(cronTime(job.state?.nextRunAtMs))}</div>
      <div class="reco-note">最近状态 ${esc(job.state?.lastRunStatus || job.state?.lastStatus || '未执行')}${job.state?.lastError ? ' · ' + esc(job.state.lastError) : ''}</div></div>
      <div class="feature-toolbar">${job.editable ? `<button class="btn small" data-cron="edit" data-job="${esc(job.id)}">编辑</button><button class="btn small" data-cron="toggle" data-job="${esc(job.id)}">${job.enabled ? '停用' : '启用'}</button><button class="btn small" data-cron="run" data-job="${esc(job.id)}">立即运行</button>` : '<span class="reco-note">在控制台管理此类任务</span>'}
      <button class="btn small" data-cron="runs" data-job="${esc(job.id)}">执行记录</button>${job.editable ? `<button class="btn small danger" data-cron="delete" data-job="${esc(job.id)}">删除</button>` : ''}</div></div>`).join('') : '<p class="reco-note">暂无定时任务。</p>';
    $('#cronPage').textContent = `第 ${Math.floor(offset / 100) + 1} 页 · ${automationState.jobs.length} 项`;
    $('[data-feature="cronPrev"]').disabled = offset === 0; $('[data-feature="cronNext"]').disabled = !automationState.hasMore;
    $('#cronHint').textContent = '';
  } catch (error) { featureFailure(error, '#cronHint'); }
}
function openCronEditor(job = null) {
  if (!$('#cronEditor').classList.contains('hidden') && cronEditorDirty() && !confirm('放弃当前未保存的任务修改？')) return;
  automationState.editing = job;
  $('#cronEditorTitle').textContent = job ? '编辑任务' : '新建任务';
  const values = { cronName: job?.name || '', cronKind: job?.schedule?.kind || 'cron',
    cronSchedule: job?.schedule?.kind === 'every' ? String(job.schedule.everyMs / 60000) : job?.schedule?.kind === 'at' ? job.schedule.at : job?.schedule?.expr || '0 9 * * *',
    cronTimezone: job?.schedule?.tz || 'Asia/Shanghai', cronMessage: job?.payload?.message || '',
    cronTo: job?.delivery?.to || '', cronAccount: job?.delivery?.accountId || '' };
  const model = job?.payload?.model || '';
  const modelRefs = automationState.models.map(m => ({ value: `${m.pid}/${m.id}`, label: m.id }));
  if (model && !modelRefs.some(m => m.value === model)) modelRefs.push({ value: model, label: model });
  $('#cronModel').innerHTML = '<option value="">使用默认模型</option>' + modelRefs.map(m => `<option value="${esc(m.value)}">${esc(m.label)}</option>`).join('');
  $('#cronModel').value = model;
  $('#cronAgent').innerHTML = (automationState.agents || [{id:'main'}]).map(a => `<option value="${esc(a.id)}">${esc(a.name || a.id)} (${esc(a.id)})</option>`).join('');
  $('#cronAgent').value = job?.agentId || (automationState.agents?.some(a => a.id === 'main') ? 'main' : automationState.agents?.[0]?.id || 'main');
  const delivery = job?.delivery?.mode === 'announce' ? job.delivery.channel || 'last' : job?.delivery?.mode && job.delivery.mode !== 'none' ? '__keep' : 'none';
  if (!['none','feishu','last'].includes(delivery)) $('#cronDelivery').insertAdjacentHTML('beforeend', `<option value="${esc(delivery)}">${delivery === '__keep' ? '保留现有推送策略' : esc(delivery)}</option>`);
  $('#cronDelivery').value = delivery;
  for (const [id, value] of Object.entries(values)) $('#' + id).value = value;
  $('#cronEnabled').checked = job?.enabled === true;
  $('#cronEditor').classList.remove('hidden');
  for (const element of $$('#cronEditor input, #cronEditor select, #cronEditor textarea')) {
    element.dataset.savedValue = element.type === 'checkbox' ? String(element.checked) : element.value; element.dataset.dirty = '';
  }
}
function cronEditorDirty() { return $$('#cronEditor input, #cronEditor select, #cronEditor textarea').some(e => e.dataset.dirty === '1'); }
function cronForm() {
  const kind = $('#cronKind').value, value = $('#cronSchedule').value.trim();
  const schedule = kind === 'every' ? { kind, everyMs: Number(value) * 60000 } : kind === 'at' ? { kind, at: value } : { kind, expr: value, tz: $('#cronTimezone').value.trim() };
  const channel = $('#cronDelivery').value;
  return { agentId: $('#cronAgent').value, name: $('#cronName').value.trim(), message: $('#cronMessage').value.trim(), model: $('#cronModel').value,
    schedule, enabled: $('#cronEnabled').checked,
    delivery: channel === 'none' ? { mode: 'none' } : { mode: 'announce', channel, to: $('#cronTo').value.trim(), ...($('#cronAccount').value.trim() ? { accountId: $('#cronAccount').value.trim() } : {}) } };
}
async function saveAutomation() {
  const old = automationState.editing, values = cronForm();
  let body = values;
  if (old) {
    body = { revision: old.managerRevision };
    const groups = {agentId:['cronAgent'],name:['cronName'],message:['cronMessage'],model:['cronModel'],schedule:['cronKind','cronSchedule','cronTimezone'],enabled:['cronEnabled'],delivery:['cronDelivery','cronTo','cronAccount']};
    for (const [key, ids] of Object.entries(groups)) {
      if (ids.some(id => { const e = $('#' + id); return (e.type === 'checkbox' ? String(e.checked) : e.value) !== e.dataset.savedValue; })) body[key] = values[key];
    }
  }
  $('#cronHint').textContent = '保存任务中…';
  try {
    await api(`/api/instances/${state.selectedId}/automations${old ? '/' + encodeURIComponent(old.id) : ''}`, { method: old ? 'PUT' : 'POST', body: JSON.stringify(body) });
    $('#cronEditor').classList.add('hidden');
    for (const e of $$('#cronEditor [data-dirty]')) e.dataset.dirty = '';
    await loadAutomations(); $('#cronHint').textContent = '任务已保存。';
  } catch (error) { featureFailure(error, '#cronHint'); }
}
async function automationAction(action, id) {
  const job = automationState.jobs.find(row => row.id === id); if (!job) return;
  if (action === 'edit') { openCronEditor(job); return; }
  if (action === 'delete' && !confirm(`删除定时任务「${job.name}」？`)) return;
  if (action === 'run' && !confirm(`立即运行「${job.name}」？${job.delivery?.mode === 'announce' ? '执行结果将按设置推送。' : ''}`)) return;
  $('#cronHint').textContent = '处理中…';
  try {
    const base = `/api/instances/${state.selectedId}/automations/${encodeURIComponent(id)}`;
    if (action === 'runs') {
      const data = await api(base + '/runs');
      const rows = data.entries || data.runs || [];
      $('#cronRuns').innerHTML = `<h4>${esc(job.name)} · 最近执行记录</h4>` + (rows.length ? rows.map(r => `<div class="feature-run"><b>${esc(cronTime(r.runAtMs || r.ts))} · ${esc(r.completionStatus || r.status || '未知')}</b><p>${esc(r.summary || r.error || '无摘要')}</p><div class="reco-note">耗时 ${r.durationMs ?? '—'} ms · 推送 ${esc(r.deliveryStatus || '—')}</div></div>`).join('') : '<p>暂无执行记录。任务启动后可点击此按钮刷新。</p>');
      $('#cronRuns').classList.remove('hidden'); $('#cronHint').textContent = ''; return;
    }
    let data;
    if (action === 'toggle') data = await api(base, { method: 'PUT', body: JSON.stringify({ enabled: !job.enabled, revision: job.managerRevision }) });
    if (action === 'delete') data = await api(base, { method: 'DELETE', body: '{}' });
    if (action === 'run') data = await api(base + '/run', { method: 'POST', body: '{}' });
    await loadAutomations();
    $('#cronHint').textContent = action === 'run' ? `运行请求已提交${data?.result?.runId ? ' · ' + data.result.runId : ''}，请查看执行记录确认结果。` : '操作完成。';
  } catch (error) { featureFailure(error, '#cronHint'); }
}
async function runDiagnostics() {
  const button = $('[data-feature="diagnose"]'); button.disabled = true; $('#diagHint').textContent = '检查中，约需 10–60 秒…';
  try {
    const data = await api(`/api/instances/${state.selectedId}/diagnostics`, { method: 'POST', body: '{}' });
    $('#diagResult').innerHTML = data.checks.map(c => `<div class="diagnostic-row"><b class="diagnostic-${esc(c.status)}">${esc(c.label)} · ${esc({ok:'正常',warning:'需关注',error:'异常',info:'详情'}[c.status] || c.status)}</b>${typeof c.detail === 'string' ? `<p>${esc(c.detail)}</p>` : `<details><summary>展开检查详情</summary><pre>${esc(JSON.stringify(c.detail, null, 2))}</pre></details>`}</div>`).join('');
    $('#diagHint').textContent = `完成于 ${new Date(data.checkedAt).toLocaleString('zh-CN')} · 只读检查，未修改配置`;
  } catch (error) { featureFailure(error, '#diagHint'); }
  finally { if (button.isConnected) button.disabled = false; }
}
function renderChatAttachments() {
  const box = $('#chatAttachments'); if (!box) return;
  const files = chatAttachments.get(state.selectedId) || [];
  box.innerHTML = files.map((f, index) => `<div class="chat-file">${f.mimeType.startsWith('image/') ? `<img alt="${esc(f.fileName)}" src="data:${esc(f.mimeType)};base64,${f.content}">` : ''}<span>${esc(f.fileName)} · ${fmtBytes(f.sizeBytes)}</span><button class="btn small" data-chat-remove="${index}" aria-label="移除附件 ${esc(f.fileName)}">移除</button></div>`).join('');
}
async function selectChatFiles(input) {
  const id = state.selectedId;
  chatFileReading.add(id); syncChatControls();
  const selected = [...input.files]; input.value = '';
  const previous = chatAttachments.get(id) || [];
  try {
    if (selected.length + previous.length > 4) throw new Error('最多选择 4 个附件');
    const added = [];
    for (const file of selected) {
      if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('单个文件需为 1 字节到 10MB');
      const ext = file.name.split('.').pop().toLowerCase();
      const types = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',pdf:'application/pdf',txt:'text/plain',md:'text/markdown',csv:'text/csv',json:'application/json',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
      if (!types[ext]) throw new Error('不支持该附件格式：' + file.name);
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('读取文件失败')); reader.readAsDataURL(file); });
      added.push({ fileName: file.name, mimeType: types[ext], sizeBytes: file.size, content: String(data).split(',')[1] });
    }
    if ([...previous, ...added].reduce((n, f) => n + f.sizeBytes, 0) > 20 * 1024 * 1024) throw new Error('附件总计不能超过 20MB');
    chatAttachments.set(id, [...previous, ...added]);
    if (state.selectedId === id) { renderChatAttachments(); $('#chatStatus').textContent = ''; }
  } catch (error) { if (state.selectedId === id) $('#chatStatus').textContent = error.message; }
  finally { chatFileReading.delete(id); if (state.selectedId === id) syncChatControls(); }
}
function chatMessageText(message) {
  if (typeof message === 'string') return message;
  if (typeof message?.content === 'string') return message.content;
  return (message?.content || []).filter(p => p.type === 'text').map(p => p.text || '').join('\n');
}
function syncChatControls() {
  if (!$('#chatSend')) return;
  const busy = chatBusy.has(state.selectedId);
  $('#chatSend').disabled = busy || chatFileReading.has(state.selectedId); $('#chatStop').disabled = !busy; $('#chatFiles').disabled = busy || chatFileReading.has(state.selectedId);
  if ($('#chatAgent')) $('#chatAgent').disabled = busy;
}
async function sendEnhancedChat() {
  const id = state.selectedId; if (!id || chatBusy.has(id) || chatFileReading.has(id)) return;
  const message = $('#chatInput').value.trim(), files = chatAttachments.get(id) || [];
  if (!message && !files.length) return;
  const history = chatStateFor(id), pending = { role: 'assistant', text: '正在准备…', pending: true };
  history.push({ role: 'user', text: message + (files.length ? '\n附件：' + files.map(f => f.fileName).join('、') : '') }, pending);
  $('#chatInput').value = ''; chatAttachments.set(id, []); renderChatAttachments();
  chatBusy.add(id); syncChatControls(); renderChatLog(history);
  let terminal = false;
  const repaint = () => { if (state.selectedId === id && $('#chatLog')) renderChatLog(history); };
  try {
    await ensureSession();
    const response = await fetch(`/api/instances/${id}/chat/stream`, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ message, attachments: files, agentId: selectedChatAgents.get(id) || $('#chatAgent')?.value || 'main' }) });
    if (!response.ok) throw new Error((await response.json()).error || '对话请求失败');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', accumulated = '';
    while (true) {
      const { done, value } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.kind === 'error') throw new Error(event.error);
        if (event.kind === 'accepted') pending.text = '模型处理中…';
        if (event.kind === 'chat') {
          const data = event.data;
          if (data.state === 'error') throw new Error(data.errorMessage || data.error?.message || '模型执行失败');
          if (data.state === 'delta') {
            accumulated = chatMessageText(data.message) || (data.replace ? data.deltaText || '' : accumulated + (data.deltaText || ''));
            pending.text = accumulated || '模型处理中…';
          }
          if (data.state === 'status' && !accumulated) pending.text = ({preparing_workspace:'正在准备工作区…',preparing_context:'正在准备上下文…',starting_model:'正在请求模型…'}[data.phase] || '模型处理中…');
          if (data.state === 'final' || data.state === 'aborted') {
            terminal = true; pending.text = chatMessageText(data.message) || accumulated || (data.state === 'aborted' ? '已停止生成。' : '本次没有文本回复，请查看会话中的工具执行结果。');
          }
        }
        repaint();
      }
      if (done) break;
    }
    if (!terminal) throw new Error('连接已结束，请到会话页核对执行结果后重试');
  } catch (error) {
    pending.text = '出错了：' + error.message;
    if (files.length && !(chatAttachments.get(id) || []).length) chatAttachments.set(id, files);
  } finally {
    pending.pending = false; chatBusy.delete(id); repaint();
    if (state.selectedId === id) { syncChatControls(); renderChatAttachments(); }
  }
}
document.addEventListener('input', event => {
  if (event.target.id === 'wsEditor') { event.target.dataset.dirty = event.target.value === event.target.dataset.savedValue ? '' : '1'; $('#wsDiff')?.classList.add('hidden'); }
  if (event.target.closest('#cronEditor')) event.target.dataset.dirty = '1';
});
document.addEventListener('change', async event => {
  if (event.target.closest('#cronEditor')) event.target.dataset.dirty = '1';
  if (event.target.id === 'chatFiles') await selectChatFiles(event.target);
  if (event.target.id === 'wsPath') {
    if (workspaceDirty() && !confirm('放弃当前文件未保存的修改？')) { event.target.value = workspaceState.path; return; }
    await loadWorkspace(event.target.value);
  }
  if (event.target.id === 'cronKind') $('#cronScheduleHelp').textContent = ({cron:'Cron 示例：0 9 * * * 表示所选时区每天 09:00。',every:'填写间隔分钟数，至少 1 分钟。',at:'填写带时区的未来时间，例如 2026-10-16T09:00:00+08:00。'}[event.target.value]);
});
document.addEventListener('click', async event => {
  const remove = event.target.closest('[data-chat-remove]');
  if (remove) { const files = chatAttachments.get(state.selectedId) || []; files.splice(Number(remove.dataset.chatRemove), 1); renderChatAttachments(); return; }
  const cron = event.target.closest('[data-cron]'); if (cron) { await automationAction(cron.dataset.cron, cron.dataset.job); return; }
  const button = event.target.closest('[data-feature]'); if (!button) return;
  try {
    switch (button.dataset.feature) {
      case 'wsReload': if (!workspaceDirty() || confirm('放弃未保存的修改并重新加载？')) await loadWorkspace(); break;
      case 'wsNew': if (!workspaceDirty() || confirm('放弃当前文件未保存的修改？')) await loadWorkspace($('#wsNewPath').value.trim()); break;
      case 'wsPreview': reviewWorkspace($('#wsEditor').value, '确认以下修改后保存。'); break;
      case 'wsVersion': { const value = $('#wsHistory').value; if (!value || !workspaceState) break;
        const row = await api(`/api/instances/${state.selectedId}/workspace/version?path=${encodeURIComponent(workspaceState.path)}&version=${encodeURIComponent(value)}`);
        reviewWorkspace(row.content, `恢复历史版本：${new Date(row.savedAt).toLocaleString('zh-CN')}`, value); break; }
      case 'wsCommit': await saveWorkspace(); break;
      case 'wsCancel': $('#wsDiff').classList.add('hidden'); break;
      case 'cronNew': openCronEditor(); break;
      case 'cronReload': await loadAutomations(); break;
      case 'cronPrev': await loadAutomations(Math.max(0, automationState.offset - 100)); break;
      case 'cronNext': if (automationState.hasMore) await loadAutomations(automationState.offset + 100); break;
      case 'cronSave': await saveAutomation(); break;
      case 'cronCancel': if (!cronEditorDirty() || confirm('放弃未保存的任务修改？')) { $('#cronEditor').classList.add('hidden'); for (const e of $$('#cronEditor [data-dirty]')) e.dataset.dirty = ''; } break;
      case 'diagnose': await runDiagnostics(); break;
      case 'chatStop': button.disabled = true; await api(`/api/instances/${state.selectedId}/chat/abort`, { method: 'POST', body: '{}' }); break;
    }
  } catch (error) { featureFailure(error, button.dataset.feature.startsWith('ws') ? '#wsHint' : button.dataset.feature.startsWith('chat') ? '#chatStatus' : '#cronHint'); }
});
