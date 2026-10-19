'use strict';
(() => {
  if(window.deviceWorkspace)return;
  let context=null,timer=null,loading=false,offline=false,pending=0,leaving=false;
  const drafts=new Map(),originalFetch=window.fetch.bind(window);
  const statuses={connected:'已连接',connecting:'连接中','ssh-ready':'仅 SSH',disconnected:'已断开',error:'连接异常'};
  const escDevice=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function label(device){return `${device.kind==='local'?'本机':'远程'} · ${device.name}`;}
  function address(device){return device.kind==='ssh'?`${device.username}@${device.host}:${device.port} · Manager :${device.remotePort}`:'';}
  function optionLabel(device){return label(device)+(device.customName?`（${address(device)}）`:'');}
  function activeDrafts(){
    for(const [node,value]of drafts)if(!node.isConnected||!node.checkVisibility()||node.value===value)drafts.delete(node);
    return drafts.size>0;
  }
  function setConnectionState(failed){
    offline=failed;
    const notice=document.getElementById('deviceConnectionNotice');
    if(notice){notice.hidden=!failed;notice.textContent='当前设备连接不可用，操作已暂停。可切换到本机，在「管理设备」中重新连接。';}
    const workspace=document.querySelector('.workspace');if(workspace)workspace.inert=failed;
    const select=document.getElementById('deviceSelect');if(select)select.disabled=pending>0||leaving;
    const status=document.getElementById('deviceOperationStatus');if(status)status.textContent=pending?'正在提交当前设备的操作…':'';
    const state=document.getElementById('currentDeviceStatus');if(state){state.textContent=failed?'连接不可用':statuses[context?.device?.status]||'已连接';state.classList.toggle('offline',failed);}
  }
  window.fetch=function(input,options={}){
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    const method=String(options.method||input?.method||'GET').toUpperCase();
    const mutation=url.origin===location.origin&&url.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(method);
    if(!mutation)return originalFetch(input,options);
    if(offline||leaving)return Promise.reject(new Error('设备连接不可用或正在切换，请重新选择设备后操作'));
    pending++;setConnectionState(offline);
    const editedScope=document.activeElement?.closest('form,[role="dialog"],#detailPanel');
    return originalFetch(input,options).then(response=>{
      if(response.ok&&editedScope)for(const node of drafts.keys())if(editedScope.contains(node))drafts.delete(node);
      return response;
    }).finally(()=>{pending--;setConnectionState(offline);});
  };
  function mount(){
    const top=document.querySelector('.topbar');if(!top)return;
    if(!document.getElementById('deviceSwitcher')){
      const switcher=document.createElement('div');switcher.id='deviceSwitcher';switcher.className='device-switcher';
      switcher.innerHTML='<label for="deviceSelect">当前管理设备</label><select id="deviceSelect" aria-label="当前管理设备"><option>正在读取设备…</option></select><span id="deviceOperationStatus" role="status" aria-live="polite"></span>';
      top.insertBefore(switcher,document.getElementById('systemInfo'));
      document.getElementById('deviceSelect').onchange=event=>selectDevice(event.target.value);
      const summary=document.createElement('section');summary.className='device-context-bar';summary.setAttribute('aria-label','当前设备与实例归属');
      summary.innerHTML='<div><span class="device-context-key">当前设备</span><strong id="currentDeviceName">正在读取…</strong><span id="currentDeviceStatus" class="device-state"></span></div><p id="deviceOwnershipHint"></p>';
      top.after(summary);
      const notice=document.createElement('p');notice.id='deviceConnectionNotice';notice.className='device-connection-notice';notice.setAttribute('role','alert');notice.hidden=true;summary.after(notice);
      const main=document.querySelector('.workspace');if(main)main.dataset.deviceWorkspace='true';
    }
  }
  function ownership(){
    if(!context?.device)return;
    const name=label(context.device);
    for(const row of document.querySelectorAll('#instanceList .instance-item')){
      let owner=row.querySelector('.device-instance-owner');
      if(!owner){owner=document.createElement('span');owner.className='device-instance-owner';row.querySelector('.name')?.after(owner);}
      if(owner.textContent!==name)owner.textContent=name;
      owner.title=address(context.device);
    }
    const title=document.querySelector('#detailPanel .detail-title,#detailPanel h2');
    if(title){let owner=title.querySelector('.device-detail-owner');if(!owner){owner=document.createElement('span');owner.className='device-detail-owner';title.append(owner);}if(owner.textContent!==`所属设备：${name}`)owner.textContent=`所属设备：${name}`;}
    const create=document.querySelector('#createModal .form-footnote');if(create){const text=`创建到：${name}。实例的容器、配置和工作区保存在该设备。`;if(create.textContent!==text)create.textContent=text;}
    const images=document.getElementById('btnImages');if(images&&images.textContent.trim()!=='设备镜像')images.textContent='设备镜像';
    const imageTitle=document.querySelector('#imagesModal h3');if(imageTitle&&imageTitle.textContent!==`设备镜像 · ${context.device.name}`)imageTitle.textContent=`设备镜像 · ${context.device.name}`;
    const manage=document.getElementById('btnConnections');if(manage&&manage.textContent!=='管理设备')manage.textContent='管理设备';
    const deployment=document.getElementById('deploymentLabel');if(deployment){const text=context.mode==='ssh'?`SSH · ${context.device.name}${context.device.customName?' · '+context.username+'@'+context.host:''}`:'本机 · 运行 Manager 的设备';if(deployment.textContent!==text)deployment.textContent=text;}
  }
  function render(data){
    context=data;mount();const current=context.device;
    const select=document.getElementById('deviceSelect');if(!select||!current)return;
    const html=context.devices.map(device=>`<option value="${escDevice(device.id)}" ${device.status!=='connected'?'disabled':''}>${escDevice(optionLabel(device))}${device.status!=='connected'?' · '+escDevice(statuses[device.status]||device.status):''}</option>`).join('');
    if(select.dataset.options!==html){select.innerHTML=html;select.dataset.options=html;}select.value=current.id;
    document.getElementById('currentDeviceName').textContent=label(current);
    document.getElementById('currentDeviceName').title=[address(current),current.notes].filter(Boolean).join('\n');
    document.getElementById('currentDeviceStatus').textContent=statuses[current.status]||'已连接';
    document.getElementById('deviceOwnershipHint').textContent=`此页的实例、资源、镜像与所有操作均属于「${current.name}」。`;
    document.title=`${current.name} · OpenClaw 管理`;
    ownership();setConnectionState(current.status!=='connected');
  }
  async function refresh(){
    clearTimeout(timer);if(document.hidden||loading||leaving)return;loading=true;
    try{const data=await api('/api/connections/context');if(data.workspace&&data.device)render(data);}
    catch{if(context)setConnectionState(true);}
    finally{loading=false;if(!document.hidden&&!leaving)timer=setTimeout(refresh,8000);}
  }
  function selectDevice(id){
    const select=document.getElementById('deviceSelect'),device=context?.devices.find(d=>d.id===id);
    if(!device||device.id===context.device.id)return;
    if(pending||device.status!=='connected'||!device.url){select.value=context.device.id;return;}
    if(activeDrafts()){select.value=context.device.id;return confirmLeave(()=>navigate(device.url));}
    navigate(device.url);
  }
  function confirmLeave(action){
    if(document.getElementById('deviceLeaveModal'))return;
    const element=document.createElement('div');element.id='deviceLeaveModal';element.className='modal';
    element.innerHTML='<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="deviceLeaveTitle"><h3 id="deviceLeaveTitle">切换管理设备</h3><p class="hint">当前设备有尚未保存的输入。切换后将关闭当前工作区。</p><div class="modal-actions"><button type="button" class="btn" data-device-stay>继续编辑</button><button type="button" class="btn primary" data-device-leave>放弃输入并切换</button></div></div>';
    const cancel=()=>{element.remove();document.getElementById('deviceSelect')?.focus();};
    element.querySelector('[data-device-stay]').onclick=cancel;
    element.querySelector('[data-device-leave]').onclick=()=>{element.remove();drafts.clear();action();};
    element.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();cancel();}if(event.key==='Tab'){const buttons=element.querySelectorAll('button');if(event.shiftKey&&document.activeElement===buttons[0]){event.preventDefault();buttons[1].focus();}else if(!event.shiftKey&&document.activeElement===buttons[1]){event.preventDefault();buttons[0].focus();}}};
    document.body.append(element);element.querySelector('[data-device-stay]').focus();
  }
  function navigate(destination){
    const select=document.getElementById('deviceSelect');
    const url=new URL(destination);
    if(url.protocol!=='http:'||!(/^(?:localhost|127\.0\.0\.1|openclaw-[a-f0-9]+\.localhost)$/.test(url.hostname))){select.value=context.device.id;throw new Error('设备管理地址不合法');}
    leaving=true;setConnectionState(offline);clearTimeout(timer);location.assign(url.href);
  }
  window.deviceWorkspace={selectDevice,refresh,get context(){return context;}};
  document.addEventListener('focusin',event=>{const node=event.target;if(node.matches?.('input:not([type="search"]):not([type="password"]),textarea,select')&&node.id!=='deviceSelect'&&!drafts.has(node))drafts.set(node,node.value);});
  document.addEventListener('click',event=>{
    if(context?.mode==='ssh'&&event.target.closest('#btnConnections')){event.preventDefault();event.stopImmediatePropagation();if(pending)return;const action=()=>navigate(context.homeUrl+'?manageDevices=1');if(activeDrafts())confirmLeave(action);else action();}
  },true);
  document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden)refresh();});
  window.addEventListener('pageshow',event=>{if(event.persisted){leaving=false;refresh();}});
  window.addEventListener('pagehide',()=>{clearTimeout(timer);});
  const observer=new MutationObserver(ownership);for(const id of ['instanceList','detailPanel','createModal','deploymentLabel','btnConnections']){const node=document.getElementById(id);if(node)observer.observe(node,{childList:true,subtree:true});}
  refresh();
  if(new URLSearchParams(location.search).get('manageDevices')==='1'){
    document.getElementById('btnConnections')?.click();history.replaceState(null,'',location.pathname);
  }
})();
