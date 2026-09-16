// ==UserScript==
// @name         Tixcraft Linked Monitor
// @namespace    local.ticket-monitor.tixcraft
// @version      1.0.0
// @description  拓元單場票區本機監控：多選票區、排除身障票、回報同一筆 Railway 管理頁。只讀票況，不自動購票。
// @match        https://tixcraft.com/ticket/area/*
// @match        https://www.tixcraft.com/ticket/area/*
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
  if (window.top !== window.self) return;

  const VERSION = '1.0.0';
  const LINK_ORIGIN = 'https://ticket-cloud-monitor-production.up.railway.app';
  const rawGM = typeof GM === 'undefined' ? {} : GM;
  const gm = {
    getValue: (k,d) => typeof rawGM.getValue === 'function' ? rawGM.getValue(k,d) : Promise.resolve(GM_getValue(k,d)),
    setValue: (k,v) => typeof rawGM.setValue === 'function' ? rawGM.setValue(k,v) : Promise.resolve(GM_setValue(k,v)),
    request: d => typeof rawGM.xmlHttpRequest === 'function' ? rawGM.xmlHttpRequest(d) : GM_xmlhttpRequest(d)
  };
  const hasGM = (typeof rawGM.getValue === 'function' || typeof GM_getValue === 'function') &&
    (typeof rawGM.setValue === 'function' || typeof GM_setValue === 'function') &&
    (typeof rawGM.xmlHttpRequest === 'function' || typeof GM_xmlhttpRequest === 'function');

  const norm = s => String(s || '').normalize('NFKC').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
  const SOLD = /已售完|售完|售罄|完售|無票|暫無票|sold\s*out/i;
  const FUTURE = /尚未開賣|未開賣|尚未開始|停止售票|販售結束|已結束|sale\s*not\s*started|not\s*on\s*sale/i;
  const REMAIN_ZH = /(?:剩餘|尚有)\s*[:：]?\s*(\d+)\s*(?:張|席|個)?/i;
  const REMAIN_EN = /(\d+)\s*(?:seat\(s\)|seats?)\s*remaining/i;
  const AVAILABLE = /\bavailable\b|可購買|可選購|可售|有票/i;
  const ACCESSIBLE = /身心障礙|身障|輪椅|陪同|愛心席|accessible|wheelchair|companion/i;
  const HOST_ID = 'tcm-tixcraft-root';
  const STORE_PREFIX = 'tcm.tixcraft.settings.';
  const RUN_PREFIX = 'tcm.tixcraft.runtime.';
  const LINK_PREFIX = 'tcm.tixcraft.link.';

  const canonicalURL = href => {
    const u = new URL(href || location.href);
    return `${u.origin}${u.pathname.replace(/\/+$/,'')}${u.search}`;
  };
  const settingURL = canonicalURL();
  const visible = el => {
    if (!el || el.nodeType !== 1 || !el.isConnected || el.closest(`#${HOST_ID},[hidden],[aria-hidden="true"]`)) return false;
    const st = getComputedStyle(el), r = el.getBoundingClientRect();
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0' && r.width > 0 && r.height > 0;
  };
  const txt = el => norm(el?.innerText || el?.textContent || '');
  const priceOf = s => {
    const m = String(s||'').match(/(?:NT\s*\$|NTD|TWD|\$)\s*([\d,]{3,})|([\d,]{3,})\s*元/i);
    return m ? Number((m[1]||m[2]).replace(/,/g,'')) : 0;
  };
  const stateOfText = s => {
    const t = norm(s);
    if (FUTURE.test(t)) return {state:'not_started',reason:'尚未開賣／已停止販售'};
    if (SOLD.test(t)) return {state:'sold',reason:'畫面顯示 Sold out／售完'};
    const m = t.match(REMAIN_ZH) || t.match(REMAIN_EN);
    if (m) return Number(m[1]) > 0 ? {state:'available',reason:`畫面顯示剩餘 ${m[1]} 席`} : {state:'sold',reason:'畫面顯示剩餘 0 席'};
    if (AVAILABLE.test(t)) return {state:'available',reason:'畫面顯示 Available／可售'};
    return {state:'unknown',reason:'目前沒有足夠票況文字'};
  };
  const hash = value => {
    let h=2166136261;
    for (const ch of String(value||'')) { h ^= ch.codePointAt(0); h=Math.imul(h,16777619)>>>0; }
    return h.toString(36);
  };
  const selectorFor = el => {
    const seg=[];
    for (let cur=el,n=0;cur&&cur.nodeType===1&&n<12;n++,cur=cur.parentElement) {
      if (cur.id) { seg.unshift('#'+CSS.escape(cur.id)); break; }
      const tag=cur.tagName.toLowerCase();
      if (tag==='html'||tag==='body') { seg.unshift(tag); break; }
      const peers=cur.parentElement?[...cur.parentElement.children].filter(x=>x.tagName===cur.tagName):[cur];
      seg.unshift(`${tag}:nth-of-type(${peers.indexOf(cur)+1})`);
    }
    return seg.join(' > ');
  };
  const explicitId = el => {
    const a = el.closest?.('a[href]') || el.querySelector?.('a[href]');
    const ctl = el.matches?.('input,button,[data-id],[data-key],[data-area-id]') ? el : el.querySelector?.('input[value],button[value],[data-id],[data-key],[data-area-id]');
    const href = a?.getAttribute('href') || '';
    const parts = [href, el.id, el.getAttribute?.('data-id'), el.getAttribute?.('data-key'), el.getAttribute?.('data-area-id'), el.getAttribute?.('value'),
      ctl?.id, ctl?.getAttribute?.('name'), ctl?.getAttribute?.('value'), ctl?.getAttribute?.('data-id'), ctl?.getAttribute?.('data-key'), ctl?.getAttribute?.('data-area-id')].filter(Boolean);
    return parts.join('|').slice(0,500);
  };
  const cleanLabel = raw => norm(String(raw||'')
    .replace(/\(best available\)/gi,' ')
    .replace(/\b(?:\d+)\s*seat\(s\)\s*remaining\b/gi,' ')
    .replace(/\b(?:\d+)\s*seats?\s*remaining\b/gi,' ')
    .replace(/(?:剩餘|尚有|remaining)\s*[:：]?\s*\d+\s*(?:張|席|個)?/gi,' ')
    .replace(/已售完|售完|售罄|完售|無票|暫無票|sold\s*out|\bavailable\b|可購買|可選購|可售/gi,' ')
    .replace(/(?:NT\s*\$|NTD|TWD|\$)\s*[\d,]{3,}|[\d,]{3,}\s*元/gi,' '));

  function rowFromSeed(seed) {
    let first = seed?.nodeType===1 ? seed : seed?.parentElement;
    if (!first || !visible(first)) return null;
    const path=[];
    for (let el=first,n=0;el&&n<9;n++,el=el.parentElement) {
      if (visible(el) && !el.closest(`#${HOST_ID}`)) path.push(el);
      if (el.matches?.('body')) break;
    }
    let chosen = path.find(el=>{
      const t=txt(el); if (!t || t.length>500) return false;
      return stateOfText(t).state!=='unknown' && cleanLabel(t).length>=2;
    });
    if (!chosen) chosen=path.find(el=>{
      const t=txt(el); if (!t || t.length>500) return false;
      return stateOfText(t).state!=='unknown';
    });
    if (!chosen) chosen=path.find(el=>{
      const t=txt(el); return t.length>=2 && t.length<=260 && /區|GA|看台|票|seat|area/i.test(t);
    }) || path[0];
    if (!chosen) return null;
    const raw=txt(chosen).slice(0,650);
    if (!raw) return null;
    let label=cleanLabel(raw).slice(0,180);
    if (!label) label=raw.slice(0,120);
    const price=priceOf(raw);
    const explicit=explicitId(chosen);
    const key=`tx:${hash(`${explicit||label}|${price}`)}:${price}:${label.replace(/\s+/g,'').slice(0,40)}`;
    const state=stateOfText(raw);
    return {key,label,price,accessible:ACCESSIBLE.test(raw),selector:selectorFor(chosen),explicit,state:state.state,reason:state.reason,preview:raw};
  }

  function scanRows() {
    const seeds=[...document.querySelectorAll('a[href],button,label,li,tr,input[type="radio"],input[type="checkbox"],[role="button"],[data-id],[data-key]')].filter(visible);
    const map=new Map();
    for (const el of seeds) {
      const t=txt(el); if (!t || t.length>650 || stateOfText(t).state==='unknown') continue;
      const row=rowFromSeed(el); if (!row) continue;
      const prev=map.get(row.key);
      if (!prev || row.preview.length<prev.preview.length) map.set(row.key,row);
    }
    return [...map.values()].sort((a,b)=>a.label.localeCompare(b.label,'zh-Hant'));
  }

  function locateSaved(saved) {
    let el=null;
    if (saved.selector) { try { el=document.querySelector(saved.selector); } catch {} }
    if (!el && saved.explicit) {
      const href=saved.explicit.split('|')[0];
      if (href) { try { el=[...document.querySelectorAll('a[href]')].find(a=>a.getAttribute('href')===href || a.href===href) || null; } catch {} }
    }
    if (!el && saved.label) {
      const needle=norm(saved.label).toLowerCase();
      el=[...document.querySelectorAll('a[href],button,label,li,tr,[role="button"],div,span')]
        .find(x=>visible(x) && txt(x).toLowerCase().includes(needle) && txt(x).length<650) || null;
    }
    if (!el) return {key:saved.key,state:'unknown',reason:'重新整理後找不到原票區'};
    const row=rowFromSeed(el);
    if (!row) return {key:saved.key,state:'unknown',reason:'找到票區，但無法讀取票況'};
    return {key:saved.key,state:row.state,reason:row.reason};
  }

  const host=document.createElement('div'); host.id=HOST_ID; host.innerHTML=`
  <style>
  #${HOST_ID}{position:fixed;z-index:2147483647;left:16px;bottom:16px;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#10243d}
  #${HOST_ID} *{box-sizing:border-box}#${HOST_ID} button,#${HOST_ID} input{font:inherit}
  #${HOST_ID} .toggle{border:0;border-radius:14px;padding:12px 16px;background:#0f3a5b;color:#fff;font-weight:700;box-shadow:0 8px 28px #0004}
  #${HOST_ID} .panel{position:fixed;left:16px;bottom:70px;width:min(620px,calc(100vw - 32px));max-height:82vh;overflow:auto;background:#fff;border:1px solid #cbd5e1;border-radius:18px;padding:18px;box-shadow:0 18px 50px #0005}
  #${HOST_ID} .head{display:flex;justify-content:space-between;gap:12px;align-items:center}#${HOST_ID} h2{font-size:20px;margin:0}#${HOST_ID} .ver{font-size:12px;color:#64748b}
  #${HOST_ID} .status{margin:14px 0;padding:12px;border-radius:12px;background:#f1f5f9}#${HOST_ID} .status.running{background:#ecfdf5;border:1px solid #86efac}
  #${HOST_ID} .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}#${HOST_ID} button{padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;cursor:pointer}
  #${HOST_ID} button.good{background:#047857;color:#fff;border-color:#047857}#${HOST_ID} button.danger{background:#b91c1c;color:#fff;border-color:#b91c1c}
  #${HOST_ID} input[type=text]{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:10px}#${HOST_ID} label{display:block;margin:9px 0 5px}
  #${HOST_ID} .small{font-size:13px;color:#64748b}#${HOST_ID} .summary{margin:10px 0;padding:10px;border-radius:10px;background:#eff6ff}
  #${HOST_ID} .tickets{max-height:240px;overflow:auto;border:1px solid #e2e8f0;border-radius:12px;margin-top:8px}#${HOST_ID} .ticket{display:flex;gap:9px;padding:9px 10px;border-bottom:1px solid #eef2f7;align-items:flex-start}#${HOST_ID} .ticket:last-child{border-bottom:0}
  #${HOST_ID} .manager{margin:8px 0}#${HOST_ID} .manage{display:flex;gap:8px;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px dashed #e2e8f0}#${HOST_ID} .manage button{padding:5px 8px}
  #${HOST_ID} details{margin:12px 0}#${HOST_ID} .notice{margin-top:10px;color:#334155}#${HOST_ID} .pick{outline:3px solid #16a34a!important;outline-offset:2px!important}
  </style>
  <button id="tcmTxToggle" class="toggle">拓元監票 · 已停止</button>
  <section id="tcmTxPanel" class="panel" hidden>
    <div class="head"><div><h2>拓元 Tixcraft 本機監控</h2><div class="ver">v${VERSION} · /ticket/area/ 單場頁</div></div><button id="tcmTxCollapse">收合</button></div>
    <div id="tcmTxStatus" class="status">⏹ 已停止</div>
    <div id="tcmTxSummary" class="summary">已選 0 個票區</div>
    <div id="tcmTxManager" class="manager"></div>
    <details open><summary>連到原本的管理頁</summary>
      <label>裝置名稱</label><input id="tcmTxDevice" type="text" value="Windows">
      <label>配對碼</label><input id="tcmTxPair" type="text" placeholder="tcm1....">
      <div class="grid" style="margin-top:8px"><button id="tcmTxConnect">配對</button><button id="tcmTxSync">同步共用設定</button></div>
      <div id="tcmTxLinkState" class="small" style="margin-top:7px">未配對</div>
    </details>
    <div class="grid"><button id="tcmTxScan">讀取票區</button><button id="tcmTxPick">手動多選票區</button><button id="tcmTxAll">全選一般票區</button><button id="tcmTxClear">全部清除</button></div>
    <div id="tcmTxTickets" class="tickets"></div>
    <label><input id="tcmTxExclude" type="checkbox" checked> 排除身障／輪椅／陪同票</label>
    <label><input id="tcmTxVerified" type="checkbox"> 我已核對票區名稱和目前狀態</label>
    <button id="tcmTxSave" style="width:100%;margin-top:8px">儲存票區到管理頁</button>
    <div class="grid" style="margin-top:10px"><button id="tcmTxStart" class="good">開始監控</button><button id="tcmTxStop" class="danger">停止</button></div>
    <div id="tcmTxNotice" class="notice">先配對，再讀取／選擇票區。</div>
  </section>`;
  document.documentElement.appendChild(host);
  const $=id=>host.querySelector('#'+id);

  let settings={selected:[],verified:false,exclude:true};
  let rows=[]; let selected=new Set(); let link=null; let remote=null; let clientId='';
  let runtime={running:false,checks:0,message:'已停止',nextAt:0,runId:''};
  let timer=null, busy=false, pickMode=false; const outlines=new Map();
  const notice=s=>$('tcmTxNotice').textContent=s;
  const stateLabel=s=>s==='available'?'可售':s==='sold'?'售完':s==='not_started'?'未開賣':'不明';
  const uniqueId=()=>Array.from(crypto.getRandomValues(new Uint8Array(18)),n=>n.toString(16).padStart(2,'0')).join('');

  function dedupe(items) { const m=new Map(); for(const r of items||[]) if(r?.key&&!m.has(r.key))m.set(r.key,r); return [...m.values()]; }
  function selectedRows() {
    const map=new Map([...settings.selected,...rows].map(r=>[r.key,r]));
    return dedupe([...selected].map(k=>map.get(k)).filter(Boolean)).filter(r=>!(settings.exclude&&r.accessible));
  }
  function renderStatus() {
    const sec=runtime.running&&runtime.nextAt?Math.max(0,Math.ceil((runtime.nextAt-Date.now())/1000)):null;
    $('tcmTxStatus').textContent=runtime.running?`🟢 監控中 · ${runtime.checks} 次${sec!==null?` · ${sec} 秒後刷新`:''}`:`⏹ ${runtime.message||'已停止'} · ${runtime.checks} 次`;
    $('tcmTxStatus').classList.toggle('running',runtime.running);
    $('tcmTxToggle').textContent=runtime.running?`拓元監票 · 執行中${sec!==null?` · ${sec}秒`:''}`:'拓元監票 · 已停止';
    $('tcmTxStart').disabled=runtime.running; $('tcmTxStop').disabled=!runtime.running;
    $('tcmTxLinkState').textContent=link?`已配對：${remote?.name||'同一筆監控'}`:'未配對';
    renderSummary();
  }
  function renderSummary() {
    const chosen=selectedRows();
    $('tcmTxSummary').textContent=chosen.length?`已選 ${chosen.length} 個：${chosen.map(r=>r.label).join('、')}`:'已選 0 個票區';
    const box=$('tcmTxManager'); box.replaceChildren();
    for(const r of chosen){
      const d=document.createElement('div');d.className='manage';const s=document.createElement('span');s.textContent=r.label;
      const b=document.createElement('button');b.textContent='刪除';b.onclick=async()=>{selected.delete(r.key);settings.selected=settings.selected.filter(x=>x.key!==r.key);settings.verified=false;$('tcmTxVerified').checked=false;await saveLocal();renderRows();notice(`已刪除：${r.label}`)};
      d.append(s,b);box.appendChild(d);
    }
  }
  function renderRows() {
    const box=$('tcmTxTickets');box.replaceChildren();
    if(!rows.length){const p=document.createElement('div');p.className='small';p.style.padding='10px';p.textContent='尚未讀到票區；可按「手動多選票區」。';box.appendChild(p);renderSummary();return;}
    for(const r of rows){
      const lab=document.createElement('label');lab.className='ticket';const c=document.createElement('input');c.type='checkbox';c.checked=selected.has(r.key);c.disabled=runtime.running||(settings.exclude&&r.accessible);
      const s=document.createElement('span');s.textContent=`${r.label}${r.price?` · $${r.price.toLocaleString()}`:''}｜${stateLabel(r.state)}${r.accessible?' · 特殊席':''}`;
      c.onchange=async()=>{if(c.checked)selected.add(r.key);else selected.delete(r.key);settings.verified=false;$('tcmTxVerified').checked=false;await saveLocal();renderSummary();notice(`${c.checked?'已加入':'已取消'}：${r.label}`)};
      lab.append(c,s);box.appendChild(lab);
    }
    renderSummary();
  }
  async function saveLocal(){settings.selected=selectedRows();settings.exclude=$('tcmTxExclude').checked;settings.verified=$('tcmTxVerified').checked;await gm.setValue(STORE_PREFIX+settingURL,settings);}
  async function saveRuntime(){await gm.setValue(RUN_PREFIX+settingURL,runtime);}

  function gmPost(url,body,token=''){
    return new Promise((resolve,reject)=>{
      let done=false;const finish=(e,v)=>{if(done)return;done=true;clearTimeout(guard);e?reject(e):resolve(v)};const guard=setTimeout(()=>finish(Error('管理頁回應逾時')),20000);
      try{const req=gm.request({method:'POST',url,timeout:15000,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},data:JSON.stringify(body),onload:r=>{let j={};try{j=JSON.parse(r.responseText||r.response||'{}')}catch{};if(r.status<200||r.status>=300)return finish(Error(j.error||`HTTP ${r.status}`));finish(null,j)},onerror:()=>finish(Error('無法連到管理頁')),ontimeout:()=>finish(Error('管理頁回應逾時'))});if(req?.catch)req.catch(e=>finish(Error(String(e))))}catch(e){finish(e)}
    });
  }
  async function relay(action,extra={}){
    if(!link)throw Error('請先配對管理頁。');
    const body={action,monitorId:link.id,url:settingURL,clientId,deviceName:$('tcmTxDevice').value.trim().slice(0,40)||'Browser',runId:runtime.runId,...extra};
    return gmPost(LINK_ORIGIN+'/api/local',body,link.token);
  }
  function parsePair(code){
    if(!code.startsWith('tcm1.'))throw Error('請貼完整 tcm1. 配對碼');
    let v;try{const e=code.slice(5).replace(/-/g,'+').replace(/_/g,'/');v=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(e),c=>c.charCodeAt(0))))}catch{throw Error('配對碼格式不正確')}
    if(v.v!==1||v.origin!==LINK_ORIGIN||!/^[A-Za-z0-9_-]{43}$/.test(v.token||''))throw Error('配對碼不正確');
    if(canonicalURL(v.url)!==settingURL)throw Error('這組配對碼不是目前這個拓元單場頁');
    return v;
  }
  function applyRemote(cfg,replace=true){
    remote=cfg;
    if(replace&&Array.isArray(cfg.selected)&&cfg.selected.length){settings.selected=dedupe(cfg.selected);selected=new Set(settings.selected.map(x=>x.key));rows=settings.selected.map(x=>({...x,state:'unknown',reason:'等待本機頁面確認'}));}
    if(typeof cfg.exclude==='boolean'){settings.exclude=cfg.exclude;$('tcmTxExclude').checked=cfg.exclude;}
    renderRows();renderStatus();
  }

  async function configure(){
    settings.exclude=$('tcmTxExclude').checked;settings.verified=$('tcmTxVerified').checked;settings.selected=selectedRows();
    if(!settings.selected.length)throw Error('請至少選一個票區。');
    if(!settings.verified)throw Error('請先勾選「我已核對票區名稱和目前狀態」。');
    const cfg=await relay('configure',{selected:settings.selected.map(r=>({key:r.key,label:r.label,price:Number(r.price)||0,accessible:!!r.accessible,selector:r.selector||''})),verified:true});
    applyRemote(cfg,false);await saveLocal();return cfg;
  }
  function snapshot(){return settings.selected.map(locateSaved);}
  async function waitSnapshot(){
    for(let i=0;i<30;i++){
      const out=snapshot();if(out.length&&out.every(x=>['available','sold','not_started'].includes(x.state)))return out;
      await new Promise(r=>setTimeout(r,500));
    }
    return snapshot();
  }
  function clearTimer(){if(timer){clearTimeout(timer);timer=null}}
  function delayMs(){
    const mode=remote?.mode||'random';const min=Math.max(1,Number(remote?.min)||1),max=Math.max(min,Number(remote?.max)||5),fixed=Math.max(1,Number(remote?.fixed)||5);
    return 1000*(mode==='fixed'?fixed:min+Math.floor(Math.random()*(max-min+1)));
  }
  async function halt(msg='已停止',send=true){
    clearTimer();runtime.running=false;runtime.nextAt=0;runtime.message=msg;await saveRuntime();renderStatus();
    if(send&&link){try{await relay('release')}catch{}}
  }
  async function cycle(){
    if(!runtime.running||busy)return;if(document.hidden){runtime.message='分頁不在前景，暫停刷新';renderStatus();return;}
    busy=true;
    try{
      const hb=await relay('heartbeat',{nextAt:null});remote=hb;if(!hb.running){await halt('管理頁已停止',false);return;}
      const rowsNow=await waitSnapshot();
      if(!rowsNow.length||rowsNow.some(x=>!['available','sold','not_started'].includes(x.state))){await halt('無法完整確認指定票區；已停止，並不代表售完');return;}
      const ack=await relay('report',{nonce:uniqueId(),rows:rowsNow});runtime.checks++;
      if(!ack.running){runtime.running=false;runtime.nextAt=0;runtime.message=ack.state==='detected'?'已偵測到可售票區':'管理頁已停止';await saveRuntime();renderStatus();return;}
      const ms=delayMs();runtime.nextAt=Date.now()+ms;runtime.message='監控中';await saveRuntime();renderStatus();
      timer=setTimeout(async()=>{if(!runtime.running||document.hidden)return;await saveRuntime();location.reload()},ms);
    }catch(e){await halt('錯誤停止：'+(e?.message||e),false);notice(e?.message||String(e));}
    finally{busy=false}
  }
  async function start(){
    if(!link)throw Error('請先配對管理頁。');
    await configure();
    const cfg=await relay('begin');remote=cfg;runtime.runId=cfg.runId;runtime.running=true;runtime.nextAt=0;runtime.message='監控中';await saveRuntime();renderStatus();notice('監控已開始。');await cycle();
  }

  function beginPick(){
    if(runtime.running)throw Error('請先停止監控再修改票區。');
    pickMode=true;notice('手動多選中：直接點票區文字／Sold out／remaining。再點一次同票區會取消；完成後按左下角按鈕。');$('tcmTxPanel').hidden=true;$('tcmTxToggle').textContent=`已選 ${selected.size} 個｜點我完成`;
  }
  function endPick(){pickMode=false;for(const [el,old] of outlines){el.style.outline=old}outlines.clear();$('tcmTxPanel').hidden=false;renderRows();notice(`手動多選完成，目前 ${selected.size} 個票區。`)}
  async function toggleManual(target){
    const row=rowFromSeed(target);if(!row)return notice('這個位置沒有辨識到票區文字。');
    const exists=selected.has(row.key);if(exists){selected.delete(row.key);settings.selected=settings.selected.filter(x=>x.key!==row.key)}else{selected.add(row.key);settings.selected=dedupe([...settings.selected,row]);rows=dedupe([...rows,row]);}
    settings.verified=false;$('tcmTxVerified').checked=false;await saveLocal();$('tcmTxToggle').textContent=`已選 ${selected.size} 個｜點我完成`;
    const el=target.nodeType===1?target:target.parentElement;if(el&&!outlines.has(el)){outlines.set(el,el.style.outline||'');el.style.outline=exists?'':'3px solid #16a34a'}
  }

  $('tcmTxToggle').onclick=()=>{if(pickMode)return endPick();$('tcmTxPanel').hidden=!$('tcmTxPanel').hidden};
  $('tcmTxCollapse').onclick=()=>$('tcmTxPanel').hidden=true;
  $('tcmTxConnect').onclick=async()=>{try{if(runtime.running)throw Error('請先停止監控。');const v=parsePair($('tcmTxPair').value.trim());link={...v};const cfg=await relay('sync');await gm.setValue(LINK_PREFIX+settingURL,link);$('tcmTxPair').value='';applyRemote(cfg,true);notice('配對完成。請讀取或手動選票區。')}catch(e){notice('配對失敗：'+e.message)}};
  $('tcmTxSync').onclick=async()=>{try{const cfg=await relay('sync');applyRemote(cfg,true);await saveLocal();notice('已同步管理頁設定。')}catch(e){notice(e.message)}};
  $('tcmTxScan').onclick=async()=>{if(runtime.running)return notice('請先停止監控。');rows=scanRows();const saved=new Map(settings.selected.map(r=>[r.key,r]));for(const r of rows)if(saved.has(r.key))Object.assign(r,saved.get(r.key));renderRows();notice(rows.length?`讀到 ${rows.length} 個可辨識票區。`:'目前沒有自動辨識到票區，請用手動多選。')};
  $('tcmTxPick').onclick=()=>{try{beginPick()}catch(e){notice(e.message)}};
  $('tcmTxAll').onclick=async()=>{if(runtime.running)return notice('請先停止監控。');if(!rows.length)rows=scanRows();selected=new Set(rows.filter(r=>!($('tcmTxExclude').checked&&r.accessible)).map(r=>r.key));settings.selected=selectedRows();settings.verified=false;$('tcmTxVerified').checked=false;await saveLocal();renderRows();notice(`已選 ${selected.size} 個一般票區。`)};
  $('tcmTxClear').onclick=async()=>{if(runtime.running)return notice('請先停止監控。');selected.clear();settings.selected=[];settings.verified=false;$('tcmTxVerified').checked=false;await saveLocal();renderRows();notice('已清除全部票區。')};
  $('tcmTxExclude').onchange=async()=>{settings.exclude=$('tcmTxExclude').checked;if(settings.exclude){for(const r of selectedRows())if(r.accessible)selected.delete(r.key)}settings.verified=false;$('tcmTxVerified').checked=false;await saveLocal();renderRows()};
  $('tcmTxVerified').onchange=async()=>{settings.verified=$('tcmTxVerified').checked;await saveLocal();notice(settings.verified?'已核對目前票區。':'已取消核對。')};
  $('tcmTxSave').onclick=async()=>{try{await configure();notice('票區已儲存到管理頁。')}catch(e){notice('儲存失敗：'+e.message)}};
  $('tcmTxStart').onclick=async()=>{try{await start()}catch(e){notice('開始失敗：'+e.message);await halt('未啟動：'+e.message,false)}};
  $('tcmTxStop').onclick=()=>halt('已手動停止').then(()=>notice('已停止，不會再自動重新整理。'));

  window.addEventListener('pointerdown',e=>{
    const path=typeof e.composedPath==='function'?e.composedPath():[];if(path.includes(host))return;
    if(pickMode){e.preventDefault();e.stopImmediatePropagation();toggleManual(path.find(n=>n?.nodeType===1)||e.target).catch(x=>notice(x.message));}
    else if(runtime.running){halt('你開始操作售票頁，已停止刷新').catch(()=>{})}
  },true);
  document.addEventListener('visibilitychange',()=>{if(!runtime.running)return;clearTimer();if(document.hidden){runtime.message='分頁不在前景，暫停刷新';renderStatus()}else cycle()});

  if(!hasGM){notice('Tampermonkey / Userscripts 權限不完整，請重新安裝腳本。');$('tcmTxStart').disabled=true;return;}
  (async()=>{
    clientId=await gm.getValue('tcm.clientId','');if(!clientId){clientId=uniqueId();await gm.setValue('tcm.clientId',clientId)}
    settings={...settings,...(await gm.getValue(STORE_PREFIX+settingURL,null)||{})};settings.selected=dedupe(settings.selected||[]);selected=new Set(settings.selected.map(r=>r.key));
    link=await gm.getValue(LINK_PREFIX+settingURL,null);const savedRun=await gm.getValue(RUN_PREFIX+settingURL,null);if(savedRun)runtime={...runtime,...savedRun,nextAt:0};
    $('tcmTxExclude').checked=settings.exclude!==false;$('tcmTxVerified').checked=!!settings.verified;rows=settings.selected.map(r=>({...r,state:'unknown',reason:'等待頁面確認'}));renderRows();
    if(link){try{const cfg=await relay('sync');applyRemote(cfg,true);runtime.runId=cfg.runId||runtime.runId;if(runtime.running&&cfg.running){runtime.message='監控中：頁面重新載入，正在確認票區…';await saveRuntime();renderStatus();cycle()}else if(runtime.running&&!cfg.running){runtime.running=false;runtime.message='管理頁目前已停止';await saveRuntime();renderStatus()}}catch(e){notice('管理頁同步失敗：'+e.message)}}
    renderStatus();setInterval(renderStatus,500);
  })().catch(e=>notice('初始化失敗：'+e.message));
})();
