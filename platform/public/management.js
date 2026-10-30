'use strict';
let managementState = {};
let managementRequests = {};
const selectedChatAgents = new Map();
function resetManagement() { managementState = {}; managementRequests = {}; }
const mgBase = () => `/api/instances/${state.selectedId}`;
const mgButton = (action,label,attrs='') => `<button class="btn small" data-management="${action}" ${attrs}>${label}</button>`;
const mgPage = (id,title,body,tab) => `<div class="detail-tabpage ${tab===id?'':'hidden'}" data-tabpage="${id}"><div class="detail-section mg-page"><div class="feature-toolbar"><h3>${title}</h3>${mgButton(id+'Reload','刷新')}</div><div id="${id}Hint" class="save-hint" role="status"></div>${body}</div></div>`;
function managementPages(tab) {
  return mgPage('extensions','技能与插件',`
    <div class="feature-toolbar"><label>技能所属 Agent<select id="extAgent" class="input"><option value="main">main</option></select></label><label>筛选<input id="extFilter" class="input" placeholder="名称或说明"></label></div>
    <h4>技能</h4><div id="extSkills">打开页签后加载。</div>
    <div class="feature-review"><h4>安装 ClawHub 技能</h4><div class="feature-toolbar"><input id="skillQuery" aria-label="搜索技能" class="input" placeholder="技能名称或关键词">${mgButton('skillSearch','搜索')}</div><div id="skillResults"></div><pre id="skillDetail" class="mg-detail hidden"></pre><p class="reco-note">显示技能来源与依赖。启停对实例生效；Agent 的技能白名单仍优先。安装沿用 OpenClaw 的来源与安全检查。</p></div>
    <h4>插件</h4><div id="isolatedPlugins"></div><p class="reco-note">独立工具插件只接收获准工具的参数，不挂载实例数据或模型密钥。原生插件与网关共享进程；新增原生插件需要管理员信任名单。</p><div id="extPlugins"></div><div class="feature-review"><label>管理员信任的原生 npm 插件<input id="pluginSpec" class="input" placeholder="@openclaw/feishu@2026.9.3"></label>${mgButton('pluginInstall','检查安装来源')}<div id="pluginReview" class="hidden"><pre id="pluginReviewDetail" class="mg-detail"></pre><label>输入本次审查的完整包名和版本<input id="pluginConfirmSpec" class="input" autocomplete="off"></label>${mgButton('pluginConfirm','核对后继续')}</div><p class="reco-note">安装前检查公共 npm 来源、固定版本和 SHA-512，再审查运行时提取的权限。策略警告不会自动接受。内置插件可停用。</p></div>`,tab)
    + mgPage('failover','模型故障切换',`<p class="reco-note">OpenClaw 在鉴权、限流或服务不可用等可切换错误发生时，按备用顺序继续尝试。模型输出质量问题不会自动触发切换。</p>
      <div id="failoverEditor"></div><div class="feature-toolbar">${mgButton('failoverSave','保存模型策略')}</div><div id="failoverPreview" class="reco-note"></div>`,tab)
    + mgPage('access','飞书访问设置',`<label>规则范围<select id="accessAccount" class="input"><option value="">全局 / 默认账号</option></select></label><p id="accessScope" class="reco-note"></p>
      <div id="accessEditor" class="feature-form"></div><div class="feature-toolbar">${mgButton('accessSave','保存访问规则')}${mgButton('accessInherit','恢复继承 / 默认规则')}</div><p class="reco-note">白名单每行一个 ID。用户 ID 通常以 ou_ 开头，群 ID 通常以 oc_ 开头。单独群聊的设置优先于全局规则。</p>
      <div class="feature-review"><h4>单独群聊规则</h4><div id="accessGroups"></div><div class="feature-form"><label>群 ID<input id="accessGroupId" class="input" placeholder="oc_xxx"></label><label>群聊启用<select id="accessGroupEnabled" class="input"><option value="">继承</option><option value="true">启用</option><option value="false">停用</option></select></label><label>需要 @ 机器人<select id="accessGroupMention" class="input"><option value="">继承</option><option value="true">需要</option><option value="false">不需要</option></select></label></div>${mgButton('accessGroupSave','保存此群规则')}</div>
      <div class="feature-review"><h4>待批准的私聊配对</h4>${mgButton('pairingReload','读取待配对请求')}<div id="pairingList"></div><p class="reco-note">批准将允许该用户私聊机器人；平台不会额外发送通知。</p></div>`,tab)
    + mgPage('agents','多 Agent 管理',`<p class="reco-note">每个 Agent 使用独立工作区和会话。可选择独立模型，通过飞书账号、用户或群聊路由消息。</p>
      <div id="agentsList">打开页签后加载。</div>${mgButton('agentNew','新增 Agent')}
      <div id="agentEditor" class="feature-review hidden"><h4 id="agentEditorTitle"></h4><div class="feature-form"><label>Agent ID<input class="input" id="agentId" placeholder="reviewer"></label><label>显示名称<input class="input" id="agentName"></label><label>模型<select class="input" id="agentModel"></select></label></div><div class="feature-toolbar">${mgButton('agentSave','保存 Agent')}${mgButton('agentCancel','取消')}</div></div>
      <div id="agentFiles" class="feature-review hidden"><h4 id="agentFileTitle"></h4><label>角色规则文件<select class="input" id="agentFileName"><option>AGENTS.md</option><option>SOUL.md</option><option>IDENTITY.md</option><option>USER.md</option><option>MEMORY.md</option><option>HEARTBEAT.md</option><option>TOOLS.md</option><option>BOOT.md</option></select></label><textarea id="agentFileContent" aria-label="Agent 文件内容" class="feature-editor" spellcheck="false"></textarea>${mgButton('agentFileSave','保存文件')}${mgButton('agentFileClose','关闭文件')}</div>
      <h4>飞书消息路由</h4><div id="agentBindings"></div><div class="feature-form"><label>目标 Agent<select id="bindingAgent" class="input"></select></label><label>飞书账号<input id="bindingAccount" class="input" placeholder="* 表示任意账号"></label><label>消息来源<select id="bindingKind" class="input"><option value="">账号全部消息</option><option value="direct">指定用户私聊</option><option value="group">指定群聊</option></select></label><label>用户 / 群 ID<input id="bindingPeer" class="input" placeholder="ou_xxx 或 oc_xxx"></label></div>${mgButton('bindingAdd','添加路由')}<p class="reco-note">具体用户、群聊规则优先于账号规则。同类规则按列表顺序匹配；访问白名单仍由飞书访问设置控制。</p>`,tab);
}
function loadManagementTab(tab) { if(['extensions','failover','access','agents'].includes(tab) && !managementState[tab]) managementLoad(tab); }
function mgSaved(scope) { for(const e of $$(scope+' input, '+scope+' select, '+scope+' textarea')) { e.dataset.savedValue=e.type==='checkbox'?String(e.checked):e.value; e.dataset.dirty=''; } }
function mgChanged(e) { return (e.type==='checkbox'?String(e.checked):e.value)!==e.dataset.savedValue; }
function mgOptions(models,value='',empty='继承实例默认模型') {
  const rows=[...models]; if(value&&!rows.some(m=>m.ref===value))rows.push({ref:value,name:value});
  return `<option value="">${empty}</option>`+rows.map(m=>`<option value="${esc(m.ref)}" ${m.ref===value?'selected':''}>${esc(m.name)} · ${esc(m.ref.split('/')[0])}</option>`).join('');
}
async function managementLoad(tab) {
  const requests=managementRequests,sequence=(requests[tab]||0)+1;requests[tab]=sequence;
  const current=()=>{if(requests!==managementRequests||requests[tab]!==sequence)throw new DOMException('较新的页面请求已开始','AbortError');};
  $('#'+tab+'Hint').textContent='读取中…';
  try {
    if(tab==='extensions') {
      const agent=$('#extAgent').value;
      const data=await api(mgBase()+'/extensions?agentId='+encodeURIComponent(agent));current();managementState.extensions=data;
      $('#extAgent').innerHTML=data.agents.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} (${esc(a.id)})</option>`).join('');$('#extAgent').value=data.agentId;renderExtensions();
    }
    if(tab==='failover') {
      const data=await api(mgBase()+'/failover');current();managementState.failover=data;
      $('#failoverEditor').innerHTML=['model','imageModel'].map(key=>`<div class="feature-review"><h4>${key==='model'?'对话模型':'图像分析工具模型'}</h4><label>主模型<select class="input" id="${key}Primary">${mgOptions(data.models.filter(m=>key==='model'||!m.input||m.input.includes('image')),data[key].primary,key==='model'?'请选择主模型':'沿用 OpenClaw 自动选择')}</select></label><input type="hidden" id="${key}Order"><h4>备用模型（按顺序）</h4><div id="${key}Fallbacks"></div><div class="feature-toolbar"><select class="input" id="${key}Candidate">${mgOptions(data.models.filter(m=>key==='model'||!m.input||m.input.includes('image')),'','请选择备用模型')}</select>${mgButton('fallbackAdd','添加备用',`data-key="${key}"`)}</div></div>`).join('');
      managementState.fallbackDraft={model:[...data.model.fallbacks],imageModel:[...data.imageModel.fallbacks]};renderFallbacks();mgSaved('#failoverEditor');
    }
    if(tab==='access') {
      const account=$('#accessAccount').value;const data=await api(mgBase()+'/feishu-access?account='+encodeURIComponent(account));current();managementState.access=data;
      $('#accessAccount').innerHTML='<option value="">全局 / 默认账号</option>'+data.accounts.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} (${esc(a.id)})</option>`).join('');$('#accessAccount').value=account;
      $('#accessScope').textContent=account?'修改此账号的覆盖规则；恢复继承后使用全局设置。':'修改全局规则；账号和单独群聊的覆盖项将继续保留。';
      $('#accessEditor').innerHTML=`<label>私聊访问<select class="input" id="accessDm">${[['pairing','配对批准'],['allowlist','仅白名单'],['open','所有用户'],['disabled','关闭私聊']].map(([v,n])=>`<option value="${v}">${n}</option>`).join('')}</select></label><label>群聊访问<select class="input" id="accessGroup">${[['allowlist','仅白名单群'],['open','所有群'],['disabled','关闭群聊']].map(([v,n])=>`<option value="${v}">${n}</option>`).join('')}</select></label><label>私聊用户白名单<textarea class="input" id="accessUsers" rows="4"></textarea></label><label>群白名单<textarea class="input" id="accessGroupIds" rows="4"></textarea></label><label>群内发送者白名单<textarea class="input" id="accessSenders" rows="4" placeholder="留空表示不额外限制群内发送者"></textarea></label><label class="feature-check"><input type="checkbox" id="accessMention"> 群聊需 @ 机器人</label>`;
      if(data.isolated){$('#accessAccount').innerHTML=data.accounts.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} (${esc(a.id)})</option>`).join('');$('#accessAccount').value=data.account;$('#accessScope').textContent='独立飞书：规则在网关外生效，仅允许明确白名单或关闭；不恢复原生插件。';for(const select of [$('#accessDm'),$('#accessGroup')])for(const option of [...select.options])if(!['allowlist','disabled'].includes(option.value))option.remove();}
      $('#accessDm').value=data.effective.dmPolicy;$('#accessGroup').value=data.effective.groupPolicy==='allowall'?'open':data.effective.groupPolicy;
      $('#accessUsers').value=data.effective.allowFrom.join('\n');$('#accessGroupIds').value=data.effective.groupAllowFrom.join('\n');$('#accessSenders').value=data.effective.groupSenderAllowFrom.join('\n');$('#accessMention').checked=data.effective.requireMention;
      $('#accessGroups').innerHTML=(data.groups||[]).map(g=>`<div class="feature-row"><span>${esc(g.id)} · ${g.enabled===false?'停用':'启用 / 继承'} · ${g.requireMention===undefined?'提及规则继承':g.requireMention?'需要 @':'无需 @'}</span>${mgButton('accessGroupEdit','编辑',`data-id="${esc(g.id)}"`)}</div>`).join('')||'<p>暂无单独群聊规则。</p>';mgSaved('#accessEditor');
    }
    if(tab==='agents') {
      const data=await api(mgBase()+'/agents');current();managementState.agents=data;
      $('#agentsList').innerHTML=data.agents.map(a=>`<div class="feature-row"><div><b>${esc(a.name||a.id)}</b> <span class="badge">${esc(a.id)}</span><p>${esc(typeof a.modelOverride==='string'?a.modelOverride:a.modelOverride?.primary||'继承实例默认模型')}</p><p class="reco-note">${esc(a.workspace||'OpenClaw 管理的工作区')}</p></div><div class="feature-row-actions">${mgButton('agentEdit','编辑',`data-id="${esc(a.id)}"`)}${mgButton('agentFiles','角色文件',`data-id="${esc(a.id)}"`)}${mgButton('agentChat','对话',`data-id="${esc(a.id)}"`)}${a.id!=='main'&&data.agents.length>1?mgButton('agentDelete','移除',`data-id="${esc(a.id)}"`):''}</div></div>`).join('');
      $('#bindingAgent').innerHTML=data.agents.map(a=>`<option value="${esc(a.id)}">${esc(a.name||a.id)} (${esc(a.id)})</option>`).join('');
      $('#agentBindings').innerHTML=data.bindings.map(b=>`<div class="feature-row"><span>${esc(b.match?.channel||'其他')} / ${esc(b.match?.accountId||'*')} / ${esc(b.match?.peer?.kind||'全部')} ${esc(b.match?.peer?.id||'')} → ${esc(b.agentId)}</span>${mgButton('bindingDelete','删除路由',`data-id="${esc(b.managerId)}"`)}</div>`).join('')||'<p>暂无显式路由。</p>';
    }
    $('#'+tab+'Hint').textContent='';
  } catch(error) { featureFailure(error,'#'+tab+'Hint'); }
}
function renderExtensions() {
  const d=managementState.extensions;if(!d)return;const q=$('#extFilter').value.toLowerCase();const match=r=>(r.name+' '+r.id+' '+r.description).toLowerCase().includes(q);
  $('#extSkills').innerHTML=d.skills.filter(match).map(s=>`<div class="feature-row"><div><b>${esc(s.name)}</b> <span class="badge">${s.disabled?'已停用':s.eligible?'可用':'依赖缺失 / 受策略限制'}</span><p>${esc(s.description)}</p><p class="reco-note">来源 ${esc(s.source||'未知')} ${esc(Object.entries(s.missing||{}).filter(([,v])=>v?.length).map(([k,v])=>k+': '+(Array.isArray(v)?v.join(', '):String(v))).join(' · '))}</p></div>${mgButton('skillToggle',s.disabled?'启用':'停用',`data-id="${esc(s.skillKey||s.name)}" data-enabled="${s.disabled?'true':'false'}"`)}</div>`).join('')||'<p>没有匹配的技能。</p>';
  $('#isolatedPlugins').innerHTML=(d.isolatedPlugins||[]).filter(match).map(p=>`<div class="feature-row"><div><b>${esc(p.id)}</b> <span class="badge">独立容器</span><p>允许工具：${esc(p.tools.join(', '))}；实例文件与模型密钥：不挂载</p><p class="reco-note">网络出口：${esc(p.origins.join(', ')||'默认拒绝')}；由宿主管理员管理。</p></div></div>`).join('');
  $('#isolatedPlugins').innerHTML+=(d.isolatedChannels||[]).map(c=>`<div class="feature-row"><div><b>飞书 ${esc(c.id)}</b> <span class="badge">独立收发容器</span><p>文字适配 · 凭据代理；收发侧不持有 AppSecret、模型密钥或实例目录。</p></div></div>`).join('');
  $('#extPlugins').innerHTML=d.plugins.filter(match).map(p=>`<div class="feature-row"><div><b>${esc(p.name||p.id)}</b> <span class="badge">${esc(p.status||'未知')}</span><p>${esc(p.description||'')}</p><p class="reco-note">${esc(p.id)} · ${esc(p.version||'未知版本')} · ${esc(p.origin||'未知来源')} · ${p.id==='manager-isolated-tools'?'受信任工具桥':'原生执行（共享网关权限）'} ${esc(p.error||'')}</p></div><div class="feature-row-actions">${mgButton('pluginToggle',p.enabled?'停用':'启用',`data-id="${esc(p.id)}" data-enabled="${p.enabled?'false':'true'}"`)}${p.origin!=='bundled'?mgButton('pluginUninstall','卸载',`data-id="${esc(p.id)}"`):''}</div></div>`).join('')||'<p>没有匹配的插件。</p>';
}
function renderFallbacks() {
  for(const key of ['model','imageModel']) {const e=$('#'+key+'Order');e.value=JSON.stringify(managementState.fallbackDraft[key]);if(e.dataset.savedValue!==undefined)e.dataset.dirty=mgChanged(e)?'1':'';}
  for(const key of ['model','imageModel'])$('#'+key+'Fallbacks').innerHTML=managementState.fallbackDraft[key].map((ref,index)=>`<div class="feature-row"><span>${index+1}. ${esc(ref)}</span><div>${mgButton('fallbackUp','上移',`data-key="${key}" data-index="${index}"`)}${mgButton('fallbackDown','下移',`data-key="${key}" data-index="${index}"`)}${mgButton('fallbackRemove','移除',`data-key="${key}" data-index="${index}"`)}</div></div>`).join('')||'<p class="reco-note">未设置备用模型。</p>';
}
function showAgentEditor(id) {
  const d=managementState.agents,a=d.agents.find(a=>a.id===id);managementState.agentEditing=a||null;
  $('#agentEditorTitle').textContent=a?'编辑 Agent':'新增 Agent';$('#agentId').value=a?.id||'';$('#agentId').disabled=!!a;$('#agentName').value=a?.name||'';
  const ref=typeof a?.modelOverride==='string'?a.modelOverride:a?.modelOverride?.primary||'';
  $('#agentModel').innerHTML=mgOptions(d.models,ref);$('#agentEditor').classList.remove('hidden');mgSaved('#agentEditor');
}
async function loadAgentFile(id=managementState.agentFile?.agentId) {
  const name=$('#agentFileName').value;const data=await api(mgBase()+`/agents/${encodeURIComponent(id)}/file?name=${encodeURIComponent(name)}`);
  managementState.agentFile={agentId:id,name,revision:data.revision};$('#agentFileTitle').textContent=`${id} · ${name}`;$('#agentFileContent').value=data.file?.content||'';$('#agentFiles').classList.remove('hidden');mgSaved('#agentFiles');
}
async function loadChatAgents() {
  $('#chatSend').disabled=true;
  try {
    const id=state.selectedId,d=await api(mgBase()+'/agents');if(!$('#chatAgent'))return;
    const selected=selectedChatAgents.get(id);const next=d.agents.some(a=>a.id===selected)?selected:d.agents.some(a=>a.id==='main')?'main':d.agents[0]?.id;
    managementState.chatAgents=d;selectedChatAgents.set(id,next);$('#chatAgent').innerHTML=d.agents.map(a=>`<option value="${esc(a.id)}">${esc(a.name||a.id)} (${esc(a.id)})</option>`).join('');$('#chatAgent').value=next;renderChatLog();renderChatAgentModel();syncChatControls();
  } catch(error) { featureFailure(error,'#chatStatus'); }
}
function renderChatAgentModel() {
  const data=managementState.chatAgents,a=data?.agents.find(a=>a.id===selectedChatAgents.get(state.selectedId));
  const override=a?.modelOverride;
  $('#chatModel').textContent=(typeof override==='string'?override:override?.primary)||data?.defaultModel||'（继承 OpenClaw 模型设置）';
}
document.addEventListener('input',event=>{
  if(event.target.id==='extFilter')renderExtensions();
  if(event.target.closest('#failoverEditor, #accessEditor, #agentEditor, #agentFiles'))event.target.dataset.dirty='1';
});
document.addEventListener('change',async event=>{
  if(['extAgent','accessAccount'].includes(event.target.id)) {
    if(event.target.id==='accessAccount' && $$('#accessEditor [data-dirty="1"]').some(mgChanged) && !confirm('放弃未保存的访问规则？')){event.target.value=managementState.access.account;return;}
    await managementLoad(event.target.id==='extAgent'?'extensions':'access');
  }
  if(event.target.id==='agentFileName') {
    if(mgChanged($('#agentFileContent'))&&!confirm('放弃当前文件未保存的修改？')){event.target.value=managementState.agentFile.name;return;}
    try{await loadAgentFile();}catch(error){featureFailure(error,'#agentsHint');}
  }
});
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-management]');if(!button)return;
  const action=button.dataset.management,id=button.dataset.id;const tab=button.closest('[data-tabpage]')?.dataset.tabpage;
  const hint=$('#'+tab+'Hint');button.disabled=true;
  try {
    if(action.endsWith('Reload') && ['extensionsReload','failoverReload','accessReload','agentsReload'].includes(action)) {
      if(button.closest('[data-tabpage]').querySelector('[data-dirty="1"]')&&!confirm('重新加载会放弃未保存的修改，是否继续？'))return;
      await managementLoad(tab);return;
    }
    let result,refresh=false;
    if(action==='skillToggle'||action==='pluginToggle') {
      const d=managementState.extensions,enabled=button.dataset.enabled==='true';
      if(!confirm(`${enabled?'启用':'停用'}${action==='skillToggle'?'技能':'插件'}「${id}」？${action==='skillToggle'?'此状态对实例生效。':'插件完整生效需要重启实例。'}`))return;
      result=await api(mgBase()+'/extensions/'+(action==='skillToggle'?'skill':'plugin'),{method:'PUT',body:JSON.stringify({revision:d.revision,agentId:d.agentId,skillKey:id,pluginId:id,enabled})});refresh=true;
    }
    if(action==='skillSearch') {
      hint.textContent='搜索技能中…';const d=await api(mgBase()+'/extensions/skill/search?q='+encodeURIComponent($('#skillQuery').value));
      const rows=d.results||d.items||[];managementState.skillSearch=rows;
      $('#skillResults').innerHTML=rows.map((r,i)=>`<div class="feature-row"><div><b>${esc(r.displayName||r.name||r.slug)}</b><p>${esc(r.description||r.summary||'')}</p><p class="reco-note">${esc(r.installRef||r.slug||'')} · ${esc(r.version||r.latestVersion||'最新版本')}</p></div><div>${mgButton('skillDetail','详情',`data-index="${i}"`)}${mgButton('skillInstall','安装',`data-index="${i}"`)}</div></div>`).join('')||'<p>未找到技能。</p>';hint.textContent='';return;
    }
    if(action==='skillDetail'||action==='skillInstall') {
      const row=managementState.skillSearch[Number(button.dataset.index)],slug=row.installRef||row.slug;
      if(action==='skillDetail') { const d=await api(mgBase()+'/extensions/skill/detail?slug='+encodeURIComponent(slug));$('#skillDetail').textContent=JSON.stringify(d,null,2);$('#skillDetail').classList.remove('hidden');return; }
      if(!confirm(`将技能「${slug}」安装到 Agent ${managementState.extensions.agentId} 的工作区？请先核对来源与技能详情。`))return;
      hint.textContent='安装技能中…';result=await api(mgBase()+'/extensions/skill/install',{method:'POST',body:JSON.stringify({revision:managementState.extensions.revision,agentId:managementState.extensions.agentId,slug})});refresh=true;
    }
    if(action==='pluginInstall'||action==='pluginConfirm') {
      const base=mgBase(), revision=managementState.extensions.revision;
      hint.textContent=action==='pluginInstall'?'检查 npm 来源与固定版本…':'验证制品与权限，可能需要数分钟…';
      const review=managementState.pluginReview;
      const body=action==='pluginInstall'?{revision,spec:$('#pluginSpec').value.trim()}:
        {revision,spec:review?.spec,reviewToken:review?.reviewToken,confirmSpec:$('#pluginConfirmSpec').value.trim()};
      // A failed or uncertain dispatch requires a fresh review, never a replay.
      managementState.pluginReview=null;$('#pluginReview').classList.add('hidden');
      result=await api(base+'/extensions/plugin/'+(action==='pluginInstall'?'review':'install'),{method:'POST',body:JSON.stringify(body)});
      if(base!==mgBase())return;
      if(result.reviewRequired) {
        managementState.pluginReview=result;
        $('#pluginReviewDetail').textContent=JSON.stringify(Object.fromEntries(Object.entries(result).filter(([key])=>!['reviewToken','reviewRequired'].includes(key))),null,2);
        $('#pluginConfirmSpec').value='';$('#pluginReview').classList.remove('hidden');
        $('#pluginReview [data-management="pluginConfirm"]').textContent=result.phase==='capabilities'?'批准所示权限并安装':'确认此来源并检查权限';
        hint.textContent='请完整审查下方内容。审查有效期为 5 分钟；取消请刷新或离开此页面。';return;
      }
      refresh=true;
    }
    if(action==='pluginUninstall') {
      if(!confirm(`卸载插件「${id}」？插件文件将被移除，安装或业务配置请先备份。`))return;
      hint.textContent='卸载插件中…';
      result=await api(mgBase()+'/extensions/plugin/uninstall',{method:'POST',body:JSON.stringify({revision:managementState.extensions.revision,pluginId:id})});refresh=true;
    }
    if(action.startsWith('fallback')) {
      const key=button.dataset.key,rows=managementState.fallbackDraft[key],index=Number(button.dataset.index);
      if(action==='fallbackAdd') { const ref=$('#'+key+'Candidate').value;if(!ref||rows.includes(ref))throw Error('请选择未添加的备用模型');rows.push(ref); }
      if(action==='fallbackRemove')rows.splice(index,1);
      if(action==='fallbackUp'&&index>0)[rows[index-1],rows[index]]=[rows[index],rows[index-1]];
      if(action==='fallbackDown'&&index<rows.length-1)[rows[index+1],rows[index]]=[rows[index],rows[index+1]];
      renderFallbacks();$('#'+key+'Primary').dataset.dirty='1';return;
    }
    if(action==='failoverSave') {
      const d=managementState.failover,body={revision:d.revision};
      for(const key of ['model','imageModel']) {const next={primary:$('#'+key+'Primary').value,fallbacks:managementState.fallbackDraft[key]};if(JSON.stringify(next)!==JSON.stringify(d[key]))body[key]=next.primary?next:null;}
      if(!confirm('保存当前主模型与备用模型顺序？'))return;
      result=await api(mgBase()+'/failover',{method:'PUT',body:JSON.stringify(body)});refresh=true;
    }
    if(action==='accessSave'||action==='accessInherit') {
      const d=managementState.access,patch={};const fields={dmPolicy:'accessDm',allowFrom:'accessUsers',groupPolicy:'accessGroup',groupAllowFrom:'accessGroupIds',groupSenderAllowFrom:'accessSenders',requireMention:'accessMention'};
      for(const [key,eid] of Object.entries(fields)) {const e=$('#'+eid);if(action==='accessInherit')patch[key]=null;else if(mgChanged(e))patch[key]=e.type==='checkbox'?e.checked:e.tagName==='TEXTAREA'?e.value.split(/[\s,，]+/).filter(Boolean):e.value;}
      if(!confirm('保存飞书访问规则？规则决定哪些用户和群可以使用机器人。'))return;
      result=await api(mgBase()+'/feishu-access',{method:'PUT',body:JSON.stringify({revision:d.revision,account:d.account,patch})});refresh=true;
    }
    if(action==='accessGroupEdit') {
      const g=managementState.access.groups.find(r=>r.id===id);$('#accessGroupId').value=id;$('#accessGroupEnabled').value=g.enabled===undefined?'':String(g.enabled);$('#accessGroupMention').value=g.requireMention===undefined?'':String(g.requireMention);return;
    }
    if(action==='accessGroupSave') {
      const groupId=$('#accessGroupId').value.trim();const value=e=>e.value===''?null:e.value==='true';
      if(!confirm(`保存群聊 ${groupId} 的启用与提及规则？`))return;
      result=await api(mgBase()+'/feishu-access/group',{method:'PUT',body:JSON.stringify({revision:managementState.access.revision,account:managementState.access.account,groupId,patch:{enabled:value($('#accessGroupEnabled')),requireMention:value($('#accessGroupMention'))}})});refresh=true;
    }
    if(action==='pairingReload') {
      const d=await api(mgBase()+'/feishu-access/pairing?account='+encodeURIComponent(managementState.access.account));
      const rows=d.requests||d.pending||[];managementState.pairings=rows;$('#pairingList').innerHTML=rows.map((r,i)=>`<div class="feature-row"><span>${esc(r.id||r.senderId||'')} · ${esc(r.code)} · ${esc(r.createdAt||'')}</span>${mgButton('pairingApprove','批准',`data-index="${i}"`)}</div>`).join('')||'<p>暂无待配对请求。</p>';return;
    }
    if(action==='pairingApprove') {
      const r=managementState.pairings[Number(button.dataset.index)];if(!confirm(`允许用户 ${r.id||r.senderId||''}（配对码 ${r.code}）访问飞书机器人？`))return;
      result=await api(mgBase()+'/feishu-access/pairing/approve',{method:'POST',body:JSON.stringify({code:r.code,account:managementState.access.account})});$('#pairingList').textContent='已批准，请刷新请求列表。';
    }
    if(action==='agentNew'||action==='agentEdit'){showAgentEditor(id);return;}
    if(action==='agentCancel'){$('#agentEditor').classList.add('hidden');mgSaved('#agentEditor');return;}
    if(action==='agentSave') {
      const d=managementState.agents,a=managementState.agentEditing,body={revision:d.revision};
      if(!a){body.agentId=$('#agentId').value.trim();body.name=$('#agentName').value.trim();body.model=$('#agentModel').value;}
      else {if(mgChanged($('#agentName')))body.name=$('#agentName').value.trim();if(mgChanged($('#agentModel')))body.model=$('#agentModel').value||null;}
      result=await api(mgBase()+'/agents'+(a?'/'+encodeURIComponent(a.id):''),{method:a?'PUT':'POST',body:JSON.stringify(body)});$('#agentEditor').classList.add('hidden');mgSaved('#agentEditor');refresh=true;
    }
    if(action==='agentDelete') {
      if(!confirm(`移除 Agent「${id}」及其消息路由？工作区、凭据和会话数据保留；新消息不再分配给此 Agent。`))return;
      result=await api(mgBase()+'/agents/'+encodeURIComponent(id),{method:'DELETE',body:JSON.stringify({revision:managementState.agents.revision})});refresh=true;
    }
    if(action==='agentChat'){openChatModal(id);return;}
    if(action==='agentFiles'){if($('#agentFileContent').dataset.dirty==='1'&&!confirm('放弃当前文件未保存的修改？'))return;await loadAgentFile(id);return;}
    if(action==='agentFileClose') {if(mgChanged($('#agentFileContent'))&&!confirm('放弃未保存的修改？'))return;$('#agentFiles').classList.add('hidden');mgSaved('#agentFiles');return;}
    if(action==='agentFileSave') {
      if(!confirm('保存当前 Agent 的角色规则文件？'))return;const f=managementState.agentFile;
      result=await api(mgBase()+`/agents/${encodeURIComponent(f.agentId)}/file`,{method:'PUT',body:JSON.stringify({name:f.name,revision:f.revision,content:$('#agentFileContent').value})});await loadAgentFile();
    }
    if(action==='bindingAdd') {
      if(!confirm('添加此飞书消息路由？匹配的消息将交由所选 Agent 处理。'))return;
      result=await api(mgBase()+'/agent-bindings',{method:'POST',body:JSON.stringify({revision:managementState.agents.revision,agentId:$('#bindingAgent').value,accountId:$('#bindingAccount').value.trim()||'*',peerKind:$('#bindingKind').value,peerId:$('#bindingPeer').value.trim()})});refresh=true;
    }
    if(action==='bindingDelete') {
      if(!confirm('删除此消息路由？后续消息将按其余路由规则处理。'))return;
      result=await api(mgBase()+'/agent-bindings/'+encodeURIComponent(id),{method:'DELETE',body:JSON.stringify({revision:managementState.agents.revision})});refresh=true;
    }
    if(refresh)await managementLoad(tab);
    if(result)hint.textContent=result.hint||'操作已完成。';
  } catch(error) { featureFailure(error,'#'+tab+'Hint'); }
  finally {if(button.isConnected)button.disabled=false;}
});
