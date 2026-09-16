// ==UserScript==
// @name         Universal Linked Web Monitor
// @namespace    local.ticket-monitor.universal
// @version      4.0.2
// @description  單一通用網頁監控：只在管理頁已建立並登記的網址顯示；智慧整頁、指定區域、指定文字，自動雲端→本機接手。
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      ticket-cloud-monitor-production.up.railway.app
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = '4.0.2';
  const MANAGER_HOST = 'ticket-cloud-monitor-production.up.railway.app';
  const BRIDGE_ID = 'tcm-universal-manager-bridge';
  const ROOT_ID = 'tcm-universal-root';
  const LINKS_KEY = 'tcm.universal.links.v1';
  const CLIENT_KEY = 'tcm.universal.client.v1';
  const rawGM = typeof GM === 'undefined' ? {} : GM;
  const gm = {
    getValue: (k,d) => typeof rawGM.getValue === 'function' ? rawGM.getValue(k,d) : Promise.resolve(GM_getValue(k,d)),
    setValue: (k,v) => typeof rawGM.setValue === 'function' ? rawGM.setValue(k,v) : Promise.resolve(GM_setValue(k,v)),
    request: d => typeof rawGM.xmlHttpRequest === 'function' ? rawGM.xmlHttpRequest(d) : GM_xmlhttpRequest(d)
  };
  const hasGM = (typeof rawGM.getValue === 'function' || typeof GM_getValue === 'function') &&
    (typeof rawGM.setValue === 'function' || typeof GM_setValue === 'function') &&
    (typeof rawGM.xmlHttpRequest === 'function' || typeof GM_xmlhttpRequest === 'function');

  const norm = v => String(v || '').normalize('NFKC').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
  const canonical = href => {
    const u = new URL(href || location.href);
    u.hash = '';
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/,'');
    return u.toString();
  };
  const hash = value => {
    let h=2166136261;
    for (const ch of String(value||'')) { h ^= ch.codePointAt(0); h=Math.imul(h,16777619)>>>0; }
    return h.toString(36);
  };
  const stableText = value => norm(value)
    .replace(/\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g,'<time>')
    .replace(/\b\d+\s*(?:秒|分鐘|小時|seconds?|minutes?|hours?)\s*(?:前|ago)?\b/gi,'<relative-time>')
    .replace(/\b[a-f0-9]{24,}\b/gi,'<token>')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g,'<token>')
    .slice(0,120000);
  const visible = el => {
    if (!el || el.nodeType !== 1 || !el.isConnected || el.closest(`#${ROOT_ID},[hidden],[aria-hidden="true"]`)) return false;
    const st=getComputedStyle(el), r=el.getBoundingClientRect();
    return st.display!=='none' && st.visibility!=='hidden' && st.opacity!=='0' && r.width>0 && r.height>0;
  };
  const selectorFor = el => {
    const seg=[];
    for (let cur=el,n=0;cur&&cur.nodeType===1&&n<14;n++,cur=cur.parentElement) {
      if (cur.id && !/^tcm-/.test(cur.id)) { seg.unshift('#'+CSS.escape(cur.id)); break; }
      const tag=cur.tagName.toLowerCase();
      if (tag==='html'||tag==='body') { seg.unshift(tag); break; }
      const peers=cur.parentElement?[...cur.parentElement.children].filter(x=>x.tagName===cur.tagName):[cur];
      seg.unshift(`${tag}:nth-of-type(${peers.indexOf(cur)+1})`);
    }
    return seg.join(' > ');
  };
  const purchaseControls = () => [...document.querySelectorAll('button,a,input[type="button"],input[type="submit"],select')]
    .filter(visible).slice(0,600).map(el => ({
      text:norm(el.innerText||el.value||el.getAttribute('aria-label')||''),
      disabled:!!el.disabled || el.getAttribute('aria-disabled')==='true' || !!el.closest('[aria-disabled="true"],.disabled'),
      href:(el.href||'').replace(/[?#].*$/,'')
    }));
  const pageSnapshotBase = () => {
    const text=stableText(document.body?.innerText||'');
    const controls=purchaseControls().map(x=>[x.text.slice(0,140),x.disabled,x.href.slice(0,180)]);
    const sold=(text.match(/已售完|售罄|完售|sold\s*out|缺貨|庫存不足|補貨中/gi)||[]).length;
    const stock=[...text.matchAll(/(?:庫存(?:量)?|剩餘(?:數量|票數)?|餘票|可售(?:數量)?|stock|remaining)\s*[:：]?\s*(\d+)/gi)].map(m=>Number(m[1])).filter(Number.isFinite);
    const buy=controls.filter(x=>!x[1] && /購買|立即購買|加入購物車|選購|報名|buy|order|register/i.test(`${x[0]} ${x[2]}`)).length;
    const sig=hash(`${text}\n${JSON.stringify(controls)}`);
    return {sig, summary:`售完/缺貨 ${sold} 處；庫存數字 ${stock.length?stock.join('、'):'未找到'}；可購買控制項 ${buy} 個`};
  };
  const elementSnapshot = el => {
    const text=stableText(el?.innerText||el?.textContent||el?.value||'');
    const disabled=!!el?.disabled || el?.getAttribute?.('aria-disabled')==='true' || !!el?.closest?.('[aria-disabled="true"],.disabled');
    return {text, sig:hash(`${text}|${disabled?'disabled':'enabled'}|${visible(el)?'visible':'hidden'}`), disabled, visible:visible(el)};
  };

  // Generic iframe bridge. It stays invisible and dormant until a registered top page
  // asks for a snapshot or starts region-pick mode. This lets Ticket Plus and other
  // iframe-based sites use the same universal script instead of a dedicated script.
  function setupFrameBridge(){
    let framePickMode=false;
    const sendTop=msg=>{try{window.top.postMessage({__tcmUniversalBridge:1,...msg},'*')}catch{}};
    const broadcastChildren=msg=>{for(const f of document.querySelectorAll('iframe')){try{f.contentWindow?.postMessage({__tcmUniversalBridge:1,...msg},'*')}catch{}}};
    const pickItem=seed=>{
      const first=seed?.nodeType===1?seed:seed?.parentElement;if(!first||!visible(first))return null;
      const path=[];for(let el=first,n=0;el&&n<9;n++,el=el.parentElement){if(visible(el))path.push(el);if(el.matches?.('body'))break;}
      const chosen=path.find(el=>{const t=stableText(el.innerText||el.textContent||'');return t.length>=2&&t.length<=500;})||path[0];
      if(!chosen)return null;
      const snap=elementSnapshot(chosen), selector=selectorFor(chosen);if(!selector||!snap.text)return null;
      return {key:`region:${hash(`${canonical()}|${selector}`)}`,label:snap.text.slice(0,100),kind:'region',selector,frameUrl:canonical(),condition:'changes',value:'',threshold:0,baseline:snap.sig};
    };
    window.addEventListener('message',e=>{
      const d=e.data;if(!d||d.__tcmUniversalBridge!==1)return;
      if(d.type==='pick-mode'){framePickMode=!!d.active;broadcastChildren(d);return;}
      if(d.type==='page-snapshot-request'){
        const snap=pageSnapshotBase();
        sendTop({type:'page-snapshot-response',requestId:d.requestId,frameUrl:canonical(),sig:snap.sig,summary:snap.summary,text:stableText(document.body?.innerText||'').slice(0,30000)});
        broadcastChildren(d);return;
      }
      if(d.type==='region-snapshot-request'){
        const here=canonical();const rows=[];
        for(const t of Array.isArray(d.items)?d.items:[]){
          if(!t?.key||!t.selector||canonical(t.frameUrl||here)!==here)continue;
          let el=null;try{el=document.querySelector(t.selector)}catch{}
          if(!el){rows.push({key:t.key,state:'missing',matched:false,current:'',reason:'iframe 內找不到原本指定區域'});continue;}
          const snap=elementSnapshot(el);let matched=false,reason='';
          if(t.condition==='changes'){matched=!!t.baseline&&snap.sig!==t.baseline;reason=matched?'指定區域內容已改變':'指定區域未改變';}
          else if(t.condition==='enabled'){matched=!snap.disabled;reason=matched?'控制項目前可用':'控制項目前不可用';}
          else if(t.condition==='visible'){matched=snap.visible;reason=matched?'指定區域目前可見':'指定區域目前不可見';}
          else if(t.condition==='contains'){matched=snap.text.includes(t.value||'');reason=matched?'指定文字已出現':'指定文字尚未出現';}
          else if(t.condition==='not_contains'){matched=!snap.text.includes(t.value||'');reason=matched?'指定文字已消失':'指定文字仍存在';}
          else if(t.condition==='number_gt'){const nums=[...snap.text.matchAll(/-?[\d,.]+/g)].map(m=>Number(m[0].replace(/,/g,''))).filter(Number.isFinite);const n=nums[0];matched=Number.isFinite(n)&&n>Number(t.threshold||0);reason=Number.isFinite(n)?`目前數字 ${n}`:'沒有找到數字';}
          else {matched=!!t.baseline&&snap.sig!==t.baseline;reason=matched?'內容已改變':'內容未改變';}
          rows.push({key:t.key,state:'ok',matched,current:snap.text.slice(0,500),reason});
        }
        if(rows.length)sendTop({type:'region-snapshot-response',requestId:d.requestId,rows});
        broadcastChildren(d);
      }
    });
    window.addEventListener('pointerdown',e=>{
      if(!framePickMode)return;const path=typeof e.composedPath==='function'?e.composedPath():[];const target=path.find(n=>n?.nodeType===1)||e.target;const item=pickItem(target);if(!item)return;
      e.preventDefault();e.stopImmediatePropagation();framePickMode=false;sendTop({type:'region-pick',item});
    },true);
    sendTop({type:'frame-ready',frameUrl:canonical()});
  }
  if(window.top!==window.self){setupFrameBridge();return;}
  const randomId = () => {
    const a=new Uint8Array(18);crypto.getRandomValues(a);return [...a].map(x=>x.toString(16).padStart(2,'0')).join('');
  };
  const normalizePairData = d => {
    if(d?.v!==1 || !d.id || !d.token || !d.origin || !d.url) throw Error('配對資料不完整');
    const origin=new URL(d.origin);
    const target=new URL(d.url);
    if(origin.protocol!=='https:' || origin.hostname!==MANAGER_HOST) throw Error('只接受你的 Railway 管理頁登記');
    if(!['http:','https:'].includes(target.protocol) || target.username || target.password) throw Error('監控網址格式不正確');
    if(!/^[A-Za-z0-9_-]{43}$/.test(String(d.token))) throw Error('配對權杖格式不正確');
    return {id:String(d.id),token:String(d.token),origin:origin.origin,url:canonical(target.toString())};
  };
  const decodePair = code => {
    const raw=String(code||'').trim();
    if(!raw.startsWith('tcm1.')) throw Error('配對碼格式不正確');
    let b=raw.slice(5).replace(/-/g,'+').replace(/_/g,'/');while(b.length%4)b+='=';
    const bytes=Uint8Array.from(atob(b),c=>c.charCodeAt(0));
    return normalizePairData(JSON.parse(new TextDecoder().decode(bytes)));
  };
  const api = (link, payload) => new Promise((resolve,reject)=>{
    gm.request({
      method:'POST', url:`${link.origin}/api/local`, timeout:12000,
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${link.token}`},
      data:JSON.stringify({...payload,monitorId:link.id,url:link.url}),
      onload:r=>{let j={};try{j=JSON.parse(r.responseText||'{}')}catch{};if(r.status>=200&&r.status<300)resolve(j);else reject(Error(j.error||`HTTP ${r.status}`));},
      onerror:()=>reject(Error('無法連到管理頁')), ontimeout:()=>reject(Error('管理頁連線逾時'))
    });
  });

  let links=[];
  let link=null;
  let cfg=null;
  let clientId='';
  let busy=false;
  let pickMode=false;
  let reloadTimer=null;
  let pollTimer=null;
  let sessionStarted=false;
  let shadow=null;
  let els={};
  let lastStatus='尚未配對';
  const framePageWaiters=new Map();
  const frameRegionWaiters=new Map();
  const broadcastFrames=msg=>{for(const f of document.querySelectorAll('iframe')){try{f.contentWindow?.postMessage({__tcmUniversalBridge:1,...msg},'*')}catch{}}};
  window.addEventListener('message',e=>{
    const d=e.data;if(!d||d.__tcmUniversalBridge!==1)return;
    if(d.type==='frame-ready'&&pickMode){try{e.source?.postMessage({__tcmUniversalBridge:1,type:'pick-mode',active:true},'*')}catch{}return;}
    if(d.type==='region-pick'&&pickMode){pickMode=false;broadcastFrames({type:'pick-mode',active:false});addRegionItem(d.item);render();return;}
    if(d.type==='page-snapshot-response'&&d.requestId&&framePageWaiters.has(d.requestId)){framePageWaiters.get(d.requestId).push(d);return;}
    if(d.type==='region-snapshot-response'&&d.requestId&&frameRegionWaiters.has(d.requestId)){const map=frameRegionWaiters.get(d.requestId);for(const row of d.rows||[])map.set(row.key,row);}
  });
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  async function requestFramePageSnapshots(){
    if(!document.querySelector('iframe'))return [];const requestId=`pg-${Date.now()}-${Math.random().toString(16).slice(2)}`;const rows=[];framePageWaiters.set(requestId,rows);broadcastFrames({type:'page-snapshot-request',requestId});await sleep(280);framePageWaiters.delete(requestId);return rows;
  }
  async function requestFrameRegionSnapshots(items){
    const wanted=(items||[]).filter(t=>t.frameUrl&&canonical(t.frameUrl)!==canonical());if(!wanted.length)return new Map();const requestId=`rg-${Date.now()}-${Math.random().toString(16).slice(2)}`;const map=new Map();frameRegionWaiters.set(requestId,map);broadcastFrames({type:'region-snapshot-request',requestId,items:wanted});await sleep(300);frameRegionWaiters.delete(requestId);return map;
  }
  async function pageSnapshot(){
    const top=pageSnapshotBase(), frames=await requestFramePageSnapshots();
    const parts=frames.map(x=>`${x.frameUrl}|${x.sig}`).sort();
    return {sig:hash(`${top.sig}\n${parts.join('\n')}`),summary:`${top.summary}${frames.length?`；iframe ${frames.length} 個`:''}`,text:[stableText(document.body?.innerText||''),...frames.map(x=>x.text||'')].join(' ')};
  }

  const saveLinks = () => gm.setValue(LINKS_KEY,links);
  const currentLink = () => {
    const here=canonical();
    return links.find(x=>canonical(x.url)===here) || null;
  };
  const replyManager = (requestId, ok, extra={}) => {
    window.postMessage({source:'tcm-universal-userscript-v1',type:'result',requestId,ok,...extra},location.origin);
  };
  async function registerPairData(raw){
    const candidate=normalizePairData(raw);
    links=links.filter(x=>x.id!==candidate.id && canonical(x.url)!==candidate.url);
    links.push(candidate);
    await saveLinks();
    return candidate;
  }
  function installManagerBridge(){
    if(location.protocol!=='https:' || location.hostname!==MANAGER_HOST) return false;
    if(!document.getElementById(BRIDGE_ID)){
      const marker=document.createElement('meta');marker.id=BRIDGE_ID;marker.dataset.version=VERSION;(document.head||document.documentElement).appendChild(marker);
    }
    window.addEventListener('message',async e=>{
      if(e.source!==window || e.origin!==location.origin) return;
      const d=e.data;if(!d || d.source!=='tcm-manager-page-v1') return;
      const requestId=String(d.requestId||'');
      try{
        if(d.type==='register'){
          const candidate=await registerPairData(d.payload);
          replyManager(requestId,true,{id:candidate.id,url:candidate.url,version:VERSION});
          return;
        }
        if(d.type==='sync-registry'){
          const items=Array.isArray(d.items)?d.items:[];
          const allowed=new Map();
          for(const item of items){
            if(!item?.id || !item?.url || !['auto','browser'].includes(String(item.execution||''))) continue;
            try{allowed.set(String(item.id),canonical(item.url));}catch{}
          }
          const before=links.length;
          links=links.filter(x=>allowed.get(String(x.id))===canonical(x.url));
          if(links.length!==before) await saveLinks();
          replyManager(requestId,true,{registered:links.length,version:VERSION});
        }
      }catch(err){replyManager(requestId,false,{error:String(err?.message||err)});}
    });
    window.postMessage({source:'tcm-universal-userscript-v1',type:'ready',version:VERSION},location.origin);
    return true;
  }
  async function forgetCurrentLink(){
    if(!link)return;
    links=links.filter(x=>x.id!==link.id);
    await saveLinks();
    link=null;
  }
  const setStatus = (text,kind='') => {
    lastStatus=text;
    if(els.status){els.status.textContent=text;els.status.dataset.kind=kind;}
    render();
  };
  const intervalMs = c => {
    if(!c) return 10000;
    if(c.mode==='fixed') return Math.max(1000,Number(c.fixed||5)*1000);
    const min=Math.max(1,Number(c.min||1)), max=Math.max(min,Number(c.max||5));
    return (Math.floor(Math.random()*(max-min+1))+min)*1000;
  };
  const defaultPageSelection = async () => {
    const snap=await pageSnapshot();
    return [{key:`page:${hash(canonical())}`,label:'智慧整頁',kind:'page',selector:'',frameUrl:canonical(),condition:'page_auto',value:'',threshold:0,baseline:`v2:${snap.sig}`}];
  };
  async function configure(selected){
    if(!link) throw Error('尚未配對');
    const j=await api(link,{action:'configure',clientId,selected,verified:true});cfg=j;render();return j;
  }
  async function ensureDefaultSelection(){
    if(!cfg?.selected?.length){
      cfg=await configure(await defaultPageSelection());
      setStatus('已建立「智慧整頁」基準；雲端需要本機時會自動接手。','ok');
    }
  }
  async function pair(code){
    const candidate=decodePair(code);
    if(canonical(candidate.url)!==canonical()) throw Error(`請在配對網址本身操作。\n配對網址：${candidate.url}`);
    await registerPairData(candidate);link=candidate;cfg=await api(link,{action:'sync',clientId});
    await ensureDefaultSelection();
    setStatus('配對完成；目前預設監控整個網頁。','ok');
  }
  async function sync(){
    if(!link || busy)return;
    try{
      cfg=await api(link,{action:'sync',clientId});render();
      if(cfg.localRequested && cfg.running && document.visibilityState==='visible' && !sessionStarted) await ensureRunning();
    }catch(e){
      if(/配對已失效|Invalid pairing token|HTTP 401/i.test(String(e.message||''))){
        await forgetCurrentLink();
        clearInterval(pollTimer);
        document.getElementById(ROOT_ID)?.remove();
        return;
      }
      setStatus(`同步失敗：${e.message}`,'error');
    }
  }
  async function evaluateTarget(t,frameRegions=null){
    if(t.condition==='page_auto'){
      if(String(t.baseline||'').startsWith('v2:')){
        const snap=await pageSnapshot();const base=String(t.baseline).slice(3);
        return {key:t.key,state:'ok',matched:!!base&&snap.sig!==base,current:snap.summary,reason:snap.sig!==base?'智慧整頁內容已改變':'與建立基準時相同'};
      }
      const snap=pageSnapshotBase();
      return {key:t.key,state:'ok',matched:!!t.baseline&&snap.sig!==t.baseline,current:snap.summary,reason:snap.sig!==t.baseline?'智慧整頁內容已改變':'與建立基準時相同'};
    }
    if(t.kind==='text'){
      const snap=await pageSnapshot();const body=snap.text||'';const has=!!t.value&&body.includes(t.value);
      const matched=t.condition==='appears'?has:t.condition==='disappears'?!has:t.condition==='not_contains'?!has:has;
      return {key:t.key,state:'ok',matched,current:has?'文字存在':'文字不存在',reason:`「${t.value}」${has?'存在':'不存在'}`};
    }
    if(t.frameUrl&&canonical(t.frameUrl)!==canonical()){
      return frameRegions?.get(t.key)||{key:t.key,state:'missing',matched:false,current:'',reason:'iframe 內找不到原本指定區域'};
    }
    let el=null;try{el=document.querySelector(t.selector)}catch{}
    if(!el)return {key:t.key,state:'missing',matched:false,current:'',reason:'找不到原本指定的頁面區域'};
    const snap=elementSnapshot(el);let matched=false,reason='';
    if(t.condition==='changes'){matched=!!t.baseline&&snap.sig!==t.baseline;reason=matched?'指定區域內容已改變':'指定區域未改變';}
    else if(t.condition==='enabled'){matched=!snap.disabled;reason=matched?'控制項目前可用':'控制項目前不可用';}
    else if(t.condition==='visible'){matched=snap.visible;reason=matched?'指定區域目前可見':'指定區域目前不可見';}
    else if(t.condition==='contains'){matched=snap.text.includes(t.value||'');reason=matched?'指定文字已出現':'指定文字尚未出現';}
    else if(t.condition==='not_contains'){matched=!snap.text.includes(t.value||'');reason=matched?'指定文字已消失':'指定文字仍存在';}
    else if(t.condition==='number_gt'){
      const nums=[...snap.text.matchAll(/-?[\d,.]+/g)].map(m=>Number(m[0].replace(/,/g,''))).filter(Number.isFinite);const n=nums[0];matched=Number.isFinite(n)&&n>Number(t.threshold||0);reason=Number.isFinite(n)?`目前數字 ${n}`:'沒有找到數字';
    } else {matched=!!t.baseline&&snap.sig!==t.baseline;reason=matched?'內容已改變':'內容未改變';}
    return {key:t.key,state:'ok',matched,current:snap.text.slice(0,500),reason};
  }
  async function performCheck(){
    if(!link||!cfg?.selected?.length||busy||document.visibilityState!=='visible')return;
    busy=true;clearTimeout(reloadTimer);
    try{
      const frameRegions=await requestFrameRegionSnapshots(cfg.selected);
      const rows=await Promise.all(cfg.selected.map(t=>evaluateTarget(t,frameRegions)));
      const runId=cfg.runId;
      cfg=await api(link,{action:'report',clientId,runId,nonce:randomId(),rows});
      const hit=rows.find(x=>x.matched);
      setStatus(hit?`已偵測到變化：${hit.reason}`:`已檢查 ${rows.length} 個目標，尚未符合通知條件。`,hit?'hit':'ok');
      if(cfg.running && cfg.localRequested){
        const delay=intervalMs(cfg);
        reloadTimer=setTimeout(()=>{if(document.visibilityState==='visible')location.reload();},delay);
      }
    }catch(e){setStatus(`本機檢查失敗：${e.message}`,'error');}
    finally{busy=false;render();}
  }
  async function ensureRunning(){
    if(!link||busy||!cfg?.localRequested||!cfg?.running||document.visibilityState!=='visible')return;
    busy=true;
    try{
      await ensureDefaultSelection();
      cfg=await api(link,{action:'begin',clientId,deviceName:navigator.platform||'Browser'});
      sessionStarted=true;
      setStatus(`🖥 本機已接手：${cfg.fallbackReason||'本機模式'}`,'ok');
    }catch(e){setStatus(`無法接手：${e.message}`,'error');busy=false;return;}
    busy=false;
    setTimeout(performCheck,700);
  }
  async function forceTakeover(){
    if(!link)return setStatus('請先配對','error');
    try{
      if(!cfg)cfg=await api(link,{action:'sync',clientId});
      await ensureDefaultSelection();
      cfg=await api(link,{action:'begin',clientId,deviceName:navigator.platform||'Browser'});
      sessionStarted=true;
      setStatus('已要求由本機接手。','ok');setTimeout(performCheck,500);
    }catch(e){setStatus(e.message,'error');}
  }
  async function stopLocal(){
    if(!link||!cfg)return;
    clearTimeout(reloadTimer);sessionStarted=false;
    try{cfg=await api(link,{action:'release',clientId,runId:cfg.runId});setStatus('已停止這筆監控。','');}
    catch(e){setStatus(e.message,'error');}
  }

  function addRegionItem(item){
    if(!item?.key||!item?.label)return;
    const current=(cfg?.selected||[]).filter(x=>x.condition!=='page_auto');
    const idx=current.findIndex(x=>x.key===item.key);if(idx>=0)current[idx]=item;else current.push(item);
    configure(current).then(()=>setStatus(`已加入指定區域：${item.label}`,'ok')).catch(e=>setStatus(e.message,'error'));
  }
  function addRegion(el){
    const sel=selectorFor(el);const snap=elementSnapshot(el);if(!sel||!snap.text)return;
    addRegionItem({key:`region:${hash(`${canonical()}|${sel}`)}`,label:snap.text.slice(0,100)||el.tagName,kind:'region',selector:sel,frameUrl:canonical(),condition:'changes',value:'',threshold:0,baseline:snap.sig});
  }
  function beginPick(){
    pickMode=true;broadcastFrames({type:'pick-mode',active:true});setStatus(`選取模式：請直接點要監控的區塊（支援主頁與 iframe；目前 ${document.querySelectorAll('iframe').length} 個 iframe）。`,'ok');render();
  }
  function cancelPick(){pickMode=false;broadcastFrames({type:'pick-mode',active:false});render();}
  function installPickerListener(){
    document.addEventListener('pointerdown',e=>{
      if(!pickMode || e.composedPath().some(x=>x?.id===ROOT_ID))return;
      const el=e.target?.nodeType===1?e.target:e.target?.parentElement;if(!el||!visible(el))return;
      e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();pickMode=false;broadcastFrames({type:'pick-mode',active:false});addRegion(el);render();
    },true);
  }

  async function saveTextRule(){
    const value=norm(els.textValue?.value||'');if(!value)return setStatus('請輸入要監控的文字','error');
    const condition=els.textCondition?.value||'appears';
    const item={key:`text:${hash(`${condition}|${value}`)}`,label:`文字：${value.slice(0,60)}`,kind:'text',selector:'',frameUrl:canonical(),condition,value,threshold:0,baseline:''};
    try{cfg=await configure([item]);setStatus('已改成指定文字監控。','ok');}catch(e){setStatus(e.message,'error');}
  }
  async function setWholePage(){
    try{cfg=await configure(await defaultPageSelection());setStatus('已重新建立智慧整頁基準。','ok');}catch(e){setStatus(e.message,'error');}
  }
  async function deleteTarget(key){
    let remain=(cfg?.selected||[]).filter(x=>x.key!==key);
    if(!remain.length)remain=await defaultPageSelection();
    try{cfg=await configure(remain);setStatus(remain[0]?.condition==='page_auto'?'已回到智慧整頁監控。':'已刪除監控目標。','ok');}catch(e){setStatus(e.message,'error');}
  }

  function render(){
    if(!shadow)return;
    const paired=!!link;
    if(els.version)els.version.textContent=`V${VERSION}`;
    if(els.status)els.status.textContent=lastStatus;
    if(els.pairState)els.pairState.textContent=paired?`已登記監控：${cfg?.name||link.id.slice(0,8)}`:'';
    if(els.exec)els.exec.textContent=!paired?'—':cfg?.localRequested?(cfg?.running?'🖥 本機接手中':'等待本機開始'):(cfg?.running?'☁️ 雲端執行中，本機待命':'已停止');
    if(els.targets){
      const rows=cfg?.selected||[];
      els.targets.innerHTML=rows.length?rows.map(t=>`<div class="target"><span>${escapeHtml(t.label||t.key)}<small>${escapeHtml(({page_auto:'智慧整頁',changes:'區域變化',appears:'文字出現',disappears:'文字消失',enabled:'可用時',visible:'出現時'}[t.condition]||t.condition||''))}</small></span><button data-del="${escapeHtml(t.key)}">刪除</button></div>`).join(''):'<div class="muted">尚未設定，配對後會自動建立智慧整頁基準。</div>';
      els.targets.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>deleteTarget(b.dataset.del));
    }
    if(els.pick)els.pick.textContent=pickMode?'取消選取':'指定頁面區域';
    if(els.takeover)els.takeover.disabled=!paired||!!busy;
    if(els.stop)els.stop.disabled=!paired||!cfg?.running;
  }
  const escapeHtml=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

  function buildUI(){
    const host=document.createElement('div');host.id=ROOT_ID;host.style.cssText='position:fixed;left:12px;bottom:12px;z-index:2147483647;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';document.documentElement.appendChild(host);
    shadow=host.attachShadow({mode:'open'});
    shadow.innerHTML=`<style>
      *{box-sizing:border-box}button,input,select{font:inherit}.toggle{border:0;border-radius:999px;background:#111;color:#fff;padding:10px 14px;box-shadow:0 4px 18px #0004;cursor:pointer}.panel{display:none;width:min(380px,calc(100vw - 24px));max-height:78vh;overflow:auto;margin-bottom:8px;background:#fff;color:#111;border:1px solid #bbb;border-radius:16px;padding:14px;box-shadow:0 10px 35px #0005}.panel.open{display:block}.head{display:flex;justify-content:space-between;gap:8px;align-items:center}.head strong{font-size:16px}.ver,.muted,small{font-size:12px;color:#666}.status{margin:10px 0;padding:9px;border-radius:9px;background:#f2f2f2;font-size:13px;overflow-wrap:anywhere}.status[data-kind="error"]{background:#ffecec;color:#8b1d1d}.status[data-kind="hit"]{background:#fff0d5;color:#7b4300}.status[data-kind="ok"]{background:#edf8ef;color:#185e28}.row{display:flex;gap:8px;align-items:center;margin:8px 0}.row>*{min-width:0}.row input,.row select{flex:1;border:1px solid #bbb;border-radius:8px;padding:8px}.btns{display:flex;flex-wrap:wrap;gap:6px}.btns button,.target button{border:1px solid #aaa;background:#f7f7f7;border-radius:8px;padding:7px 9px;cursor:pointer}.primary{background:#111!important;color:#fff!important}.target{display:flex;gap:8px;justify-content:space-between;align-items:flex-start;padding:7px 0;border-bottom:1px solid #eee}.target span{min-width:0;overflow-wrap:anywhere}.target small{display:block;margin-top:2px}.section{border-top:1px solid #ddd;margin-top:12px;padding-top:10px}label{font-size:12px;color:#555;display:block;margin-bottom:4px}</style>
      <div class="panel" id="panel"><div class="head"><strong>🔔 網頁監控</strong><span class="ver" id="version"></span></div><div class="muted" id="pairState"></div><div class="muted">執行：<span id="exec">—</span></div><div class="status" id="status"></div>
      <div class="section"><label>監控目標</label><div id="targets"></div><div class="btns" style="margin-top:8px"><button id="whole" class="primary">智慧整頁</button><button id="pick">指定頁面區域</button></div></div>
      <div class="section"><label>或改成指定文字</label><div class="row"><input id="textValue" placeholder="例如：售罄 / 加入購物車"></div><div class="row"><select id="textCondition"><option value="appears">文字出現時通知</option><option value="disappears">文字消失時通知</option></select><button id="textSave">套用</button></div></div>
      <div class="section btns"><button id="takeover">本機立即接手</button><button id="sync">立即同步</button><button id="stop">停止監控</button></div><div class="muted" style="margin-top:8px">這個面板只會出現在管理頁已建立並登記的網址。自動模式平常由 Railway 執行；遇到 403／驗證／登入限制或連續抓取失敗時，本分頁才接手。腳本不會自動購買。</div></div>
      <button class="toggle" id="toggle">網頁監控</button>`;
    for(const id of ['panel','version','pairState','exec','status','targets','whole','pick','textValue','textCondition','textSave','takeover','sync','stop','toggle'])els[id]=shadow.getElementById(id);
    els.toggle.onclick=()=>els.panel.classList.toggle('open');
    els.whole.onclick=setWholePage;els.pick.onclick=()=>pickMode?cancelPick():beginPick();els.textSave.onclick=saveTextRule;els.takeover.onclick=forceTakeover;els.sync.onclick=sync;els.stop.onclick=stopLocal;
    render();
  }

  function installLifecycle(){
    document.addEventListener('visibilitychange',async()=>{
      if(!link||!cfg?.running||!cfg.localRequested)return;
      clearTimeout(reloadTimer);
      if(document.visibilityState==='hidden'){
        sessionStarted=false;
        try{cfg=await api(link,{action:'suspend',clientId,runId:cfg.runId});setStatus('分頁在背景，本機刷新已暫停。','');}catch{}
      } else {try{cfg=await api(link,{action:'sync',clientId});await ensureRunning();}catch{}}
    });
    window.addEventListener('beforeunload',()=>clearInterval(pollTimer));
  }
  async function init(){
    if(!hasGM)return;
    links=await gm.getValue(LINKS_KEY,[]);if(!Array.isArray(links))links=[];
    clientId=await gm.getValue(CLIENT_KEY,'');if(!/^[a-f0-9]{36}$/.test(clientId)){clientId=randomId();await gm.setValue(CLIENT_KEY,clientId);}
    if(location.protocol==='https:' && location.hostname===MANAGER_HOST){installManagerBridge();return;}
    link=currentLink();
    if(!link) return; // 未在管理頁建立／登記的網址：完全不顯示面板，也不啟動監控事件。
    buildUI();installPickerListener();installLifecycle();
    try{cfg=await api(link,{action:'sync',clientId});await ensureDefaultSelection();setStatus(cfg.localRequested?'已登記；等待／執行本機接手。':'已登記；目前由雲端執行，本機待命。','ok');}
    catch(e){setStatus(`同步失敗：${e.message}`,'error');}
    render();
    pollTimer=setInterval(sync,4000);
    if(cfg?.localRequested&&cfg?.running)ensureRunning();
  }
  init();
})();
