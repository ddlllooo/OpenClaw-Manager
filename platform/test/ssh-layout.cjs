'use strict';
// Opt-in browser regression: PLAYWRIGHT_MODULE may point to a bundled Playwright.
// Uses a disposable loopback server and mocked APIs; never contacts an SSH host.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {once}=require('node:events'),express=require('express');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fingerprint='SHA256:'+'a'.repeat(43),calls=[],errors=[];
let browser,server,probeError=false,holdProbe=null;
const connection={id:'fixture',host:'192.0.2.20',port:22,username:'ubuntu',status:'ssh-ready',stage:'SSH 已连接'};
const image='openclaw/'+ 'very-long-image-name-'.repeat(12)+':offline';
async function checkLayout(page){
  const result=await page.locator('#connectionsModal').evaluate(root=>{
    const nodes=[...root.querySelectorAll('*')].filter(n=>n.checkVisibility());
    return {
      controls:nodes.filter(n=>n.matches('input:not([type=checkbox]),select')).map(n=>({id:n.id,height:n.getBoundingClientRect().height})),
      overflow:nodes.filter(n=>n.clientWidth&&n.scrollWidth>n.clientWidth+1).map(n=>n.id||n.className||n.tagName),
      outside:nodes.filter(n=>{const r=n.getBoundingClientRect(),card=root.firstElementChild.getBoundingClientRect();return r.width&&(r.left<card.left-1||r.right>card.right+1);}).map(n=>n.id||n.tagName),
      pairs:[['sshHost','sshPort'],['sshUser','sshAuth'],['sshDeploy','sshRemotePort'],['sshLocalImage','sshImageTarget']].filter(ids=>ids.every(id=>document.getElementById(id).checkVisibility())).map(ids=>ids.map(id=>document.getElementById(id).getBoundingClientRect().width))
    };
  });
  for(const control of result.controls)assert.equal(control.height,42,control.id);
  for(const [left,right] of result.pairs)assert.ok(Math.abs(left-right)<1,'paired controls have equal widths');
  assert.deepEqual(result.overflow,[],'no horizontal content overflow');
  assert.deepEqual(result.outside,[],'all content stays within dialog borders');
}
async function checkFixedFooter(page){
  const measure=()=>page.locator('#connectionsModal').evaluate(root=>{
    const button=root.querySelector('#sshConnect').getBoundingClientRect(),footer=root.querySelector('.ssh-modal-footer').getBoundingClientRect(),body=root.querySelector('.ssh-modal-body').getBoundingClientRect();
    return {top:button.top,bottom:button.bottom,footerTop:footer.top,bodyBottom:body.bottom,viewport:innerHeight};
  });
  await page.locator('.ssh-modal-body').evaluate(node=>{node.scrollTop=0;});const top=await measure();
  await page.locator('.ssh-modal-body').evaluate(node=>{node.scrollTop=node.scrollHeight;});const bottom=await measure();
  assert.equal(top.top,bottom.top,'connect button stays fixed when content scrolls');
  assert.ok(top.top>=0&&top.bottom<=top.viewport,'connect button is fully visible');
  assert.ok(top.bodyBottom<=top.footerTop+1,'scrolling fields do not overlap the footer');
}
(async()=>{
  try{
    const app=express();app.use(express.static(path.join(__dirname,'../public')));
    server=app.listen(0,'127.0.0.1');await once(server,'listening');
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1100}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/**',async route=>{
      const request=route.request(),url=new URL(request.url());let data={};
      if(url.pathname==='/api/events')return route.fulfill({contentType:'text/event-stream',body:''});
      if(url.pathname==='/api/session')data={csrf:'fixture'};
      if(url.pathname==='/api/instances')data={instances:[],system:{ncpu:8,memTotalGiB:16}};
      if(url.pathname==='/api/instances/kept')data={kept:[]};
      if(url.pathname==='/api/backups/status')data={state:'never',schedule:{enabled:false},retentionDays:7};
      if(url.pathname==='/api/connections/context')data={mode:'local'};
      if(url.pathname==='/api/connections'){
        if(request.method()==='POST'){calls.push(request.postDataJSON());data={id:connection.id};}
        else data={connections:calls.length?[connection]:[]};
      }
      if(url.pathname==='/api/connections/probe'){
        if(holdProbe)await holdProbe;
        if(probeError)return route.fulfill({status:400,json:{error:'无法获取主机指纹，请检查地址'}});
        data={fingerprint};
      }
      if(url.pathname==='/api/connections/local-images')data={images:[{image,imageId:'sha256:fixture',purpose:'OpenClaw',size:1024}]};
      await route.fulfill({json:data});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#btnConnections').click();
    assert.equal(await page.locator('#sshConnect').isDisabled(),true);
    assert.equal(await page.locator('#sshVerified').isDisabled(),true);
    await checkLayout(page);
    // Probing needs host/port only; authentication is validated when connecting.
    await page.locator('#sshHost').fill('192.0.2.20');
    await page.locator('#sshProbe').click();
    await page.waitForFunction(()=>document.querySelector('#sshFingerprint').textContent.startsWith('SHA256:'));
    await page.locator('#sshVerified').check();assert.equal(await page.locator('#sshConnect').isDisabled(),false);
    await page.locator('#sshConnectDetails').evaluate(node=>{node.open=false;});
    await page.locator('#sshConnect').click();assert.equal(calls.length,0,'external button preserves native required-field validation');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'sshUser');
    await page.locator('#sshPort').fill('2222');assert.equal(await page.locator('#sshVerified').isChecked(),false);
    assert.equal(await page.locator('#sshConnect').isDisabled(),true);
    probeError=true;await page.locator('#sshProbe').click();
    await page.waitForFunction(()=>document.querySelector('#sshNotice').textContent.includes('无法获取'));
    assert.equal(await page.locator('#sshVerified').isDisabled(),true);probeError=false;
    let release;holdProbe=new Promise(resolve=>{release=resolve;});
    await page.locator('#sshProbe').click();await page.locator('#sshHost').fill('192.0.2.21');release();holdProbe=null;
    await page.waitForFunction(()=>document.querySelector('#sshNotice').textContent.includes('主机地址已变化'));
    assert.equal(await page.locator('#sshVerified').isDisabled(),true);
    await page.locator('#sshAuth').selectOption('key');
    assert.equal(await page.locator('#sshPassword').isVisible(),false);
    assert.equal(await page.locator('#sshKey').getAttribute('required'),'');
    assert.equal(await page.locator('#sshKey').getAttribute('type'),'file');
    const keyContent='-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----\n';
    await page.locator('#sshKey').setInputFiles({name:'id_ed25519',mimeType:'application/octet-stream',buffer:Buffer.from(keyContent)});
    await checkLayout(page);
    await page.locator('#sshAuth').selectOption('agent');
    assert.equal(await page.locator('#sshAgentHint').isVisible(),true);
    assert.equal(await page.locator('#sshKey').isDisabled(),true);
    await page.locator('#sshAuth').selectOption('key');
    await page.locator('#sshDeploy').selectOption('existing');
    assert.match(await page.locator('#sshDeployHint').textContent(),/实际监听端口/);
    await page.locator('#sshDeploy').selectOption('ssh-only');
    assert.equal(await page.locator('#sshRemotePort').isDisabled(),true);
    await page.locator('#sshUser').fill('ubuntu');await page.locator('#sshProbe').click();
    await page.waitForFunction(()=>!document.querySelector('#sshVerified').disabled);
    await page.locator('#sshVerified').check();
    await page.locator('#sshKey').setInputFiles({name:'empty',mimeType:'application/octet-stream',buffer:Buffer.from('  \n')});
    await page.locator('#sshConnect').click();
    await page.waitForFunction(()=>document.querySelector('#sshNotice').textContent.includes('私钥文件为空'));
    assert.equal(calls.length,0,'empty files are not submitted');
    await page.locator('#sshKey').setInputFiles({name:'large.pem',mimeType:'application/octet-stream',buffer:Buffer.alloc(65537,97)});
    await page.locator('#sshConnect').click();
    await page.waitForFunction(()=>document.querySelector('#sshNotice').textContent.includes('不能超过 64 KB'));
    assert.equal(calls.length,0,'oversized files are not submitted');
    await page.locator('#sshKey').setInputFiles({name:'id_ed25519',mimeType:'application/octet-stream',buffer:Buffer.from(keyContent)});
    await page.locator('#sshPassphrase').fill('fixture-passphrase');
    await page.locator('#sshConnect').click();
    await page.waitForFunction(()=>document.querySelector('#sshNotice').textContent.includes('连接任务已开始'));
    assert.equal(await page.locator('#sshNotice').isVisible(),true);
    assert.equal(await page.locator('#sshConnectDetails').getAttribute('open'),null);
    assert.equal(calls.length,1);assert.equal(calls[0].sshOnly,true);assert.equal(calls[0].auth,'key');
    assert.equal(calls[0].privateKey,keyContent);assert.equal(calls[0].passphrase,'fixture-passphrase');
    assert.equal(calls[0].fingerprint,fingerprint);assert.equal(await page.locator('#sshKey').inputValue(),'');
    assert.equal(await page.locator('#sshTransferDetails').getAttribute('open'),'');
    await page.locator('#sshReadImages').click();await page.locator('#sshLocalImage').selectOption(image);
    await page.locator('#sshImageTarget').selectOption('fixture');
    assert.equal(await page.locator('#sshTransfer').isEnabled(),true);
    // Long hostnames, fingerprints, image tags and device errors must wrap safely.
    connection.host='long-host-'.repeat(25)+'.example';connection.stage='连接信息与错误说明'.repeat(30);
    await page.locator('#sshClose').click();await page.locator('#btnConnections').click();
    await page.waitForFunction(()=>document.querySelector('#sshConnections').textContent.includes('long-host-'));
    const out=path.join(__dirname,'../../ops');fs.mkdirSync(out,{recursive:true});
    await page.locator('#sshConnectDetails').evaluate(node=>{node.open=true;});
    for(const [width,height] of [[1440,1100],[702,656],[640,420],[390,844],[320,480],[844,390]]){
      await page.setViewportSize({width,height});
      for(const auth of ['password','key','agent']){
        await page.locator('#sshAuth').selectOption(auth);await checkLayout(page);
      }
      for(const mode of ['deploy','existing','ssh-only']){
        await page.locator('#sshDeploy').selectOption(mode);await checkLayout(page);
      }
      await page.locator('#sshAuth').selectOption('password');await page.locator('#sshDeploy').selectOption('deploy');
      await checkFixedFooter(page);
      await page.locator('.ssh-modal-body').evaluate(n=>{n.scrollTop=0;});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      if(width===1440||width===390)await page.screenshot({path:path.join(out,`ssh-layout-${width===1440?'desktop':'mobile'}.png`)});
    }
    await page.locator('#sshAuth').selectOption('key');
    await page.setViewportSize({width:702,height:656});
    await page.locator('#sshKey').setInputFiles({name:'id_ed25519',mimeType:'application/octet-stream',buffer:Buffer.from(keyContent)});
    await page.locator('#sshKey').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(out,'ssh-key-import.png')});
    // Restore a verified target so the footer button participates in tab order.
    await page.locator('#sshHost').fill('192.0.2.20');await page.locator('#sshProbe').click();
    await page.waitForFunction(()=>!document.querySelector('#sshVerified').disabled);
    await page.locator('#sshVerified').check();
    await page.locator('#sshClose').focus();await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'sshConnect');
    await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'sshClose');
    await page.locator('#sshConnectDetails').evaluate(node=>{node.open=false;});
    await page.locator('#sshTransferDetails').evaluate(node=>{node.open=false;});
    await page.locator('#sshClose').focus();await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'sshConnect');
    await page.keyboard.press('Escape');assert.equal(await page.locator('#connectionsModal').isVisible(),false);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'btnConnections');
    assert.deepEqual(errors,[],'no browser script errors');
    console.log('SSH UI passed: 6 viewport sizes, fixed visible footer, equal controls, overflow, auth/mode switching, fingerprint reset/failure/race, external form submission, transfer selection and keyboard navigation.');
  }finally{
    if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
