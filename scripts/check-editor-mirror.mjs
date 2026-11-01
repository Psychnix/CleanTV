// Samsung Live-Spiegel: the fixed TV expression against the real app, then the editor mirror with a
// fake state feed (no TV, no sdb), the explicit debug restart and "Vom TV übernehmen" for Tizen drafts.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {openEditor,ready,root} from './editor-browser.mjs';
const storage=mkdtempSync(join(tmpdir(),'cleantv-mirror-'));
const app=await openEditor(storage);
const expression=readFileSync(root+'scripts/editor-tizen-mirror.js','utf8');
const fixture=JSON.parse(readFileSync(root+'scripts/fixtures/tizen-mirror-state.json','utf8'));
const today=new Date().toISOString().slice(0,10);
const tv=change=>{const s=structuredClone(fixture);s.weather.forecast.at=Date.now()-60000;s.weather.forecast.days=[{date:today,max:9.4,min:2.1}];change?.(s);return s;};
const at=(s,view,group,focus,addonId='')=>{s.where={...s.where,view,settingsGroup:group,focusAction:focus,zone:null};s.state.view=view;s.state.settingsGroup=group;s.state.focusAction=focus;s.context={...s.context,view:view==='appearance'?'appearance.'+group:view};s.detail={addonId,addonTab:''};};
const jpeg=readFileSync(root+'app/assets/wallpapers/cove-thumb.jpg');
const errors=[];
try{
 // 1. The one fixed expression, evaluated in a Tizen-flavoured copy of the real app, changes nothing.
 const tvPage=await app.browser.newPage({viewport:{width:1920,height:1080}});tvPage.on('pageerror',e=>errors.push('tv: '+e.message));
 await tvPage.route(url=>!url.href.startsWith(app.url),route=>route.abort());
 await tvPage.addInitScript(()=>{
  if(!localStorage.getItem('cleantv.home.v1'))localStorage.setItem('cleantv.home.v1',JSON.stringify({language:'de',bg:'photo',wall:'cove',layout:'dock',material:'soft',home:['youtube','netflix','rJeHak5zRg.Spotify'],appRecords:[{id:'rJeHak5zRg.Spotify',appId:'rJeHak5zRg.Spotify',name:'Spotify',brand:'spotify',icon:'/opt/usr/apps/spotify/icon.png'}]}));
  window.tizen={application:{getCurrentApplication(){return {appInfo:{id:'TestPkg001.CleanTV',packageId:'TestPkg001',version:'0.9.0'}};},getAppsInfo(ok){setTimeout(()=>ok([]),0);},launch(id,ok){if(ok)ok();},launchAppControl(c,id,ok){if(ok)ok();}}};
 });
 const tvReady=()=>tvPage.waitForFunction(()=>window.ShoreQA&&ShoreQA.ready()&&CleanFrameDesign.ready(),null,{timeout:20000});
 await tvPage.goto(app.url+'/home/');await tvReady();
 await tvPage.evaluate(()=>CleanTVStore.write('cleantv.addons.v1',{installed:{'cleantv-weather':{api:1,id:'cleantv-weather',name:'Wetter',kind:'weather',version:'1.0.0',description:'Wetter',author:'CleanTV',license:'MIT',enabled:true}},catalog:[]}));
 await tvPage.reload();await tvReady();
 const snapshot=()=>tvPage.evaluate(()=>({storage:JSON.stringify(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)])),writes:ShoreQA.state().writes,view:CleanFrameDesign.context().view,focus:ShoreQA.state().focusAction,addons:JSON.stringify(CleanFrameAddons.state())}));
 const read=async()=>{const before=await snapshot(),value=JSON.parse(await tvPage.evaluate(expression));assert.deepEqual(await snapshot(),before,'The TV expression must not change the page');return value;};
 let value=await read();
 assert.deepEqual(value.errors,{});assert.equal(value.ready,true);assert.equal(value.app.version,'0.9.0');assert.equal(value.context.view,'home');
 assert.equal(value.state.committed.wall,'cove');assert.equal(value.state.appRecords[0].name,'Spotify');assert.equal(value.state.appRecords[0].icon,undefined);
 assert.equal(value.addons.installed['cleantv-weather'].kind,'weather');assert.ok(JSON.stringify(value).length<20000,'Small payload');
 // #9 The shape of the fixed expression — a broken expression-to-mirror/import mapping must fail here.
 assert.deepEqual(Object.keys(value).sort(),['addons','app','caps','context','design','detail','errors','hidden','legacy','link','message','ready','state','v','walls','weather','where'],'Top-level expression shape');
 for(const key of ['view','settingsGroup','focusAction','zone','wallpaper'])assert.ok(key in value.where,'where.'+key+' present');
 assert.equal(value.where.focusAction,'home.app.youtube');
 for(const key of ['committed','appRecords','spotify','wallpaperPicker','view','focusAction'])assert.ok(key in value.state,'state.'+key+' present');
 assert.ok('language' in value.state.committed,'committed.language present');assert.equal(value.message,null,'No message view on Home');
 // capture() must turn this exact state into a draft with the right preference keys (optional favourites).
 const cap=spawnSync('python3',['-I','-',JSON.stringify(value)],{cwd:root+'scripts',encoding:'utf8',input:[
  'import json,sys','sys.path.insert(0,".")','import editor_tizen','from editor_server import PREF_KEYS',
  'state=json.loads(sys.argv[1])','cap=editor_tizen.capture(state)','keys=sorted(cap["preferences"].keys())',
  'expected=sorted(list(PREF_KEYS)+[k for k in ["favourites"] if k in cap["preferences"]])',
  'assert keys==expected, "preference keys %r != %r" % (keys,expected)',
  'assert cap["version"]==state["app"]["version"] and cap["platform"]=="tizen"',
  'assert cap["preferences"]["language"]==state["state"]["committed"]["language"]','print("ok")'].join('\n')});
 assert.ok((cap.stdout||'').trim().endsWith('ok'),'capture() maps the expression state to a draft: '+(cap.stdout||'')+(cap.stderr||''));
 await tvPage.evaluate(()=>{ShoreQA.scene('settings');ShoreQA.activate('settings.group.addons');ShoreQA.activate('addon.tab.discover');});
 value=await read();assert.equal(value.context.view,'appearance.addons');assert.equal(value.detail.addonTab,'addon.tab.discover');
 await tvPage.evaluate(()=>{ShoreQA.activate('addon.tab.installed');ShoreQA.activate('addon.details.cleantv-weather');});
 value=await read();assert.equal(value.context.view,'appearance.addon-detail');assert.equal(value.detail.addonId,'cleantv-weather');
 // #11 A message/dialog view is read from the sheet, naming the add-on behind an uninstall dialog.
 await tvPage.evaluate(()=>ShoreQA.activate('addon.remove.cleantv-weather'));
 value=await read();assert.equal(value.where.view,'message');assert.ok(value.message&&value.message.title,'Message title is read');
 assert.equal(value.message.addonId,'cleantv-weather','The add-on behind the uninstall dialog is named');
 await tvPage.close();
 console.log('The fixed TV expression is ES5 data access only: no page, storage or focus changes, small payload.');

 // 2. Editor with a fake Samsung status and mirror feed.
 const page=await app.browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 const external=[];page.on('request',request=>{const url=request.url();if(!url.startsWith(app.url)&&!url.startsWith('about:')&&!url.startsWith('data:')&&!url.startsWith('blob:'))external.push(url);});
 await page.route(url=>!url.href.startsWith(app.url),route=>new URL(route.request().url()).hostname==='raw.githubusercontent.com'?route.fulfill({status:200,contentType:'image/jpeg',body:jpeg}):route.abort());
 await page.route('**/api/editor/agent/state',route=>route.fulfill({json:{available:true,active:false,activity:'Test',messages:[]}}));
 const readyStatus={platform:'tizen',configured:true,connected:true,debug:true,cleantv:true,state:'ready',message:'TV verbunden · Debug-Modus an · CleanTV bereit',label:'Samsung-Fernseher',address:'192.0.2.10:26101',version:'0.9.0',checkedAt:Date.now()/1000,ready:false,releaseState:'unsupported',releaseMessage:'Übertragung auf Samsung erfolgt über npm run tv:install.'};
 let tvStatus=readyStatus,feed={seq:0,phase:'live',message:'',state:null},mirrorRequests=0,holdDebug=null;const debugPosts=[];
 const push=state=>{feed={...feed,seq:feed.seq+1,state:structuredClone(state)};};
 await page.route('**/api/editor/tv/status',route=>route.fulfill({json:{...tvStatus,checkedAt:Date.now()/1000}}));
 await page.route('**/api/editor/tv/mirror?*',async route=>{
  mirrorRequests++;const since=Number(new URL(route.request().url()).searchParams.get('since'));
  if(since===feed.seq)await new Promise(resolve=>setTimeout(resolve,250));
  const body={seq:feed.seq,phase:feed.phase,message:feed.message,age:feed.age??0,localVersion:'0.9.0'};if(since!==feed.seq&&feed.state)body.state=feed.state;
  await route.fulfill({json:body}).catch(()=>{});
 });
 await page.route('**/api/editor/tv/debug',async route=>{debugPosts.push(route.request().headers()['x-cleanframe-token']);if(holdDebug)await holdDebug;return route.fulfill({json:readyStatus});});
 await page.goto(app.url+'/editor/');await ready(page);await page.evaluate(()=>CleanFrameEditor.save());
 await page.waitForFunction(()=>document.querySelector('#tvStatus span').textContent==='CleanTV bereit');
 const draftStorage=await page.evaluate(()=>localStorage.getItem('cleantv.home.v1')),draft=await page.evaluate(()=>JSON.stringify(CleanFrameEditor.project));
 assert.equal(mirrorRequests,0,'No TV reads before Live is opened');
 assert.equal(await page.locator('#prepare').isVisible(),false,'Für TV vorbereiten is hidden on Samsung (#14)');
 const mirror=fn=>page.evaluate(fn);
 const applied=async n=>page.waitForFunction(n=>{const w=document.getElementById('mirror').contentWindow;return !!(w&&w.CleanTVMirror&&w.CleanTVMirror.revision>=n&&w.ShoreQA&&typeof w.ShoreQA.ready==='function'&&w.ShoreQA.ready());},n,{timeout:20000});
 push(tv());await page.click('#liveTab');
 await page.waitForFunction(()=>document.body.classList.contains('mirror-mode'));await applied(1);
 assert.equal(await page.locator('#mirrorLabel').textContent(),'Nachgezeichnet vom Zustand des Fernsehers – kein Kamerabild');
 assert.ok(await page.locator('#mirrorLabel').isVisible());assert.equal(await page.locator('#liveProfile').isVisible(),false);
 assert.equal(await page.locator('#preview').isVisible(),false);assert.equal(await page.locator('#liveFrame').isVisible(),false);
 assert.ok((await page.locator('#mirror').boundingBox()).width>400);assert.equal(await page.locator('#mirror').evaluate(el=>getComputedStyle(el).pointerEvents),'none');
 let shown=await mirror(()=>{const w=document.getElementById('mirror').contentWindow,s=w.ShoreQA.state();return {wall:s.committed.wall,home:s.committed.home,view:w.CleanFrameDesign.context().view,focus:s.focusAction,title:w.document.getElementById('spotifyCompactTitle').textContent,player:!w.document.getElementById('spotifyPlayer').hidden,weather:w.document.getElementById('cleantvWidgets').textContent,native:!!w.CleanFrameNative,android:w.document.getElementById('stage').className.includes('is-android'),mode:w.CleanTVMirror.mode};});
 assert.equal(shown.wall,'cove');assert.ok(shown.home.includes('stremio')&&shown.home.includes('rJeHak5zRg.Spotify'));assert.equal(shown.view,'home');assert.equal(shown.focus,'home.app.youtube');
 assert.equal(shown.title,'Testtitel');assert.ok(shown.player);assert.match(shown.weather,/Teststadt/);assert.equal(shown.native,false);assert.equal(shown.android,false);assert.equal(shown.mode,'mirror');
 assert.equal(await page.evaluate(()=>localStorage.getItem('cleantv.home.v1')),draftStorage,'The mirror never writes the editor origin storage');
 mkdirSync(root+'.local/editor/qa',{recursive:true});await page.waitForTimeout(500);await page.screenshot({path:root+'.local/editor/qa/tizen-mirror.png'});
 console.log('Mirror redraws Home from TV data with the Samsung page: wallpaper, apps, focus, Spotify card and weather.');
 push(tv(s=>at(s,'appearance','background','choice.bg.dark')));await applied(2);
 await page.waitForFunction(()=>{const w=document.getElementById('mirror').contentWindow;return w.CleanFrameDesign.context().view==='appearance.background'&&w.ShoreQA.state().focusAction==='choice.bg.dark';});
 push(tv(s=>at(s,'appearance','rotation','rotation.fixed')));await applied(3);
 await page.waitForFunction(()=>document.getElementById('mirror').contentWindow.CleanFrameDesign.context().view==='appearance.rotation');
 assert.match(await mirror(()=>document.getElementById('mirror').contentWindow.document.querySelector('#appearance [data-action="settings.back"]').textContent),/Hintergrund/,'Nested settings keep their parent');
 push(tv(s=>at(s,'appearance','addon-detail','addon.toggle.cleantv-weather','cleantv-weather')));await applied(4);
 await page.waitForFunction(()=>{const w=document.getElementById('mirror').contentWindow;return w.CleanFrameDesign.context().view==='appearance.addon-detail'&&w.ShoreQA.actions().includes('addon.toggle.cleantv-weather')&&w.ShoreQA.state().focusAction==='addon.toggle.cleantv-weather';});
 push(tv(s=>{s.state.committed.layout='list';s.context.layout='list';s.state.spotify.title='Zweiter Titel';}));await applied(5);
 await page.waitForFunction(()=>{const w=document.getElementById('mirror').contentWindow;return w.ShoreQA.state().committed.layout==='list'&&w.document.getElementById('spotifyCompactTitle').textContent==='Zweiter Titel'&&w.CleanFrameDesign.context().view==='home';});
 push(tv(s=>{s.state.committed.wall='aw-test';s.state.committed.favourites=['aw-test'];s.state.shown.wall='aw-test';s.where.wallpaper='aw-test';s.walls.entries=[{id:'aw-test',name:'Testfoto',rev:'0123456789ab',tone:'dark',ut:{tr:'light',br:'light'},frostVeil:.2,listColumn:0,dockQuiet:false,clockMist:false,gone:false,stored:false}];}));
 await page.waitForFunction(()=>{const w=document.getElementById('mirror').contentWindow;return !!(w&&w.CleanTVMirror&&w.ShoreQA&&typeof w.ShoreQA.ready==='function'&&w.ShoreQA.ready()&&w.ShoreQA.state().committed.wall==='aw-test'&&w.CleanFrameWallpapers.some(x=>x.id==='aw-test'&&x.remote));},null,{timeout:20000});
 assert.ok(external.some(url=>url.startsWith('https://raw.githubusercontent.com/Psychnix/cleanframe-addons/main/cleantv-wallpapers/generated/aw-test/')));
 assert.deepEqual(external.filter(url=>!url.startsWith('https://raw.githubusercontent.com/')),[],'Only add-on wallpaper images leave the Mac');
 await page.keyboard.press('ArrowRight');
 assert.equal(await page.evaluate(()=>JSON.stringify(CleanFrameEditor.project)),draft,'The mirror leaves the draft unchanged');
 assert.match(await page.locator('#liveCaption').textContent(),/Stand/);
 console.log('Settings path, focus, add-on detail, preferences, Spotify and add-on wallpapers follow the feed; the draft stays unchanged.');
 // Keep the add-on wallpaper entry so these later steps redraw without reloading the frame.
 const awEntry={id:'aw-test',name:'Testfoto',rev:'0123456789ab',tone:'dark',ut:{tr:'light',br:'light'},frostVeil:.2,listColumn:0,dockQuiet:false,clockMist:false,gone:false,stored:false};
 const withWall=change=>tv(s=>{s.state.committed.wall='aw-test';s.state.committed.favourites=['aw-test'];s.state.shown.wall='aw-test';s.where.wallpaper='aw-test';s.walls.entries=[awEntry];change?.(s);});
 const frameView=()=>page.evaluate(()=>document.getElementById('mirror').contentWindow.CleanFrameDesign.context().view);
 // #15 The caption shows the last confirmed read and the separate last-change time; a silent TV is flagged.
 push(withWall(s=>at(s,'home','','home.app.youtube')));
 await page.waitForFunction(()=>/zuletzt geändert/.test(document.querySelector('#liveCaption').textContent),null,{timeout:20000});
 assert.match(await page.locator('#liveCaption').textContent(),/Stand \d/,'Stand is the last confirmed read');
 feed={...feed,age:8};
 await page.waitForFunction(()=>/keine Antwort vom TV seit/.test(document.querySelector('#liveCaption').textContent),null,{timeout:20000});
 assert.match(await page.locator('#liveCaption').textContent(),/keine Antwort vom TV seit 8 s/,'A silent TV is flagged in the caption');
 feed={...feed,age:0};
 console.log('Stand is the last confirmed read; a silent TV is flagged (#15).');
 // #11 Message views show the TV's own text, not an editor placeholder.
 push(withWall(s=>{at(s,'message','','message.back');s.context.view='message.error';s.message={title:'App nicht erreichbar',line:'Diese App konnte nicht geöffnet werden.',note:'Bitte später erneut versuchen.',addonId:''};}));
 await page.waitForFunction(()=>{const w=document.getElementById('mirror').contentWindow,t=w.document.querySelector('.msg-title');return !!t&&t.textContent==='App nicht erreichbar'&&w.document.querySelector('.msg-line').textContent==='Diese App konnte nicht geöffnet werden.';},null,{timeout:20000});
 // #11 An uninstall dialog for an add-on that is not installed falls back to the list instead of looping.
 push(withWall(s=>{at(s,'message','','message.back');s.context.view='message.addonRemove';s.message={title:'Entfernen?',line:'',note:'',addonId:'cleantv-missing'};}));
 await page.waitForFunction(()=>document.getElementById('mirror').contentWindow.CleanFrameDesign.context().view==='appearance.addons',null,{timeout:20000});
 console.log('Message text comes from the TV; an uninstall dialog for a missing add-on falls back to the list (#11).');
 // #6 The wallpaper picker candidate follows the TV, even scrolled far past the six visible rows.
 const candidateIs=cand=>page.waitForFunction(c=>{const w=document.getElementById('mirror').contentWindow;return w.ShoreQA&&w.ShoreQA.state&&(w.ShoreQA.state().wallpaperPicker||{}).candidate===c;},cand,{timeout:20000});
 const pick=(cand,zone)=>push(withWall(s=>{at(s,'wallpaper','wallpaper','wallpaper.'+(zone==='star'?'star':'choose')+'.'+cand);s.context.view='wallpaper';s.state.committed.wall='aw-test';s.state.wallpaperPicker={candidate:cand,applied:'aw-test',zone:zone||'photo',top:0};}));
 pick('summit');await candidateIs('summit');
 pick('alpine');await candidateIs('alpine');
 pick('forest','star');await candidateIs('forest');
 await page.waitForFunction(()=>(document.getElementById('mirror').contentWindow.ShoreQA.state().wallpaperPicker||{}).zone==='star',null,{timeout:20000});
 console.log('The wallpaper picker candidate and zone follow the TV past the visible rows (#6).');
 // #7 The mirror takes no keyboard input: a key never reaches a document listener and is cancelled.
 push(withWall(s=>at(s,'home','','home.app.youtube')));
 await page.waitForFunction(()=>document.getElementById('mirror').contentWindow.ShoreQA.state().focusAction==='home.app.youtube',null,{timeout:20000});
 const keys=await page.evaluate(()=>{const w=document.getElementById('mirror').contentWindow;let reached=false;const probe=()=>{reached=true;};w.document.addEventListener('keydown',probe);const ev=new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true});const ok=w.document.body.dispatchEvent(ev);w.document.removeEventListener('keydown',probe);return {reached,prevented:!ok};});
 assert.equal(keys.reached,false,'A keydown never reaches a document listener in the mirror (#7)');
 assert.equal(keys.prevented,true,'The mirror cancels keyboard input (#7)');
 // #7 Local drift in the frame is corrected on the next (even empty) read.
 await page.evaluate(()=>document.getElementById('mirror').contentWindow.ShoreQA.editorScene('apps'));
 assert.equal(await frameView(),'apps','The frame can be nudged off the TV scene');
 await page.waitForFunction(()=>document.getElementById('mirror').contentWindow.CleanFrameDesign.context().view==='home',null,{timeout:20000});
 console.log('The mirror takes no keyboard input and re-syncs local drift (#7).');
 // #12 A Samsung reorder is applied live (no reload); a recent-apps change reloads the frame.
 await page.evaluate(()=>{document.getElementById('mirror').contentWindow.__mirrorMark=1;});
 push(withWall(s=>{at(s,'home','','home.app.netflix');s.state.committed.home=['netflix','youtube','stremio','rJeHak5zRg.Spotify'];}));
 await page.waitForFunction(()=>document.getElementById('mirror').contentWindow.ShoreQA.state().committed.home[0]==='netflix',null,{timeout:20000});
 assert.equal(await page.evaluate(()=>document.getElementById('mirror').contentWindow.__mirrorMark),1,'A Samsung reorder applies live, without reloading the frame (#12)');
 push(withWall(s=>{at(s,'home','','home.app.youtube');s.state.committed.recent=['netflix'];}));
 await page.waitForFunction(()=>{const w=document.getElementById('mirror').contentWindow;return w&&w.CleanTVMirror&&w.ShoreQA&&typeof w.ShoreQA.ready==='function'&&w.ShoreQA.ready()&&w.__mirrorMark===undefined;},null,{timeout:20000});
 // Settle on home with the reloaded structure (recent kept) so the next step sees a steady frame.
 push(withWall(s=>{at(s,'home','','home.app.youtube');s.state.committed.recent=['netflix'];}));
 await page.waitForFunction(()=>document.getElementById('mirror').contentWindow.ShoreQA.state().focusAction==='home.app.youtube',null,{timeout:20000});
 console.log('Home reorders apply live; a recent-apps change reloads the frame (#12).');
 // #9 Language, favourites (rotation) and design rules from the TV all reach the mirror.
 push(withWall(s=>{at(s,'home','','home.app.youtube');s.state.committed.recent=['netflix'];s.state.committed.language='en';s.state.committed.favourites=['mint','summit'];s.design={version:1,rules:[{view:'home',layout:'dock',state:'*',target:'caption',style:{offsetX:12}}]};}));
 await page.waitForFunction(()=>{const w=document.getElementById('mirror').contentWindow;return w&&w.ShoreQA&&typeof w.ShoreQA.ready==='function'&&w.ShoreQA.ready()&&w.ShoreQA.state().committed.language==='en'&&JSON.stringify(w.ShoreQA.state().committed.favourites)===JSON.stringify(['mint','summit'])&&w.CleanFrameDesign.get().rules.length===1;},null,{timeout:20000});
 console.log('Language, favourites and design rules from the TV reach the mirror (#9).');
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForTimeout(400);let count=mirrorRequests;await page.waitForTimeout(1500);
 assert.equal(mirrorRequests,count,'A hidden tab stops reading');assert.equal(await page.locator('#mirror').getAttribute('src'),'about:blank');
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForFunction(()=>{const w=document.getElementById('mirror').contentWindow;return !!(w&&w.CleanTVMirror&&w.ShoreQA&&typeof w.ShoreQA.ready==='function'&&w.ShoreQA.ready());},null,{timeout:20000});
 assert.ok(mirrorRequests>count,'A visible tab reads again');
 feed={...feed,phase:'debug-off',message:'Debug-Modus aus. CleanTV im Debug-Modus neu starten.'};tvStatus={...readyStatus,debug:false,cleantv:false,state:'connected',message:'TV verbunden · Debug-Modus aus'};
 await page.waitForFunction(()=>!document.querySelector('#mirrorDebug').hidden);
 await page.click('#tvStatus');await page.waitForFunction(()=>!document.querySelector('#restartDebug').hidden&&!document.querySelector('#restartDebug').disabled);
 await page.waitForFunction(()=>/Debug-Modusaus/.test(document.querySelector('#tvDetails').textContent)&&document.querySelector('#tvStatus span').textContent==='TV verbunden');
 await page.click('#restartDebug');await page.waitForSelector('#dialog[open]');
 assert.match(await page.locator('#dialogBody').textContent(),/CleanTV wird auf dem Fernseher beendet/);assert.equal(await page.locator('#dialogSave').textContent(),'Neu starten');
 assert.match(await page.locator('#dialogBody').textContent(),/alle Netzwerkschnittstellen/,'The restart warning names the LAN exposure');
 await page.click('#dialogCancel');await page.waitForTimeout(200);assert.equal(debugPosts.length,0,'Cancel never restarts the TV app');
 // A double submit (click, requestSubmit, Enter) must restart CleanTV only once.
 let release;holdDebug=new Promise(r=>{release=r;});
 await page.click('#mirrorDebug');await page.waitForSelector('#dialog[open]');
 await page.evaluate(()=>{const b=document.getElementById('dialogSave');b.click();document.getElementById('dialogForm').requestSubmit();b.click();});
 // The submit disables the button synchronously and the held restart keeps it disabled (no polling race).
 assert.equal(await page.locator('#dialogSave').evaluate(el=>el.disabled),true,'The restart button is disabled while it runs');
 assert.equal(await page.locator('#dialogSave').textContent(),'Wird neu gestartet …','The restart button shows progress while it runs');
 await page.keyboard.press('Enter');  // an implicit Enter submit cannot fire a second restart
 await page.waitForTimeout(300);release();holdDebug=null;
 await page.waitForFunction(()=>!document.querySelector('#dialog').open);
 assert.equal(debugPosts.length,1,'A double submit restarts CleanTV only once');assert.ok(debugPosts[0]);
 await page.waitForFunction(()=>!document.getElementById('dialogSave').disabled,null,{timeout:5000});
 assert.equal(await page.locator('#dialogSave').textContent(),'Speichern','Other dialogs keep their label');
 feed={...feed,phase:'live',message:''};tvStatus=readyStatus;
 console.log('Hidden tabs stop reading; the debug restart needs an explicit confirmation with the German warning.');

 // 3. "Vom TV übernehmen" creates a Samsung draft that the Tizen preview keeps intact.
 const before=await page.evaluate(()=>CleanFrameEditor.project);const home=['youtube','netflix','stremio','rJeHak5zRg.Spotify'];
 await page.route('**/api/editor/tv/import',async route=>{
  assert.equal(route.request().postDataJSON().etag,createHash('sha256').update(readFileSync(storage+'/project.json')).digest('hex'));
  const imported=structuredClone(before);
  imported.preferences={...before.preferences,...Object.fromEntries(Object.entries(fixture.state.committed).filter(([k])=>k in before.preferences)),home,wall:'aw-test'};
  imported.basePrefs=structuredClone(imported.preferences);imported.baseCapturedAt='2026-11-01T12:00:00+0100';
  imported.tvSource={platform:'tizen',version:'0.9.0',apps:[{id:'rJeHak5zRg.Spotify',appId:'rJeHak5zRg.Spotify',name:'Spotify',brand:'spotify'}],addons:Object.values(fixture.addons.installed).map(({id,name,kind,version,enabled})=>({id,name,kind,version,enabled})),wallpapers:[{id:'aw-test',name:'Testfoto',rev:'0123456789ab',tone:'dark',ut:{tr:'light',br:'light'},frostVeil:.2,listColumn:0,dockQuiet:false,clockMist:false}]};
  imported.ui={...imported.ui,view:'home',mode:'edit',selection:''};imported.guides=[];imported.undo=[];imported.redo=[];delete imported.addonLab;
  mkdirSync(storage+'/snapshots',{recursive:true});writeFileSync(storage+'/snapshots/'+'b'.repeat(32)+'.json',JSON.stringify({id:'b'.repeat(32),name:'Vor TV-Import',created:'2026-11-01',project:before}));
  writeFileSync(storage+'/project.json',JSON.stringify(imported));
  await route.fulfill({json:{version:'0.9.0',sourceMatches:true,etag:createHash('sha256').update(readFileSync(storage+'/project.json')).digest('hex')}});
 });
 await applied(1);await page.click('#mirrorImport');
 await page.waitForFunction(()=>CleanFrameEditor.project.tvSource?.platform==='tizen'&&!document.querySelector('#dialog').open);await ready(page);
 assert.equal(await page.evaluate(()=>document.body.classList.contains('live-mode')),false);
 const preview=await page.evaluate(()=>{const w=CleanFrameEditor.win();return {mode:w.CleanTVMirror?.mode,native:!!w.CleanFrameNative,home:w.ShoreQA.state().committed.home,wall:w.ShoreQA.state().committed.wall,weather:w.CleanFrameAddons.enabled('cleantv-weather')};});
 assert.deepEqual(preview,{mode:'draft',native:false,home,wall:'aw-test',weather:true});
 await page.waitForTimeout(800);assert.deepEqual(await page.evaluate(()=>CleanFrameEditor.project.preferences.home),home,'The Samsung preview keeps imported Home apps');
 assert.equal(await page.evaluate(()=>CleanFrameEditor.project.preferences.wall),'aw-test');
 await page.selectOption('#scenario','paused');assert.equal(await page.evaluate(()=>CleanFrameEditor.win().CleanFrameMock.scenario()),'paused');
 await page.evaluate(()=>{CleanFrameEditor.select('caption');CleanFrameEditor.patch({offsetX:8});});
 await page.waitForFunction(()=>document.querySelector('#saveState').textContent==='Auf diesem Mac gespeichert');
 const saved=JSON.parse(readFileSync(storage+'/project.json','utf8'));assert.equal(saved.tvSource.platform,'tizen');assert.ok(saved.design.rules.some(r=>r.target==='caption'&&r.style.offsetX===8));
 mkdirSync(root+'.local/editor/qa',{recursive:true});await page.screenshot({path:root+'.local/editor/qa/tizen-draft.png'});
 assert.deepEqual(errors,[]);
 console.log('Vom TV übernehmen: Samsung draft with Tizen page, kept Home apps and add-on wallpaper, validated saves.');
 await page.close();
}finally{await app.close();}
