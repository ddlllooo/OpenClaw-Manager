'use strict';
(() => {
  let context={mode:'local'},poll=null,busy=false,verifiedTarget='',refreshEpoch=0,localImages=[],transferBusy=false,initialConnections=true,deviceRows=[],editingId=null,editingBase=null;
  const button=$('#btnConnections');
  const target=()=>JSON.stringify([$('#sshHost').value.trim(),Number($('#sshPort').value)]);
  function stopPoll(){clearTimeout(poll);poll=null;}
  function modal(){
    if($('#connectionsModal'))return $('#connectionsModal');
    const element=document.createElement('div');element.id='connectionsModal';element.className='modal hidden';
    element.innerHTML=`<div class="modal-card modal-card-lg" role="dialog" aria-modal="true" aria-labelledby="connectionsTitle" aria-describedby="connectionsIntro" tabindex="-1">
      <header class="ssh-modal-header"><div><h3 id="connectionsTitle">部署设备 / SSH 隧道</h3><p id="connectionsIntro">通过 SSH 连接远程设备，使用目标设备的 Docker 和计算资源。</p></div><button type="button" class="btn" id="sshClose">关闭</button></header>
      <div class="ssh-modal-body">
      <details id="sshConnectDetails" open><summary id="sshFormTitle">新建 SSH 设备连接</summary><form id="sshForm">
      <fieldset class="ssh-section"><legend>设备名称与备注</legend>
        <label for="sshName">设备名称（选填）<input id="sshName" maxlength="80" placeholder="例如：生产服务器、办公室 Linux" autocomplete="off"></label>
        <label for="sshNotes">备注（选填）<textarea id="sshNotes" maxlength="1000" rows="2" placeholder="记录用途、位置或维护说明"></textarea></label>
        <p class="ssh-field-note">设备切换与实例归属将显示此名称；留空时使用用户名与主机地址。</p>
        <p class="ssh-field-note hidden" id="sshEditHint">仅修改名称或备注不会断开连接。修改连接信息后，当前已连接的设备会重新连接。认证信息留空可保留；更换主机或 SSH 端口需重新填写认证并核对指纹。</p></fieldset>
      <fieldset class="ssh-section"><legend>1 · 设备与认证</legend><div class="ssh-grid">
        <label for="sshHost">主机地址<input id="sshHost" placeholder="IP 地址或域名" required autocomplete="off" autocapitalize="none" spellcheck="false"></label>
        <label for="sshPort">SSH 端口<input id="sshPort" type="number" min="1" max="65535" value="22" required></label></div>
      <div class="ssh-grid"><label for="sshUser">SSH 用户名<input id="sshUser" placeholder="例如 ubuntu" required autocomplete="username" autocapitalize="none" spellcheck="false"></label>
        <label for="sshAuth">认证方式<select id="sshAuth"><option value="password">密码</option><option value="key">私钥</option><option value="agent">SSH Agent</option></select></label></div>
      <label id="sshPasswordLabel" for="sshPassword">SSH 密码<input id="sshPassword" type="password" autocomplete="current-password" required></label>
      <div id="sshKeyFields" class="hidden"><label for="sshKey">导入私钥<input id="sshKey" type="file" aria-describedby="sshKeyHint"></label><p class="ssh-field-note" id="sshKeyHint">选择 OpenSSH / PEM 格式的私钥文件（最大 64 KB），支持无扩展名文件。</p><label for="sshPassphrase">私钥口令（选填）<input id="sshPassphrase" type="password" autocomplete="off"></label></div>
      <p class="hint hidden" id="sshAgentHint">使用运行 Manager 的本机 SSH Agent，请先在 Agent 中加载目标设备的密钥。</p>
      <label class="ssh-verify"><input type="checkbox" id="sshSave" checked><span>保存设备与认证信息</span></label>
      <label class="ssh-verify"><input type="checkbox" id="sshAutoReconnect" checked><span>启动后自动连接，连接中断后自动重试</span></label>
      <p class="ssh-field-note" id="sshSaveHint">认证信息加密保存在运行平台的设备上，重启后无需重新填写；不会返回到浏览器。</p></fieldset>
      <fieldset class="ssh-section"><legend>2 · 连接方式</legend><div class="ssh-grid">
        <label for="sshDeploy">连接方式<select id="sshDeploy" aria-describedby="sshDeployHint"><option value="deploy">自动部署并连接</option><option value="existing">连接已有 Manager</option><option value="ssh-only">仅建立 SSH（离线传镜像）</option></select></label>
        <label id="sshRemotePortLabel" for="sshRemotePort">远程管理端口<input id="sshRemotePort" type="number" min="1024" max="65535" value="18080" required></label></div>
      <p class="hint" id="sshDeployHint">在目标设备构建并启动 Manager，已有同名管理容器会复用。目标需运行 Linux 容器模式的 Docker，且 SSH 用户具有 Docker 权限。本机无需安装 Docker。</p></fieldset>
      <fieldset class="ssh-section"><legend>3 · 核对主机指纹</legend>
      <p class="hint">先获取指纹，再通过目标设备或管理员提供的可信渠道核对。</p>
      <div class="ssh-fingerprint-row"><button type="button" class="btn" id="sshProbe">获取主机指纹</button><code id="sshFingerprint" aria-label="SHA256 主机指纹">尚未获取主机指纹</code></div>
      <label class="ssh-verify" for="sshVerified"><input type="checkbox" id="sshVerified" disabled><span>已通过可信渠道核对上述 SHA256 主机指纹</span></label>
      <p class="ssh-field-note" id="sshVerifyHint">完成核对并勾选确认后，即可连接设备。</p></fieldset>
      </form></details>
      <section class="ssh-devices" aria-labelledby="sshDevicesTitle"><h4 id="sshDevicesTitle">设备连接</h4><div id="sshConnections"></div></section>
      <details class="ssh-image-transfer" id="sshTransferDetails"><summary id="sshTransferTitle">将本机镜像传到设备 <span class="ssh-optional">离线部署可选</span></summary><div class="ssh-transfer-body">
        <p class="hint">本机需运行 Docker。镜像经 SSH 传输并自动导入，目标设备无需联网。</p>
        <button type="button" class="btn" id="sshReadImages">读取 / 刷新本机镜像</button>
        <div class="ssh-grid"><label for="sshLocalImage">本机镜像<select id="sshLocalImage"><option value="">请先读取本机镜像</option></select></label>
          <label for="sshImageTarget">目标设备<select id="sshImageTarget"><option value="">请先连接 SSH 设备</option></select></label></div>
        <div class="ssh-transfer-actions"><p class="hint" id="sshImageHint" role="status">先读取本机镜像，再选择已连接的目标设备。</p><button type="button" class="btn primary" id="sshTransfer" disabled>传输并导入</button></div>
        <p class="ssh-field-note">支持 OpenClaw 和 Manager 镜像，架构须与目标设备一致。目标上不同内容的同名镜像不会被覆盖。</p>
        <p class="ssh-field-note">完全离线的新设备：选择「仅建立 SSH」→ 传输 Manager 和 OpenClaw 镜像 → 在设备卡片中点击「离线启动 Manager」。</p></div></details>
      </div><footer class="ssh-modal-footer"><p id="sshNotice" role="status" aria-live="polite"></p><div class="ssh-connect-actions"><p id="sshConnectHint" class="ssh-field-note">请先填写设备信息，并获取、核对主机指纹。</p><button type="button" class="btn hidden" id="sshCancelEdit">取消编辑</button><button type="submit" form="sshForm" class="btn primary" id="sshConnect" disabled>连接设备</button></div></footer></div>`;
    document.body.appendChild(element);
    const close=()=>{element.classList.add('hidden');stopPoll();refreshEpoch++;button.focus();};
    $('#sshClose').onclick=close;
    element.onkeydown=event=>{
      if(event.key==='Escape'){event.preventDefault();close();}
      if(event.key==='Tab'){
        const focusable=[...element.querySelectorAll('button,a[href],input,select,textarea,summary,[tabindex="0"]')].filter(node=>!node.disabled&&node.checkVisibility());
        const first=focusable[0],last=focusable[focusable.length-1];
        if(event.shiftKey&&(document.activeElement===first||document.activeElement===element.firstElementChild)){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    $('#sshAuth').onchange=()=>{
      const auth=$('#sshAuth').value;
      const retain=editingBase&&target()===JSON.stringify([editingBase.host,editingBase.port])&&auth===editingBase.auth;
      $('#sshPasswordLabel').classList.toggle('hidden',auth!=='password');$('#sshPassword').required=auth==='password'&&!retain;
      $('#sshKeyFields').classList.toggle('hidden',auth!=='key');$('#sshKey').required=auth==='key'&&!retain;$('#sshKey').disabled=auth!=='key';
      $('#sshPassword').placeholder=retain?'留空保留已保存的密码':'';
      $('#sshKeyHint').textContent=retain?'不选择文件可保留已保存的私钥；选择新文件将替换原密钥。':'选择 OpenSSH / PEM 格式的私钥文件（最大 64 KB），支持无扩展名文件。';
      $('#sshAgentHint').classList.toggle('hidden',auth!=='agent');
    };
    $('#sshSave').onchange=()=>{
      $('#sshAutoReconnect').disabled=!$('#sshSave').checked;
      $('#sshSaveHint').textContent=$('#sshSave').checked?'认证信息加密保存在运行平台的设备上，重启后无需重新填写；不会返回到浏览器。':'仅用于本次连接；平台重启后需要重新填写认证信息。';
    };
    $('#sshDeploy').onchange=()=>{
      const mode=$('#sshDeploy').value,sshOnly=mode==='ssh-only';
      $('#sshRemotePortLabel').classList.toggle('hidden',sshOnly);$('#sshRemotePort').disabled=sshOnly;
      $('#sshDeployHint').textContent=sshOnly?'仅建立 SSH 连接，暂不启动 Manager。连接后可在下方传输镜像，再从设备卡片离线启动 Manager。':mode==='existing'?'连接目标设备上已运行的 Manager。请填写其实际监听端口，本机无需安装 Docker。':'在目标设备构建并启动 Manager，已有同名管理容器会复用。目标需运行 Linux 容器模式的 Docker，且 SSH 用户具有 Docker 权限。本机无需安装 Docker。';
    };
    const syncConnect=()=>{
      const verified=$('#sshVerified').checked&&verifiedTarget===target();
      const retained=editingBase&&target()===JSON.stringify([editingBase.host,editingBase.port])&&$('#sshFingerprint').textContent===editingBase.fingerprint;
      $('#sshConnect').disabled=busy||!(verified||retained);$('#sshCancelEdit').disabled=busy;
      $('#sshConnectHint').textContent=busy?'正在保存，请稍候。':retained?'沿用已核对的主机指纹，认证留空可保留。':verified?'主机指纹已确认，可提交设备信息。':'请先填写设备信息，并获取、核对主机指纹。';
    };
    $('#sshConnect').onclick=()=>{$('#sshConnectDetails').open=true;};
    const resetVerification=()=>{$('#sshVerified').checked=false;$('#sshVerified').disabled=true;verifiedTarget='';$('#sshFingerprint').textContent='尚未获取主机指纹';syncConnect();};
    $('#sshVerified').onchange=syncConnect;
    for(const id of ['sshHost','sshPort'])$('#'+id).oninput=()=>{resetVerification();$('#sshAuth').onchange();$('#sshNotice').textContent='';};
    const resetEditor=()=>{
      editingId=null;editingBase=null;$('#sshDeploy').querySelector('option[value="deploy"]').disabled=false;
      $('#sshForm').reset();$('#sshSave').disabled=false;$('#sshAuth').onchange();$('#sshSave').onchange();$('#sshDeploy').onchange();
      $('#sshFormTitle').textContent='新建 SSH 设备连接';$('#sshEditHint').classList.add('hidden');$('#sshCancelEdit').classList.add('hidden');$('#sshConnect').textContent='连接设备';resetVerification();
    };
    $('#sshCancelEdit').onclick=()=>{resetEditor();$('#sshConnectDetails').open=false;$('#sshNotice').textContent='已取消编辑，设备设置保持原样。';refresh();};
    $('#sshProbe').onclick=async()=>{
      if(busy)return;
      for(const id of ['sshHost','sshPort'])if(!$('#'+id).reportValidity())return;
      busy=true;$('#sshProbe').disabled=true;$('#sshProbe').textContent='正在获取…';$('#sshNotice').textContent='正在获取主机指纹…';
      const expectedTarget=target();resetVerification();
      try{const data=await api('/api/connections/probe',{method:'POST',body:JSON.stringify({host:$('#sshHost').value,port:$('#sshPort').value})});
        if(expectedTarget!==target())throw new Error('主机地址已变化，请重新获取指纹');
        $('#sshFingerprint').textContent=data.fingerprint;verifiedTarget=expectedTarget;$('#sshVerified').disabled=false;$('#sshNotice').textContent='请通过可信渠道核对指纹，确认一致后勾选上方选项。';
      }catch(e){$('#sshNotice').textContent=e.message;}finally{busy=false;$('#sshProbe').disabled=false;$('#sshProbe').textContent='获取主机指纹';syncConnect();}
    };
    $('#sshForm').onsubmit=async event=>{
      event.preventDefault();if(busy)return;
      const retained=editingBase&&target()===JSON.stringify([editingBase.host,editingBase.port])&&$('#sshFingerprint').textContent===editingBase.fingerprint;
      if(!retained&&(!$('#sshVerified').checked||verifiedTarget!==target())){$('#sshNotice').textContent='请先获取并核对当前目标设备的主机指纹。';return;}
      busy=true;syncConnect();$('#sshProbe').disabled=true;$('#sshConnect').textContent='正在连接…';$('#sshNotice').textContent='正在提交设备连接…';
      try{
        const fields={name:$('#sshName').value,notes:$('#sshNotes').value,host:$('#sshHost').value.trim(),port:Number($('#sshPort').value),username:$('#sshUser').value.trim(),remotePort:Number($('#sshRemotePort').value),auth:$('#sshAuth').value,fingerprint:$('#sshFingerprint').textContent,sshOnly:$('#sshDeploy').value==='ssh-only',autoReconnect:$('#sshAutoReconnect').checked};
        let payload=editingId?Object.fromEntries(Object.entries(fields).filter(([key,value])=>value!==(editingBase[key]??(key==='name'||key==='notes'? '':undefined)))):{...fields,deploy:$('#sshDeploy').value==='deploy',save:$('#sshSave').checked};
        for(const [key,id]of [['password','sshPassword'],['passphrase','sshPassphrase']])if($('#'+id).value)payload[key]=$('#'+id).value;
        const keyFile=fields.auth==='key'?$('#sshKey').files[0]:null;
        if(keyFile){
          if(keyFile.size>65536)throw new Error('私钥文件不能超过 64 KB，请重新选择。');
          let privateKey;
          try{privateKey=await keyFile.text();}catch{throw new Error('无法读取私钥文件，请重新选择。');}
          if(!privateKey.trim())throw new Error('私钥文件为空，请重新选择。');
          payload.privateKey=privateKey;
        }
        if(editingId&&target()!==JSON.stringify([editingBase.host,editingBase.port]))payload.fingerprint=fields.fingerprint;
        const wasEditing=!!editingId,sshOnly=fields.sshOnly;
        if(!wasEditing||Object.keys(payload).length)await api('/api/connections'+(editingId?'/'+editingId:''),{method:editingId?'PATCH':'POST',body:JSON.stringify(payload)});
        resetEditor();$('#sshNotice').textContent=wasEditing?'设备设置已保存。名称与备注已同步到设备切换和实例归属。':'连接任务已开始，进度见下方。';await refresh();await window.deviceWorkspace?.refresh();
        $('#sshConnectDetails').open=false;
        if(!wasEditing&&sshOnly)$('#sshTransferDetails').open=true;
        $('#sshDevicesTitle').scrollIntoView({block:'nearest'});
      }catch(e){$('#sshNotice').textContent=e.message;}finally{busy=false;syncConnect();$('#sshProbe').disabled=false;$('#sshConnect').textContent=editingId?'保存更改':'连接设备';}
    };
    $('#sshConnections').onclick=async event=>{
      const switcher=event.target.closest('[data-device-select]');
      if(switcher){await window.deviceWorkspace?.refresh();window.deviceWorkspace?.selectDevice(switcher.dataset.deviceSelect);return;}
      const action=event.target.closest('[data-ssh-disconnect],[data-transfer-cancel],[data-offline-deploy],[data-ssh-reconnect],[data-ssh-auto],[data-ssh-forget],[data-ssh-edit]');if(!action)return;
      const id=action.dataset.sshDisconnect||action.dataset.transferCancel||action.dataset.offlineDeploy||action.dataset.sshReconnect||action.dataset.sshAuto||action.dataset.sshForget||action.dataset.sshEdit;
      const row=deviceRows.find(r=>r.id===id);if(!row)return;
      if(action.dataset.sshEdit){
        editingId=row.id;editingBase={...row};
        stopPoll();$('#sshConnectDetails').open=true;
        for(const [field,value]of Object.entries({sshName:row.name||'',sshNotes:row.notes||'',sshHost:row.host,sshPort:row.port,sshUser:row.username,sshRemotePort:row.remotePort,sshAuth:row.auth,sshDeploy:row.sshOnly?'ssh-only':'existing'}))$('#'+field).value=value;
        $('#sshPassword').value='';$('#sshKey').value='';$('#sshPassphrase').value='';$('#sshAuth').onchange();$('#sshDeploy').onchange();
        $('#sshSave').checked=true;$('#sshSave').disabled=true;$('#sshSave').onchange();$('#sshAutoReconnect').checked=row.autoReconnect;
        $('#sshDeploy').querySelector('option[value="deploy"]').disabled=true;
        $('#sshFormTitle').textContent='编辑已保存设备';$('#sshEditHint').classList.remove('hidden');$('#sshCancelEdit').classList.remove('hidden');$('#sshConnect').textContent='保存更改';
        $('#sshFingerprint').textContent=row.fingerprint;verifiedTarget=target();$('#sshVerified').disabled=false;$('#sshVerified').checked=false;syncConnect();
        $('#sshNotice').textContent='正在编辑 '+(row.name||row.username+'@'+row.host)+'。认证信息留空可保留。';$('#sshName').focus();return;
      }
      if(action.dataset.sshForget&&!action.dataset.confirmed){action.dataset.confirmed='true';action.textContent='确认移除设备';$('#sshNotice').textContent='移除后会断开隧道并删除本平台保存的认证信息，远程实例继续运行。';stopPoll();return;}
      action.disabled=true;
      const route=action.dataset.transferCancel?'/images/cancel':action.dataset.offlineDeploy?'/deploy-offline':action.dataset.sshReconnect?'/reconnect':action.dataset.sshForget?'/saved':'';
      const method=action.dataset.sshAuto?'PATCH':action.dataset.sshForget||action.dataset.sshDisconnect?'DELETE':'POST';
      try{await api('/api/connections/'+id+route,{method,body:JSON.stringify(action.dataset.sshAuto?{autoReconnect:!row.autoReconnect}:{})});$('#sshNotice').textContent=action.dataset.sshForget?'设备与保存的认证信息已移除。':action.dataset.sshDisconnect?'已断开，设备信息保留，自动重连已暂停。':'设备设置已更新。';await refresh();await window.deviceWorkspace?.refresh();}catch(e){$('#sshNotice').textContent=e.message;action.disabled=false;}
    };
    $('#sshReadImages').onclick=async()=>{
      $('#sshReadImages').disabled=true;$('#sshImageHint').textContent='正在读取本机 Docker 镜像…';
      try{
        const result=await api('/api/connections/local-images'),previous=$('#sshLocalImage').value;localImages=result.images;
        $('#sshLocalImage').innerHTML='<option value="">选择镜像…</option>'+localImages.map(row=>`<option value="${esc(row.image)}">${esc(row.image)} · ${esc(row.purpose)} · ${fmtBytes(row.size)}</option>`).join('');
        if(localImages.some(row=>row.image===previous))$('#sshLocalImage').value=previous;
        $('#sshImageHint').textContent=localImages.length?'选择本机镜像和已连接的设备后开始传输。':'本机暂无 OpenClaw / Manager 镜像，请先下载或构建对应镜像。';
      }catch(e){$('#sshImageHint').textContent='无法读取本机镜像：'+e.message+'。传输镜像需要本机 Docker 正常运行。';}
      finally{$('#sshReadImages').disabled=false;updateTransferButton();}
    };
    for(const id of ['sshLocalImage','sshImageTarget'])$('#'+id).onchange=updateTransferButton;
    $('#sshTransfer').onclick=async()=>{
      const image=localImages.find(row=>row.image===$('#sshLocalImage').value),id=$('#sshImageTarget').value;
      if(!image||!id||transferBusy)return;transferBusy=true;updateTransferButton();
      try{await api('/api/connections/'+id+'/images/transfer',{method:'POST',body:JSON.stringify({image:image.image,imageId:image.imageId})});$('#sshImageHint').textContent='传输任务已开始，进度见设备卡片。';await refresh();}
      catch(e){$('#sshImageHint').textContent=e.message;}finally{transferBusy=false;updateTransferButton();}
    };
    return element;
  }
  function updateTransferButton(){
    $('#sshTransfer').disabled=transferBusy||!$('#sshLocalImage').value||!$('#sshImageTarget').value;
  }
  function transferView(job,id){
    if(!job)return '';
    const seconds=Math.max(1,((job.finishedAt||Date.now())-job.startedAt)/1000);
    return `<div class="ssh-transfer-status" role="status"><b>${esc(job.image)}</b><p>${esc(job.stage)}${job.error?' · '+esc(job.error):''}</p>
      <p class="hint">已传输 ${fmtBytes(job.bytesSent)}${job.status==='running'&&job.bytesSent?' · 平均 '+fmtBytes(job.bytesSent/seconds)+'/s':''}${job.architecture?' · '+esc(job.architecture):''}${job.imageId?' · ID '+esc(job.imageId.slice(0,19)):''}</p>
      ${job.status==='running'?`<progress aria-label="镜像传输与导入进行中"></progress><button class="btn small" data-transfer-cancel="${esc(id)}">取消传输</button>`:''}</div>`;
  }
  function deviceCard(row){
    const id=esc(row.id),connected=['connecting','connected','ssh-ready'].includes(row.status);
    const endpoint=`${row.username}@${row.host}:${row.port} · Manager :${row.remotePort}`;
    return `<article class="ssh-device-card"><div class="feature-row"><div><b>${esc(row.name||row.username+'@'+row.host)}</b><p class="hint">${esc(endpoint)}</p>
      ${row.notes?`<p class="ssh-device-note">${esc(row.notes)}</p>`:''}<p class="hint">${esc(row.stage)}${row.error?' · '+esc(row.error):''}</p>
      <p class="hint">${row.saved?'已保存 · '+(row.paused?'自动重连已暂停':row.autoReconnect?'自动重连开启':'自动重连关闭'):'临时连接 · 未保存'}${row.nextRetryAt?' · 下次尝试 '+esc(new Date(row.nextRetryAt).toLocaleTimeString('zh-CN')):''}</p></div>
      <div class="feature-toolbar">${row.url?`<button type="button" class="btn primary small" data-device-select="${id}">切换到此设备</button>`:''}
      ${row.status==='ssh-ready'?`<button type="button" class="btn small" data-offline-deploy="${id}" ${row.transfer?.status==='running'?'disabled':''}>离线启动 Manager</button>`:''}
      ${connected?`<button type="button" class="btn small" data-ssh-disconnect="${id}">断开隧道</button>`:row.saved?`<button type="button" class="btn primary small" data-ssh-reconnect="${id}">重新连接</button>`:''}
      ${row.saved?`<button type="button" class="btn small" data-ssh-edit="${id}">编辑设备</button><button type="button" class="btn small" data-ssh-auto="${id}">${row.autoReconnect?'关闭':'开启'}自动重连</button><button type="button" class="btn small" data-ssh-forget="${id}" ${row.transfer?.status==='running'?'disabled':''}>移除设备</button>`:''}</div></div>${transferView(row.transfer,row.id)}</article>`;
  }
  async function refresh(){
    stopPoll();if(document.hidden||$('#connectionsModal')?.classList.contains('hidden')||(editingId&&!busy))return;
    const epoch=++refreshEpoch;
    try{
      const data=await api('/api/connections');
      if(epoch!==refreshEpoch||document.hidden||$('#connectionsModal')?.classList.contains('hidden'))return;
      deviceRows=data.connections;const selected=$('#sshImageTarget').value;
      const targets=data.connections.filter(row=>['connected','ssh-ready'].includes(row.status));
      if(initialConnections){initialConnections=false;if(data.connections.length&&!$('#sshHost').value)$('#sshConnectDetails').open=false;}
      $('#sshImageTarget').innerHTML='<option value="">选择目标设备…</option>'+targets.map(row=>`<option value="${esc(row.id)}" ${row.transfer?.status==='running'?'disabled':''}>${esc(row.name?row.name+' · ':'')}${esc(row.username)}@${esc(row.host)}:${row.port}</option>`).join('');
      if(targets.some(row=>row.id===selected&&row.transfer?.status!=='running'))$('#sshImageTarget').value=selected;
      updateTransferButton();
      $('#sshConnections').innerHTML=data.connections.map(deviceCard).join('')||'<p class="hint">暂无远程设备连接。</p>';
      if(data.connections.length)poll=setTimeout(refresh,2000);
    }catch(e){$('#sshNotice').textContent=e.message;}
  }
  button.onclick=()=>{if(context.mode==='ssh'){location.href=context.homeUrl;return;}const element=modal();element.classList.remove('hidden');element.firstElementChild.focus();refresh();};
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stopPoll();refreshEpoch++;}else if($('#connectionsModal')&&!$('#connectionsModal').classList.contains('hidden'))refresh();});
  api('/api/connections/context').then(data=>{
    context=data;
    if(data.mode==='ssh'){$('#deploymentLabel').textContent=`SSH · ${data.username}@${data.host} · 使用远程设备资源`;button.textContent='返回本机 / 管理连接';}
  }).catch(()=>{});
})();
