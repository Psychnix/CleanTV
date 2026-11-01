/* Live-Spiegel for Samsung TVs. The editor server reads CleanTV's state on the TV (one fixed, read-only
   expression, see scripts/editor-tizen-mirror.js); this module long-polls it while the tab is visible
   and redraws it with the Samsung page in #mirror. No pixels: the TV's inspector sends none. */
const $=id=>document.getElementById(id);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function initMirror(ui){
 const frame=$('mirror');
 let active=false,epoch=0,seq=-1,controller=null,shown=false,boot=null,latest=null;
 // Read synchronously by /editor/tv-mirror.js inside the frame (same origin) before CleanTV starts.
 window.CleanTVMirrorFeed={boot:()=>boot};
 const page=()=>frame.contentWindow;
 function start(){if(active||document.hidden)return;active=true;const id=++epoch;loop(id).catch(error=>{if(id===epoch)ui.problem(error);});}
 function stop(){
  active=false;epoch++;controller?.abort();controller=null;seq=-1;shown=false;boot=null;latest=null;frame.onload=null;
  // Unloading frees the TV data (titles, place) and the page's timers.
  if(frame.getAttribute('src')!=='about:blank')frame.setAttribute('src','about:blank');
 }
 async function loop(id){
  while(active&&id===epoch&&!document.hidden){
   controller=new AbortController();let result;
   try{
    const response=await fetch('/api/editor/tv/mirror?since='+seq,{signal:controller.signal,cache:'no-store'});
    result=await response.json();
    if(!response.ok)throw Error(result.error||'Der Live-Spiegel ist nicht erreichbar.');
   }catch(error){if(id!==epoch)return;ui.problem(error);await wait(2000);continue;}
   if(id!==epoch)return;
   if(result.state){
    latest=result.state;
    try{await show(id);}catch(error){if(id!==epoch)return;ui.problem(error);await wait(2000);continue;}
    if(id!==epoch)return;
   }
   seq=result.seq;ui.phase(result,shown);
   // The server waits for news; this pause only guards against a fast error loop.
   if(!result.state&&result.phase!=='live')await wait(300);
  }
 }
 async function show(id){
  const current=page();
  if(shown&&current?.CleanTVMirror&&!current.CleanTVMirror.needsReload(latest)){current.CleanTVMirror.apply(latest);ui.applied(latest);return;}
  shown=false;boot=latest;
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Der Live-Spiegel lädt nicht.')),15000);
   frame.onload=()=>{if(page()?.location.pathname!=='/home/')return;clearTimeout(timer);resolve();};
   frame.setAttribute('src','/home/?mirror=1'+(latest.legacy?'&legacy=1':'')+'&v='+Date.now());
  });
  for(let i=0;i<200&&id===epoch;i++){const w=page();if(w?.CleanTVMirror&&w.ShoreQA?.ready?.()&&w.CleanFrameDesign?.ready?.())break;await wait(40);}
  if(id!==epoch)return;
  const w=page();
  if(!w?.CleanTVMirror)throw Error('Der Live-Spiegel konnte nicht aufgebaut werden.');
  w.CleanTVMirror.apply(latest);shown=true;ui.applied(latest);
 }
 return {start,stop,get active(){return active;},get shown(){return shown;},get state(){return latest;}};
}
