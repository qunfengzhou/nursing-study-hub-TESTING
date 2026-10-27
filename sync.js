/* Nursing Study Hub V3.2 — user-authorized Google Drive appDataFolder sync.
   No API key / client secret; access tokens remain in memory. No silent overwrites.
   Each upload creates an immutable snapshot. Conflicting modifications require an explicit per-record choice.
*/
(() => {
'use strict';
const SCOPE='https://www.googleapis.com/auth/drive.appdata openid email';
const META_KEY='nsh-v32-sync-meta';
const CLIENT_KEY='nsh-v32-oauth-client-id';
const DEVICE_KEY='nsh-v32-device-id';
const PREFIX='nsh-v32-snapshot-';
const empty=()=>({cards:[],questions:[],progress:{},quizHistory:{},settings:{dailyTarget:20},dailyLog:{},retiredCardIds:[]});
const clone=x=>JSON.parse(JSON.stringify(x));
const id=()=>crypto.randomUUID();
let device=localStorage.getItem(DEVICE_KEY);
if(!device){device=id();localStorage.setItem(DEVICE_KEY,device)}
let meta;
try{meta=JSON.parse(localStorage.getItem(META_KEY)||'{}')}catch{meta={}}
meta.seen ||= {};
let token='', tokenExpiry=0, tokenClient=null, email='', busy=false, conflictPending=null, timer=null, autoInterval=null, lastUpload=0;
const $=id=>document.getElementById(id);
function notify(message){const s=$('syncStatus');if(s)s.textContent=message}
function connected(){return !!token && Date.now()<tokenExpiry-60000}
function setButtons(){if($('syncConnect'))$('syncConnect').textContent=connected()?`Connected: ${email||'Google account'}`:'Connect Google Drive';if($('syncNow'))$('syncNow').disabled=!connected()||busy||!!conflictPending;if($('syncDisconnect'))$('syncDisconnect').disabled=!token;if($('syncResolve'))$('syncResolve').classList.toggle('hidden',!conflictPending)}
function persistMeta(){localStorage.setItem(META_KEY,JSON.stringify(meta))}
function normalize(x){return {cards:Array.isArray(x.cards)?x.cards:[],questions:Array.isArray(x.questions)?x.questions:[],progress:x.progress||{},quizHistory:x.quizHistory||{},settings:x.settings||{dailyTarget:20},dailyLog:x.dailyLog||{},retiredCardIds:Array.isArray(x.retiredCardIds)?x.retiredCardIds:[]}}
function current(){const x=normalize(state);const ids=new Set(x.retiredCardIds);x.cards=x.cards.filter(c=>!ids.has(c.id));return x}
function stable(x){if(Array.isArray(x))return '['+x.map(stable).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';return JSON.stringify(x)}
const same=(a,b)=>stable(a)===stable(b);
function toMap(coll){return Object.fromEntries((coll||[]).filter(x=>x?.id).map(x=>[x.id,x]))}
function fromMap(v){return Object.values(v).sort((a,b)=>String(a.id).localeCompare(String(b.id)))}
function fields(x){return {cards:toMap(x.cards),questions:toMap(x.questions),progress:x.progress||{},quizHistory:x.quizHistory||{},settings:x.settings||{},dailyLog:x.dailyLog||{},retiredCardIds:Array.isArray(x.retiredCardIds)?x.retiredCardIds:[]}}
const DEL=Symbol('absent');
function resolve3(base,local,remote,context,conflicts,resolved){
  const out={};
  for(const k of new Set([...Object.keys(base),...Object.keys(local),...Object.keys(remote)])){
    const b=Object.hasOwn(base,k)?base[k]:DEL,l=Object.hasOwn(local,k)?local[k]:DEL,r=Object.hasOwn(remote,k)?remote[k]:DEL;
    const eq=(x,y)=>x===DEL&&y===DEL || x!==DEL&&y!==DEL&&same(x,y);
    const lc=!eq(l,b),rc=!eq(r,b);
    let chosen;
    if(!lc) chosen=r;
    else if(!rc||eq(l,r)) chosen=l;
    else {
      const key=context+'/'+k;
      if(Object.hasOwn(resolved,key))chosen=resolved[key]==='local'?l:r;
      else {conflicts.push({key,local:l===DEL?null:l,remote:r===DEL?null:r}); chosen=l}
    }
    if(chosen!==DEL)out[k]=chosen;
  }
  return out;
}
function merge3(base,local,remote,resolutions={}){
  base=normalize(base);local=normalize(local);remote=normalize(remote);
  const retiredUnion=[...new Set([...(base.retiredCardIds||[]),...(local.retiredCardIds||[]),...(remote.retiredCardIds||[])])];
  base=fields(base);local=fields(local);remote=fields(remote);
  // A retired flashcard is no longer active. Ignore concurrent edits to its content,
  // but keep progress/history and the grow-only retirement register.
  for(const retiredId of retiredUnion){delete base.cards[retiredId];delete local.cards[retiredId];delete remote.cards[retiredId]}
  const issues=[],out={};
  for(const cat of ['cards','questions','progress','quizHistory','settings','dailyLog']){
    // Daily logs contain IDs: preserve any rated-card IDs seen on either device.
    if(cat==='dailyLog'){
      out.dailyLog={};for(const day of new Set([...Object.keys(base.dailyLog),...Object.keys(local.dailyLog),...Object.keys(remote.dailyLog)])){
        out.dailyLog[day]=[...new Set([...(local.dailyLog[day]||[]),...(remote.dailyLog[day]||[])])]
      }
    }else out[cat]=resolve3(base[cat],local[cat],remote[cat],cat,issues,resolutions);
  }
  // Grow-only retirement register. Removing a card on any device prevents stale snapshots resurrecting it.
  out.retiredCardIds=retiredUnion.sort();
  const retired=new Set(out.retiredCardIds);
  out.cards=fromMap(out.cards).filter(card=>!retired.has(card.id));out.questions=fromMap(out.questions);
  return {merged:out,issues};
}
function applyMerged(merged){
  const old=normalize(state);
  if(same(old,merged))return false;
  state={...state,...clone(merged)};
  dailyActive=false;dailyQueue=[];save();render();
  return true;
}
async function loadGIS(){
  if(window.google?.accounts?.oauth2)return;
  if(!navigator.onLine)throw Error('Sign-in requires internet. Offline study remains available.');
  await new Promise((resolve,reject)=>{
    const s=document.createElement('script');s.src='https://accounts.google.com/gsi/client';s.async=true;s.onload=resolve;s.onerror=()=>reject(Error('Unable to load Google sign-in'));document.head.appendChild(s);
  });
}
async function connect(){
  const clientId=($('syncClientId')?.value||'').trim();
  if(!/^\d+-[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)){notify('Enter a valid OAuth Web client ID first.');return}
  localStorage.setItem(CLIENT_KEY,clientId);
  try{
    await loadGIS();
    if(!tokenClient || meta.clientId!==clientId){
      tokenClient=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:SCOPE,callback:async response=>{
        if(response.error){notify('Google authorization failed: '+response.error);return}
        token=response.access_token;tokenExpiry=Date.now()+(response.expires_in||3600)*1000;
        meta.clientId=clientId;
        try{
          const r=await fetch('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{Authorization:'Bearer '+token}});
          if(!r.ok)throw Error('Unable to verify Google account');
          const user=await r.json();email=user.email||'';
          const who=user.sub||email;
          if(meta.account && meta.account!==who){
            // Do not reuse a different account's merge baseline.
            meta={account:who,clientId,seen:{},base:null};
            notify('Different Google account detected. Local data will be reconciled, never replaced silently.');
          }else{meta.account=who;persistMeta()}
          persistMeta();setButtons();notify('Connected. Checking for cloud changes…');await syncNow();
        }catch(e){notify('Connected, but account verification/sync failed: '+e.message)}
      }});
    }
    tokenClient.requestAccessToken({prompt:'consent'});
  }catch(e){notify(e.message)}
}
function disconnect(){const oldToken=token;token='';tokenExpiry=0;email='';if(window.google?.accounts?.oauth2?.revoke&&oldToken)google.accounts.oauth2.revoke(oldToken,()=>{});setButtons();notify('Disconnected. Local study data remains available.');}
async function api(path,options={}){
 if(!connected())throw Error('Google access expired. Click Connect to reauthorize.');
 const res=await fetch(path,{...options,headers:{...(options.headers||{}),Authorization:'Bearer '+token}});
 if(!res.ok){let detail='';try{detail=(await res.json()).error?.message||''}catch{}throw Error(`Drive API ${res.status}: ${detail||res.statusText}`)}
 return res;
}
async function listSnapshots(){
  const all=[];let page='';
  do{
    const params=new URLSearchParams({spaces:'appDataFolder',fields:'nextPageToken,files(id,name,createdTime)',pageSize:'1000'});
    if(page)params.set('pageToken',page);
    const j=await (await api('https://www.googleapis.com/drive/v3/files?'+params)).json();
    all.push(...(j.files||[]).filter(f=>f.name?.startsWith(PREFIX)));page=j.nextPageToken||'';
  }while(page);
  return all.sort((a,b)=>(a.createdTime||'').localeCompare(b.createdTime||''));
}
async function readSnapshot(f){const j=await (await api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}?alt=media`)).json();if(j.schema!==32||!j.device||!j.data)throw Error('Invalid V3.2 cloud snapshot');return j}
async function createSnapshot(snapshot){
  const name=PREFIX+device+'-'+Date.now()+'-'+id()+'.json';
  const boundary='nsh_'+id().replace(/-/g,'');
  const metadata={name,mimeType:'application/json',parents:['appDataFolder']};
  const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(snapshot)}\r\n--${boundary}--`;
  const r=await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body});
  return await r.json();
}
function conflictUI(issues){
  const out=$('syncConflicts');out.replaceChildren();
  const header=document.createElement('p');header.textContent=`${issues.length} conflicting changes detected. Both cloud snapshots are retained. Choose a value per item before merging.`;out.append(header);
  for(const issue of issues){
    const d=document.createElement('div');d.className='fileitem';
    const title=document.createElement('strong');title.textContent=issue.key;
    const s=document.createElement('select');s.dataset.conflict=issue.key;
    for(const [value,label] of [['local','Keep this device'],['remote','Use cloud version']]){const o=document.createElement('option');o.value=value;o.textContent=label;s.append(o)}
    const a=document.createElement('div');a.className='notice';a.textContent='This device: '+JSON.stringify(issue.local).slice(0,230);
    const b=document.createElement('div');b.className='notice';b.textContent='Cloud: '+JSON.stringify(issue.remote).slice(0,230);
    d.append(title,s,a,b);out.append(d);
  }
  $('syncResolve').classList.remove('hidden');
}
function resolveConflicts(){
  if(!conflictPending)return;
  if(!same(current(),conflictPending.localAtStart)){notify('Local data changed during conflict review. Run Sync again.');conflictPending=null;$('syncConflicts').replaceChildren();setButtons();return}
  const resolutions={};document.querySelectorAll('[data-conflict]').forEach(s=>resolutions[s.dataset.conflict]=s.value);
  let proposed=conflictPending.localAtStart;
  for(const task of conflictPending.tasks){const result=merge3(task.base,proposed,task.remote,resolutions);if(result.issues.length){notify('Unresolved conflicts remain.');return}proposed=result.merged}
  const seen=conflictPending.seen;
  conflictPending=null;$('syncConflicts').replaceChildren();$('syncResolve').classList.add('hidden');
  const oldBase=clone(meta.base||empty());applyMerged(proposed);meta.base=oldBase;meta.seen=seen;persistMeta();setButtons();
  notify('Conflicts resolved locally. Uploading combined changes…');syncNow();
}
async function syncNow(){
 if(busy||conflictPending)return;
 if(!navigator.onLine){notify('Offline. Changes are saved locally and will sync after reconnection.');return}
 if(!connected()){notify('Connect Google Drive to enable cloud sync.');setButtons();return}
 busy=true;setButtons();notify('Checking Google Drive…');
 try{
  const files=await listSnapshots();
  const newest=new Map();
  for(const f of files){const m=f.name.match(/^nsh-v32-snapshot-([0-9a-f-]{36})-/);if(m)newest.set(m[1],f)}
  const localAtStart=clone(current());
  let proposed=clone(localAtStart),base=clone(meta.base||empty()),newSeen={...meta.seen};
  const tasks=[],issues=[];
  for(const [dev,f] of newest){
    if(dev===device || newSeen[dev]===f.id)continue;
    const payload=await readSnapshot(f);
    const task={base:clone(base),remote:normalize(payload.data),file:f};
    const m=merge3(task.base,proposed,task.remote);
    tasks.push(task);issues.push(...m.issues);
    proposed=m.merged;newSeen[dev]=f.id;
    // After merging with one device, the result becomes the baseline for the next only if no conflict.
    // Keep original three-way base for concurrent updates from other devices.
  }
  if(issues.length){
    conflictPending={localAtStart,tasks,seen:newSeen};
    conflictUI(issues);notify(`Sync paused: ${issues.length} conflicts. No data was overwritten.`);return;
  }
  if(!same(current(),localAtStart))throw Error('Study data changed during sync. Retry to merge safely.');
  const newRemoteChanges=!same(proposed,localAtStart);
  if(newRemoteChanges)applyMerged(proposed);
  const localUnpublished=!meta.base||!same(localAtStart,meta.base);
  const needPublish=localUnpublished && !newRemoteChanges || (localUnpublished&&newRemoteChanges&&!same(proposed,meta.base));
  // Publication is immutable; concurrent devices never update or replace the same Drive file.
  if(needPublish){
    const payload={schema:32,device,createdAt:new Date().toISOString(),data:clone(proposed)};
    const created=await createSnapshot(payload);newSeen[device]=created.id;lastUpload=Date.now();
  }
  meta.base=clone(proposed);meta.seen=newSeen;persistMeta();
  notify(newRemoteChanges?'Cloud changes merged successfully.':needPublish?'Local changes backed up to Google Drive.':'Everything is up to date.');
 }catch(e){notify('Sync failed; local data is safe. '+e.message)}finally{busy=false;setButtons()}
}
function scheduleSync(){if(!connected()||conflictPending)return;clearTimeout(timer);timer=setTimeout(()=>syncNow(),45000)}
function init(){
 $('syncClientId').value=localStorage.getItem(CLIENT_KEY)||'';
 $('syncConnect').onclick=connect;$('syncDisconnect').onclick=disconnect;$('syncNow').onclick=syncNow;$('syncResolve').onclick=resolveConflicts;
 window.addEventListener('studyhub:changed',scheduleSync);
 window.addEventListener('online',()=>{if(connected())syncNow()});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden && connected())syncNow()});
 autoInterval=setInterval(()=>{if(connected()&&navigator.onLine)syncNow()},120000);
 notify('Offline-first. Connect Google Drive to sync across devices.');setButtons();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
window.__nshSyncTest={normalize,merge3,same};
})();
