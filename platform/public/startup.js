'use strict';
let startupView=null,startupLoading=false,startupEpoch=0,startupFocus=null;
const startupLabels={pending:'等待恢复检查',checking:'正在检查',ready:'恢复检查正常',attention:'有项目需要处理',disabled:'自动启动与恢复已关闭','environment-error':'运行环境异常','docker-missing':'未检测到 Docker','docker-offline':'Docker 引擎未运行','waiting-login':'等待 macOS 用户登录','waiting-engine':'等待 Docker 引擎就绪'};
const startupStateLabels={running:'运行中',exited:'已停止',stopped:'已停止',created:'已创建',missing:'容器缺失',restarting:'正在重启',paused:'已暂停','not-created':'尚未创建',unknown:'未知'};
function startupMessage(text,state='info'){
  $('#startupHint').textContent=text;$('#startupHint').dataset.state=state;
}
function startupModal(){
  if($('#startupModal'))return $('#startupModal');
  const modal=document.createElement('div');modal.id='startupModal';modal.className='modal hidden';
  modal.innerHTML=`<div class="modal-card startup-card" role="dialog" aria-modal="true" aria-labelledby="startupTitle" aria-describedby="startupIntro" tabindex="-1">
    <header class="startup-header"><div><h3 id="startupTitle">启动与恢复</h3><p id="startupIntro">设置自动启动策略，查看环境与实例的恢复状态。</p></div><button type="button" class="btn" id="startupClose">关闭</button></header>
    <div class="startup-body"><section class="startup-overview" aria-labelledby="startupOverviewTitle"><h4 id="startupOverviewTitle">恢复状态</h4><p id="startupRuntimeNote">读取运行方式…</p><div id="startupStatus" aria-live="polite"></div></section>
    <div id="startupControls"><section class="startup-section" aria-labelledby="startupPolicyTitle"><div class="startup-section-heading"><h4 id="startupPolicyTitle">全局启动策略</h4><span>保存后生效</span></div>
    <label class="startup-option" for="startupManager"><input type="checkbox" id="startupManager"><span><b>Manager 自动启动</b><small>容器引擎就绪后自动启动 Manager，异常退出后恢复。关闭此选项不会退出当前服务。</small><small class="startup-unavailable hidden" id="startupManagerReason">当前运行方式需通过系统服务配置 Manager 自启。</small></span></label>
    <label class="startup-option" for="startupDocker"><input type="checkbox" id="startupDocker"><span><b>自动启动 Docker 引擎</b><small>引擎未运行时，按设备配置拉起并等待就绪。关闭此选项不会停止当前 Docker。</small><small class="startup-unavailable hidden" id="startupDockerReason">当前运行方式需在目标设备的系统服务中配置 Docker 自启。</small></span></label>
    <label class="startup-option" for="startupInstances"><input type="checkbox" id="startupInstances"><span><b>允许实例自动恢复</b><small>开启后，下方允许自启的实例随 Docker 恢复；关闭后取消自动恢复策略，运行中的实例继续运行。</small></span></label></section>
    <section class="startup-section" aria-labelledby="startupInstancesTitle"><div class="startup-section-heading"><h4 id="startupInstancesTitle">各实例自启</h4><span id="startupInstanceCount"></span></div><p class="startup-note" id="startupInstancesNote">选择允许随 Docker 恢复的实例。</p><div id="startupInstanceSettings"></div>
    <p class="startup-note startup-stop-note">手动停止的实例保持停止。恢复检查不会强制启动、重建或重启实例。</p></section></div></div>
    <footer class="startup-footer"><p id="startupHint" role="status" aria-live="polite"></p><div class="startup-footer-actions"><p id="startupChangeNote">读取设置中…</p><div class="startup-buttons"><button type="button" class="btn" id="startupReload">刷新状态</button><button type="button" class="btn" id="startupCheck">检查恢复</button><button type="button" class="btn primary" id="startupSave" disabled>保存设置</button></div></div></footer></div>`;
  document.body.appendChild(modal);
  const close=()=>{
    if(startupLoading)return;
    if(startupDirty()){startupMessage('有未保存的修改，请保存设置，或点击“放弃修改”后关闭。','warning');return;}
    modal.classList.add('hidden');$('#btnStartup').focus();
  };
  $('#startupClose').onclick=close;
  $('#startupReload').onclick=()=>startupLoad();$('#startupSave').onclick=()=>startupSave();$('#startupCheck').onclick=()=>startupLoad('check');
  modal.addEventListener('input',event=>{if(event.target.matches('#startupControls input')){startupMessage('');startupSync();}});
  modal.onkeydown=event=>{
    if(event.key==='Escape'){event.preventDefault();close();}
    if(event.key==='Tab'){
      const nodes=[...modal.querySelectorAll('button,input,summary')].filter(node=>!node.disabled&&node.checkVisibility()),first=nodes[0],last=nodes[nodes.length-1];
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===modal.firstElementChild)){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  };
  return modal;
}
function startupDirty(){return Boolean(startupView)&&$$('#startupControls input').some(input=>String(input.checked)!==input.dataset.savedValue);}
function startupSync(){
  const dirty=startupDirty(),count=$$('#startupControls input').filter(input=>String(input.checked)!==input.dataset.savedValue).length;
  $('#startupSave').disabled=startupLoading||!startupView||!dirty;
  $('#startupCheck').disabled=startupLoading||!startupView||dirty;
  $('#startupCheck').title=dirty?'请先保存设置或放弃修改':'重新检查环境与各实例的恢复状态';
  $('#startupReload').disabled=startupLoading;$('#startupClose').disabled=startupLoading;
  $('#startupReload').textContent=dirty?'放弃修改':'刷新状态';
  $('#startupChangeNote').textContent=startupLoading?'正在处理，请稍候…':!startupView?'设置尚未加载':dirty?`${count} 项修改未保存`:'设置已与服务器同步';
  $('#startupChangeNote').classList.toggle('is-dirty',dirty);
  const globalEnabled=$('#startupInstances').checked,rows=$$('#startupInstanceSettings input');
  $('#startupInstanceCount').textContent=rows.length?`${rows.filter(input=>input.checked).length} / ${rows.length} 个已允许`:'';
  $('#startupInstancesNote').textContent=globalEnabled?'已勾选的实例将随 Docker 恢复。':'全局实例恢复已关闭；仍可勾选并保存偏好，开启全局策略后生效。';
  for(const input of rows){
    const badge=input.closest('label').querySelector('.startup-policy-badge');
    badge.textContent=!globalEnabled?'全局已关闭':input.checked?'允许恢复':'不自动恢复';
    badge.classList.toggle('is-enabled',globalEnabled&&input.checked);
  }
}
function startupBusy(busy){
  if(busy)startupFocus=document.activeElement;
  startupLoading=busy;
  for(const input of $$('#startupControls input'))input.disabled=busy||!startupView;
  for(const [key,id] of [['managerAutoStart','startupManager'],['dockerAutoLaunch','startupDocker']]){
    const unavailable=startupView?.capabilities?.[key]===false;
    if(unavailable)$('#'+id).disabled=true;
    $('#'+id+'Reason').classList.toggle('hidden',!unavailable);
  }
  startupSync();
  if(!busy&&document.activeElement===document.body&&!$('#startupModal').classList.contains('hidden')){
    const target=startupFocus?.isConnected&&!startupFocus.disabled?startupFocus:$('#startupModal .modal-card');
    target.focus();
  }
}
function renderStartup(data){
  startupView=data;
  const portable=data.managerRuntime?.endsWith('-portable'),compose=data.managerRuntime==='docker-compose';
  $('#startupRuntimeNote').textContent=portable
    ?(data.managerRuntime==='docker-portable'?'Manager 运行在目标设备的 Docker 容器中。':'Manager 作为本机进程运行。')+'实例通过 Docker 重启策略恢复，环境状态按需检查。'
    :(compose?'Manager 由 Docker Compose 运行，系统服务负责启动与恢复。':'Manager 通过用户启动项运行。')+(data.loginRequired?'Docker Desktop 需在 macOS 用户登录后启动。':'当前容器后端支持登录前启动。')+'后台每 20 秒检查一次。';
  for(const [key,id] of Object.entries({managerAutoStart:'startupManager',dockerAutoLaunch:'startupDocker',instancesAutoStart:'startupInstances'}))$('#'+id).checked=data.settings[key];
  $('#startupInstanceSettings').innerHTML=data.instances.length?data.instances.map(row=>`<label class="startup-option startup-instance"><input type="checkbox" data-startup-instance="${esc(row.id)}" ${row.enabled?'checked':''}><span><b>${esc(row.name)}</b><small>${esc(row.id)}</small></span><span class="startup-policy-badge"></span></label>`).join(''):'<p class="startup-empty">暂无实例。创建实例后，可在此设置自启策略。</p>';
  for(const input of $$('#startupControls input'))input.dataset.savedValue=String(input.checked);
  const status=data.status||{},env=status.environment||{},phase=status.phase;
  const tone=phase==='ready'?'ready':['attention','environment-error','docker-missing','docker-offline'].includes(phase)?'attention':'pending';
  const checkedAt=status.checkedAt?new Date(status.checkedAt*1000):null;
  const timestamp=checkedAt&&!Number.isNaN(checkedAt.getTime())?checkedAt.toLocaleString('zh-CN',{hour12:false}):'尚未检查';
  const environment=status.environment?[
    ['运行方式',compose?'Docker Compose':'Node.js '+(env.nodeInstalled?'可用':'未检测到')],
    ['Docker 命令',env.dockerCLIInstalled?'可用':'未检测到'],
    [data.dockerBackend==='colima'?'Colima':'Docker Desktop',env.dockerDesktopInstalled?'已安装':'未检测到'],
    ['配置目录',env.dataDirectoryWritable?'可写':'不可写']
  ]:[];
  const rows=status.instances||[];
  $('#startupStatus').innerHTML=`<div class="startup-status-heading"><span class="startup-status-badge ${tone}">${esc(startupLabels[phase]||'尚未执行恢复检查')}</span><span>最近检查：${esc(timestamp)}</span></div>
    <p class="startup-note">${portable?'由 Docker 重启策略管理':data.supervisorInstalled?'后台恢复任务已安装':'后台恢复任务尚未安装'}${data.testMode?' · 隔离测试环境':''}</p>
    ${environment.length?`<dl class="startup-environment">${environment.map(([name,value])=>`<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`:''}
    ${(status.errors||[]).map(error=>`<p class="startup-error">${esc(error)}</p>`).join('')}
    ${rows.length?`<details class="startup-results" ${tone==='attention'?'open':''}><summary>查看 ${rows.length} 个实例的检查结果</summary>${rows.map(row=>`<article class="startup-result"><div><b>${esc(row.name)}</b><span>${esc(startupStateLabels[row.state]||row.state||'未知')}</span></div><p>${esc(row.detail||'等待恢复检查')}${row.restartPolicy?' · '+esc(row.restartPolicy==='unless-stopped'?'随 Docker 恢复（保留手动停止）':row.restartPolicy==='no'?'不自动重启':row.restartPolicy):''}</p></article>`).join('')}</details>`:''}`;
  startupSync();
}
async function startupLoad(action){
  if(startupLoading)return;
  if(action==='check'&&startupDirty()){startupMessage('请先保存设置或放弃修改，再检查恢复状态。','warning');return;}
  const epoch=++startupEpoch;startupBusy(true);startupMessage(action==='check'?'正在检查环境与恢复状态…':'正在读取启动设置…');
  try{
    const data=await api('/api/startup'+(action==='check'?'/check':''),action==='check'?{method:'POST',body:'{}'}:{});
    if(epoch!==startupEpoch)return;
    renderStartup(data);startupMessage(action==='check'?'恢复检查已完成。':'');
  }catch(error){startupMessage('失败：'+error.message,'error');}
  finally{if(epoch===startupEpoch)startupBusy(false);}
}
async function startupSave(){
  if(startupLoading||!startupView||!startupDirty())return;
  const body={revision:startupView.revision,instanceOverrides:{}};
  for(const [key,id] of Object.entries({managerAutoStart:'startupManager',dockerAutoLaunch:'startupDocker',instancesAutoStart:'startupInstances'}))if($('#'+id).checked!==startupView.settings[key])body[key]=$('#'+id).checked;
  for(const input of $$('#startupInstanceSettings input'))if(String(input.checked)!==input.dataset.savedValue)body.instanceOverrides[input.dataset.startupInstance]=input.checked;
  if(!Object.keys(body.instanceOverrides).length)delete body.instanceOverrides;
  startupBusy(true);startupMessage('正在保存启动设置…');
  try{renderStartup(await api('/api/startup',{method:'PUT',body:JSON.stringify(body)}));startupMessage('设置已保存，当前服务继续运行。','success');}
  catch(error){startupMessage('失败：'+error.message,'error');}
  finally{startupBusy(false);}
}
$('#btnStartup').addEventListener('click',()=>{const modal=startupModal();modal.classList.remove('hidden');modal.firstElementChild.focus();startupLoad();});
window.addEventListener('beforeunload',event=>{if($('#startupModal')&&!$('#startupModal').classList.contains('hidden')&&startupDirty()){event.preventDefault();event.returnValue='';}});
