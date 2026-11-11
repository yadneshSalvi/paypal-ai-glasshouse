// Separate, disposable headless Chrome regression. This is never native IAB
// acceptance, and it never imports a retained tenant's cookie or browser profile.
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {resolve} from 'node:path';

const filename=process.argv[2]||'.qualification/isolated.env',values=parseEnv(await readFile(filename,'utf8')),db=new URL(values.DATABASE_URL||'');
if(!['localhost','127.0.0.1'].includes(db.hostname)||!/^\/gh_findings_stage10_[a-f0-9]{12}$/.test(db.pathname)||values.GLASSHOUSE_FINDING_ISOLATED_QA!==db.pathname.slice(1)||values.PORT!=='4545')throw new Error('Only the dedicated stage10 database and port4545 may be exercised.');
const directory=resolve('.qualification/layout-'+new Date().toISOString().replaceAll(/[:.]/g,'-'));await mkdir(directory,{recursive:false});
const result={kind:'disposable headless Chrome regression',nativeAcceptance:false,origin:'http://localhost:4545',database:db.pathname.slice(1),fixturePreparedThrough:'browser-fix-fixture after new Sample admission',retainedAuthorityImported:false,measurements:[],checks:[],blockedExternalOrigins:[],pageErrors:[],failed:[]};
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0','--user-data-dir='+directory+'/chrome-profile','--no-first-run','--no-default-browser-check','--disable-sync','--disable-background-networking','--disable-component-update','--disable-default-apps','--disable-extensions','--disable-features=MediaRouter','--password-store=basic','about:blank'],{stdio:['ignore','ignore','pipe']});
let stderr='',socket,sessionId,nextId=0;const pending=new Map();
const check=(name,passed,details)=>{result.checks.push({name,passed,...details&&{details}});if(!passed)result.failed.push(name);};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function command(method,params={},session=sessionId){return new Promise((resolve,reject)=>{const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...session&&{sessionId:session}}));});}
async function evaluate(expression){const value=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result.value;}
async function until(expression,label){for(let attempt=0;attempt<100;attempt++){if(await evaluate(expression))return;await delay(100);}throw new Error('The expected local view did not appear: '+label);}
async function click(selector){await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing click target');el.focus({preventScroll:true});el.click();})()`);await delay(70);}
async function clickText(scope,text){await evaluate(`(()=>{const el=Array.from(document.querySelectorAll(${JSON.stringify(scope)})).find(el=>el.textContent.trim()===${JSON.stringify(text)});if(!el)throw new Error('Missing labelled control: '+${JSON.stringify(text)});el.focus({preventScroll:true});el.click();})()`);await delay(70);}
async function measure(label,width,selector='dialog[open]'){
  await command('Emulation.setDeviceMetricsOverride',{width,height:width>800?1000:844,deviceScaleFactor:1,mobile:false});await delay(90);
  const value=await evaluate(`(()=>{
    const all=Array.from(document.querySelectorAll(${JSON.stringify(selector)})),el=all.at(-1);if(!el)throw new Error('Missing measured view');
    const r=el.getBoundingClientRect(),style=getComputedStyle(el),heading=el.querySelector('.modal-heading h2'),surface=el.querySelector('.modal-content'),active=document.activeElement;
    const box={x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};
    const overflow=Array.from(el.querySelectorAll('*')).filter(item=>item.getClientRects().length&&item.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(item=>({tag:item.tagName,class:item.className?.baseVal??item.className,width:item.getBoundingClientRect().width,right:item.getBoundingClientRect().right}));
    const documentOverflow=Array.from(document.querySelectorAll('body *')).filter(item=>item.getClientRects().length&&item.getBoundingClientRect().right>innerWidth+1&&!item.closest('dialog')).slice(0,15).map(item=>({tag:item.tagName,class:item.className?.baseVal??item.className,width:item.getBoundingClientRect().width,right:item.getBoundingClientRect().right,text:item.textContent.trim().slice(0,80)}));
    return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,box,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,overflow,documentOverflow,computed:{width:style.width,maxWidth:style.maxWidth,heading:heading?getComputedStyle(heading).color:null,surface:surface?getComputedStyle(surface).backgroundColor:null},active:{tag:active?.tagName,text:active?.textContent?.trim().slice(0,90)}};
  })()`);
  result.measurements.push({label,...value});
  check(label+' fits viewport '+width,value.box.x>=-1&&value.box.right<=width+1&&value.scrollWidth<=value.clientWidth+1&&value.documentWidth<=width,{box:value.box,dialogScroll:value.scrollWidth,documentWidth:value.documentWidth});
  if(label.includes('finding')&&[1440,390,360].includes(width)){const screenshot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(directory+'/'+label+'-'+width+'.png',Buffer.from(screenshot.data,'base64'));}
  return value;
}
async function contrast(label){
  const value=await evaluate(`(()=>{
    const rgb=value=>(value.match(/[\\d.]+/g)||[]).map(Number),luminance=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0),rows=[];
    for(const el of document.querySelectorAll('.finding-dialog *')){
      if(!el.getClientRects().length||el.closest('[hidden]')||el.matches(':disabled')||el.closest(':disabled')||!Array.from(el.childNodes).some(n=>n.nodeType===3&&n.textContent.trim()))continue;
      const s=getComputedStyle(el);if(s.visibility==='hidden'||s.opacity==='0')continue;let bg=el,background=[];
      while(bg){background=rgb(getComputedStyle(bg).backgroundColor);if(background.length===3||background[3]>0)break;bg=bg.parentElement;}
      const foreground=rgb(s.color),a=luminance(foreground),b=luminance(background.length?background:[255,255,255]),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      const threshold=parseFloat(s.fontSize)>=24||parseFloat(s.fontSize)>=18.66&&parseFloat(s.fontWeight)>=700?3:4.5;
      rows.push({tag:el.tagName,class:el.className?.baseVal??el.className,text:el.textContent.trim().slice(0,80),color:s.color,background:bg?getComputedStyle(bg).backgroundColor:null,ratio,threshold});
    }
    return {checked:rows.length,minimum:Math.min(...rows.map(row=>row.ratio)),failures:rows.filter(row=>row.ratio+.01<row.threshold)};
  })()`);
  result.measurements.push({label,contrast:value});check(label+' text contrast',value.failures.length===0,value);
}
try{
  const endpoint=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Disposable Chrome did not start.')),15000);chrome.stderr.on('data',data=>{stderr+=data;const match=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});chrome.once('exit',code=>{clearTimeout(timeout);reject(new Error('Disposable Chrome exited '+code));});});
  socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id){const waiting=pending.get(message.id);if(waiting){clearTimeout(waiting.timer);pending.delete(message.id);message.error?waiting.reject(new Error(message.error.message)):waiting.resolve(message.result);}}else if(message.method==='Fetch.requestPaused'){
    const {requestId,request}=message.params,url=new URL(request.url);const allowed=url.protocol==='data:'||url.protocol==='about:'||['http://127.0.0.1:4545','http://localhost:4545'].includes(url.origin);
    if(!allowed)result.blockedExternalOrigins.push(url.origin);
    void command(allowed?'Fetch.continueRequest':'Fetch.failRequest',{requestId,...!allowed&&{errorReason:'BlockedByClient'}},message.sessionId).catch(error=>result.pageErrors.push(error.message));
  }else if(message.method==='Runtime.exceptionThrown')result.pageErrors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);});
  const target=await command('Target.createTarget',{url:'about:blank'},null),attached=await command('Target.attachToTarget',{targetId:target.targetId,flatten:true},null);sessionId=attached.sessionId;
  await command('Page.enable');await command('Runtime.enable');await command('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await command('Page.navigate',{url:result.origin+'/'});await until("!!document.querySelector('[data-focus-return=\"finding-library\"]')",'new Sample admission');
  const session=await evaluate("fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()).then(s=>({tenantId:s.actor.tenantId,actorId:s.actor.id,contextId:s.workspace.identity.contextId}))");
  result.session=session;
  const setup=spawn(process.execPath,['scripts/findings-qa.mjs','browser-fix-fixture',filename,session.tenantId],{stdio:['ignore','pipe','pipe']});let setupLog='';setup.stdout.on('data',value=>setupLog+=value);setup.stderr.on('data',value=>setupLog+=value);const setupCode=await new Promise(resolve=>setup.once('exit',resolve));await writeFile(directory+'/fixture-setup.log',setupLog);if(setupCode!==0)throw new Error('Fresh fixture preparation failed; its partial records and log are preserved.');
  const fixture=JSON.parse(await readFile('.qualification/native-fix-fixtures/'+session.tenantId+'.json','utf8'));result.fixture=fixture;
  await command('Page.reload');await until("!!document.querySelector('[data-focus-return=\"finding-library\"]')",'prepared workspace reload');
  await click('[data-focus-return="finding-library"]');await until('!!document.querySelector(".finding-card")','prepared finding list');
  for(const width of [1440,720,390,360,320])await measure('finding-library',width);
  await contrast('finding-library');await click('.finding-card');await until('!!document.querySelector(".finding-hero")','reviewed finding');
  for(const width of [1440,720,390,360,320])await measure('finding-current-review',width);
  await contrast('finding-current-review');
  await clickText('.finding-tabs button','Source comparison2');await until('!!document.querySelector(".finding-sources")','source comparison');
  for(const width of [1440,390,360])await measure('finding-sources',width);await contrast('finding-sources');
  await clickText('.finding-tabs button','Review timeline5');await until('!!document.querySelector(".finding-timeline")','review timeline');
  for(const width of [1440,390,360])await measure('finding-timeline',width);await contrast('finding-timeline');
  await evaluate("Array.from(document.querySelectorAll('.finding-timeline li')).find(row=>row.firstElementChild.textContent.trim()==='03').querySelector('button').click()");
  await until('!!document.querySelector(".finding-delta")','preserved source-change review');await measure('finding-source-change',360);await contrast('finding-source-change');
  const linkedSelector='[data-focus-return="finding-plan-'+fixture.sourceOnlyPlanId+'"]';await click(linkedSelector);await until('document.querySelectorAll("dialog[open]").length===2&&document.querySelector(".finding-dependency-review")?.getAttribute("aria-busy")==="false"','linked stale source-only manifest');
  check('manifest opens at its heading',await evaluate("document.activeElement===document.querySelector('dialog[open]:last-of-type .modal-heading h2')"));
  const planText=await evaluate("document.querySelector('.finding-dependency-review').textContent");check('source-only text distinguishes interpretation selection from historical source binding',planText.includes('No interpreted finding was selected')&&planText.includes('historical source snapshot')&&!planText.includes('current source dependencies verify'));
  await clickText('.finding-dependency-review button','Refresh current review');await until("document.querySelector('.finding-dependency-review')?.getAttribute('aria-busy')==='false'",'refreshed manifest');check('refresh retains its exact control',await evaluate("document.activeElement===document.querySelector('.finding-dependency-review button')"));
  for(const width of [1440,390,360])await measure('linked-stale-manifest',width);
  await click('dialog[open]:last-of-type .modal-heading button');await until('document.querySelectorAll("dialog[open]").length===1','return to finding');check('linked manifest returns to its exact finding control',await evaluate('document.activeElement===document.querySelector('+JSON.stringify(linkedSelector)+')'));
  await clickText('.finding-notice button','Open the current permitted review');await until('document.querySelector(".finding-hero-copy")?.textContent.includes("Current review 5")','current review again');
  for(const [control,name] of [['Challenge','challenge'],['Revise interpretation','revise'],['Retract','retract']]){
    await clickText('.finding-review-actions button',control);await until('!!document.querySelector(".finding-form")',name+' form');
    for(const width of [1440,390,360])await measure('finding-'+name+'-form',width);await contrast('finding-'+name+'-form');
    if(name!=='retract')check(name+' citation search has accessible name',await evaluate("Array.from(document.querySelectorAll('.finding-citation-picker input[type=search]')).every(input=>Array.from(input.labels||[]).some(label=>label.textContent.includes('Search citation sources')))"));
    await clickText('.finding-form-foot button','Return without a new decision');await until('!document.querySelector(".finding-form")','unchanged finding');
  }
  await click('dialog[open] .modal-heading button');await until('!document.querySelector("dialog[open]")','closed finding');
  for(const [selector,name] of [['[data-focus-return="report-library"]','saved-reports'],['[data-focus-return="workspace-directory"]','workspace-directory']]){
    await click(selector);await until('!!document.querySelector("dialog[open]")',name);
    for(const width of [1440,720,390,360,320])await measure(name,width);await click('dialog[open] .modal-heading button');await until('!document.querySelector("dialog[open]")','closed '+name);
  }
  await command('Page.navigate',{url:result.origin+'/reports/'+fixture.reportId});await until('!!document.querySelector(".edition-correction-notices article")','saved-edition correction notice');
  const notice=await evaluate("document.querySelector('.edition-correction-notices').textContent");check('report notice compares saved63 to current54 and names its basis',notice.includes('63 → 54 affected')&&notice.includes('Review 2 (source cohort v1) → review 5 (source cohort v2)')&&notice.includes('2 related saved manifests currently held'));
  for(const width of [1440,390,360])await measure('saved-edition-correction',width,'.edition-correction-notices');
  result.complete=true;
}catch(error){result.failed.push(error.message);result.complete=false;}
finally{
  result.blockedExternalOrigins=[...new Set(result.blockedExternalOrigins)];result.completedAt=new Date().toISOString();
  await writeFile(directory+'/observations.json',JSON.stringify(result,null,2)+'\n');await writeFile(directory+'/chrome-stderr.log',stderr);
  if(socket?.readyState===WebSocket.OPEN){try{await command('Browser.close',{},null);}catch{}socket.close();}
  if(chrome.exitCode===null)chrome.kill('SIGTERM');
  for(const waiting of pending.values()){clearTimeout(waiting.timer);waiting.reject(new Error('Disposable browser closed.'));}pending.clear();
  console.log(JSON.stringify({directory,complete:result.complete,measurements:result.measurements.length,checks:result.checks.length,failures:result.failed,pageErrors:result.pageErrors.length,nativeAcceptance:false}));process.exitCode=result.failed.length?1:0;
}
