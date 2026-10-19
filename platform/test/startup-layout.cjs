'use strict';
// Disposable, mocked browser tests. Never changes real startup settings.
const assert=require('node:assert/strict'),path=require('node:path'),express=require('express'),{once}=require('node:events');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
let server,browser,readError=true,saveError=false,saveWait=null;
const writes=[],checks=[],errors=[];
const data={managerRuntime:'docker-compose',dockerBackend:'desktop',loginRequired:true,supervisorInstalled:true,
  settings:{managerAutoStart:true,dockerAutoLaunch:true,instancesAutoStart:true},revision:'r1',
  instances:[{id:'alpha',name:'生产实例',enabled:true},{id:'beta',name:'测试实例',enabled:true},{id:'gamma',name:'备用实例',enabled:false}],
  status:{phase:'ready',checkedAt:1792134000,environment:{dockerCLIInstalled:true,dockerDesktopInstalled:true,dataDirectoryWritable:true},errors:[],
    instances:[{name:'生产实例',state:'running',detail:'服务运行正常',restartPolicy:'unless-stopped'},{name:'测试实例',state:'exited',detail:'手动停止，保持停止',restartPolicy:'unless-stopped'}]}};
async function settled(page){await page.waitForFunction(()=>!document.querySelector('#startupReload').disabled);}
async function layout(page){
  const measure=()=>page.locator('#startupModal').evaluate(root=>{
    const visible=[...root.querySelectorAll('*')].filter(node=>node.checkVisibility());
    const button=root.querySelector('#startupSave').getBoundingClientRect(),body=root.querySelector('.startup-body').getBoundingClientRect(),footer=root.querySelector('.startup-footer').getBoundingClientRect(),card=root.firstElementChild.getBoundingClientRect();
    return {top:button.top,bottom:button.bottom,bodyBottom:body.bottom,footerTop:footer.top,viewport:innerHeight,
      overflow:visible.filter(node=>node.clientWidth&&node.scrollWidth>node.clientWidth+1).map(node=>node.id||node.tagName),
      outside:visible.filter(node=>{const r=node.getBoundingClientRect();return r.width&&(r.left<card.left-1||r.right>card.right+1);}).map(node=>node.id||node.tagName)};
  });
  await page.locator('.startup-body').evaluate(node=>{node.scrollTop=0;});const top=await measure();
  await page.locator('.startup-body').evaluate(node=>{node.scrollTop=node.scrollHeight;});const bottom=await measure();
  assert.equal(top.top,bottom.top);assert.ok(top.top>=0&&top.bottom<=top.viewport,'save button visible without scrolling');
  assert.ok(top.bodyBottom<=top.footerTop+1);assert.deepEqual(top.overflow,[]);assert.deepEqual(bottom.overflow,[]);assert.deepEqual(top.outside,[]);
}
(async()=>{
  try{
    const app=express();app.use(express.static(path.join(__dirname,'../public')));server=app.listen(0,'127.0.0.1');await once(server,'listening');
    browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/**',async route=>{
      const req=route.request(),url=new URL(req.url());let body={};
      if(url.pathname==='/api/events')return route.fulfill({contentType:'text/event-stream',body:''});
      if(url.pathname==='/api/session')body={csrf:'fixture'};
      if(url.pathname==='/api/instances')body={instances:[],system:{ncpu:8,memTotalGiB:16}};
      if(url.pathname==='/api/instances/kept')body={kept:[]};
      if(url.pathname==='/api/backups/status')body={state:'never',schedule:{enabled:false},retentionDays:7};
      if(url.pathname==='/api/connections/context')body={mode:'local'};
      if(url.pathname.startsWith('/api/startup')){
        if(readError&&req.method()==='GET')return route.fulfill({status:503,json:{error:'测试：服务暂不可用'}});
        if(req.method()==='PUT'){
          const patch=req.postDataJSON();writes.push(patch);if(saveWait)await saveWait;
          if(saveError)return route.fulfill({status:409,json:{error:'启动设置已变化，请刷新后保存'}});
          for(const key of ['managerAutoStart','dockerAutoLaunch','instancesAutoStart'])if(key in patch)data.settings[key]=patch[key];
          for(const row of data.instances)if(row.id in (patch.instanceOverrides||{}))row.enabled=patch.instanceOverrides[row.id];
          data.revision='r'+(writes.length+1);
        }
        if(req.method()==='POST')checks.push(url.pathname);
        body=data;
      }
      await route.fulfill({json:body});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#btnStartup').click();await settled(page);
    assert.match(await page.locator('#startupHint').textContent(),/服务暂不可用/);
    assert.equal(await page.locator('#startupSave').isDisabled(),true);assert.equal(await page.locator('#startupManager').isDisabled(),true);
    readError=false;await page.locator('#startupReload').click();await settled(page);
    assert.equal(await page.locator('#startupSave').isDisabled(),true);assert.equal(await page.locator('#startupCheck').isEnabled(),true);
    await page.locator('#startupInstances').uncheck();await page.locator('[data-startup-instance=beta]').uncheck();
    assert.match(await page.locator('#startupChangeNote').textContent(),/2 项修改/);
    assert.equal(await page.locator('#startupSave').isEnabled(),true);assert.equal(await page.locator('#startupCheck').isDisabled(),true);
    assert.equal(await page.locator('[data-startup-instance=alpha]').isChecked(),true);
    assert.match(await page.locator('.startup-policy-badge').first().textContent(),/全局已关闭/);
    await page.keyboard.press('Escape');assert.equal(await page.locator('#startupModal').isVisible(),true);
    assert.match(await page.locator('#startupHint').textContent(),/未保存/);
    let release;saveWait=new Promise(resolve=>{release=resolve;});await page.locator('#startupSave').click();
    assert.equal(await page.locator('#startupSave').isDisabled(),true);assert.equal(await page.locator('#startupManager').isDisabled(),true);
    release();saveWait=null;await settled(page);
    assert.deepEqual(writes[0],{revision:'r1',instanceOverrides:{beta:false},instancesAutoStart:false});
    assert.equal(await page.locator('#startupSave').isDisabled(),true);assert.match(await page.locator('#startupHint').textContent(),/设置已保存/);
    saveError=true;await page.locator('#startupManager').uncheck();await page.locator('#startupSave').click();await settled(page);
    assert.equal(await page.locator('#startupManager').isChecked(),false);assert.equal(await page.locator('#startupSave').isEnabled(),true);
    assert.match(await page.locator('#startupHint').textContent(),/启动设置已变化/);saveError=false;
    assert.equal(await page.locator('#startupReload').textContent(),'放弃修改');await page.locator('#startupReload').click();await settled(page);
    assert.equal(await page.locator('#startupManager').isChecked(),true);await page.locator('#startupCheck').click();await settled(page);assert.equal(checks.length,1);
    data.managerRuntime='docker-portable';data.capabilities={managerAutoStart:true,dockerAutoLaunch:false};data.supervisorInstalled=false;delete data.status.environment;
    await page.locator('#startupReload').click();await settled(page);
    assert.equal(await page.locator('#startupDocker').isDisabled(),true);assert.equal(await page.locator('#startupDockerReason').isVisible(),true);
    assert.ok(!(await page.locator('#startupStatus').textContent()).includes('后台恢复任务尚未安装'));
    data.managerRuntime='native-portable';data.capabilities.managerAutoStart=false;data.status.phase='attention';
    data.status.errors=['<img src=x onerror=alert(1)>连接错误'.repeat(20)];data.instances[0].name='very-long-instance-name-'.repeat(25);data.status.instances[0].name=data.instances[0].name;
    await page.locator('#startupReload').click();await settled(page);
    assert.equal(await page.locator('#startupManager').isDisabled(),true);assert.equal(await page.locator('#startupStatus img').count(),0);
    for(const [width,height] of [[1440,1000],[702,656],[640,420],[390,844],[320,480],[844,390]]){
      await page.setViewportSize({width,height});await layout(page);
      await page.locator('#startupInstances').check();await layout(page);await page.locator('#startupInstances').uncheck();
    }
    data.managerRuntime='docker-compose';data.capabilities={};data.supervisorInstalled=true;data.status.phase='ready';data.status.errors=[];
    data.instances[0].name='生产实例';data.status.instances[0].name='生产实例';data.status.environment={dockerCLIInstalled:true,dockerDesktopInstalled:true,dataDirectoryWritable:true};
    await page.locator('#startupReload').click();await settled(page);
    for(const [width,height] of [[1440,1000],[390,844]]){
      await page.setViewportSize({width,height});await page.locator('.startup-body').evaluate(node=>{node.scrollTop=0;});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.screenshot({path:path.join(__dirname,`../../ops/startup-layout-${width===1440?'desktop':'mobile'}.png`)});
    }
    await page.locator('#startupClose').focus();await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'startupCheck');
    await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'startupClose');
    data.instances=[];await page.locator('#startupReload').click();await settled(page);assert.match(await page.locator('#startupInstanceSettings').textContent(),/暂无实例/);
    await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'btnStartup');assert.deepEqual(errors,[]);
    console.log('Startup UI passed: 6 viewports, fixed footer, load/save failure recovery, partial revisioned saves, dirty-state protection, capability limits, global/instance policies, escaping, empty state and keyboard navigation.');
  }finally{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
