const $ = s => document.querySelector(s);
const monitorsEl = $('#monitors');
let editingId = null;
let tpStages = [];
let tpTickets = [];
let tpSelectedStage = null;
let txStages = [];
let txTickets = [];
let txSelectedStage = null;
const busyActions = new Set();

function formData(){
  const mode = document.querySelector('input[name="intervalMode"]:checked')?.value || 'random';
  return {
    name: $('#name').value.trim(), url: $('#url').value.trim(), execution:$('#execution').value,
    intervalMode: mode, fixedSeconds:+$('#fixedSeconds').value,
    minSeconds:+$('#minSeconds').value, maxSeconds:+$('#maxSeconds').value,
    limitedTime: $('#limitedTime').checked, startTime:$('#startTime').value, endTime:$('#endTime').value,
    detectionMode: $('#detectionMode').value, watchText: $('#watchText').value, watchCondition:$('#watchCondition').value,
    ntfyTopic: $('#ntfyTopic').value.trim(),
    ticketplusStage: tpSelectedStage,
    ticketplusTicketKeys: [...document.querySelectorAll('input[name="tpTicket"]:checked')].map(x=>x.value),
    excludeAccessible: $('#excludeAccessible')?.checked ?? true,
    tixcraftStage: txSelectedStage,
    tixcraftTicketKeys: [...document.querySelectorAll('input[name="txTicket"]:checked')].map(x=>x.value)
  };
}

function fillForm(m){
  editingId = m.id;
  $('#execution').value=m.execution||'cloud';
  $('#name').value=m.name||''; $('#url').value=m.url||'';
  document.querySelector(`input[name="intervalMode"][value="${m.intervalMode||'random'}"]`).checked=true;
  $('#fixedSeconds').value=m.fixedSeconds||5; $('#minSeconds').value=m.minSeconds||1; $('#maxSeconds').value=m.maxSeconds||5;
  $('#limitedTime').checked=!!m.limitedTime; $('#startTime').value=m.startTime||'11:55'; $('#endTime').value=m.endTime||'12:30';
  $('#detectionMode').value=m.detectionMode||'auto'; $('#watchText').value=m.watchText||'已售完'; $('#watchCondition').value=m.watchCondition||'disappears'; $('#ntfyTopic').value=m.ntfyTopic||''; updateCustomRule();
  tpSelectedStage=m.ticketplusStage||null; tpStages=tpSelectedStage?[tpSelectedStage]:[]; tpTickets=(m.ticketplusTicketKeys||[]).map(k=>({key:k,name:k,state:'saved'}));
  txSelectedStage=m.tixcraftStage||null; txStages=txSelectedStage?[txSelectedStage]:[]; txTickets=(m.tixcraftTicketKeys||[]).map(k=>({key:k,name:k,state:'saved'}));
  if($('#excludeAccessible')) $('#excludeAccessible').checked=m.excludeAccessible!==false; updateTicketplusPanel(); updateTixcraftPanel(); renderTpStages(); renderTpTickets(m.ticketplusTicketKeys||[]); renderTxStages(); renderTxTickets(m.tixcraftTicketKeys||[]);
  $('#save').textContent='更新監控'; $('#cancelEdit').hidden=false;
  window.scrollTo({top:0,behavior:'smooth'});
}

function resetForm(){
  $('#execution').value='cloud';$('#localHint').hidden=true;
  editingId=null; $('#name').value=''; $('#url').value='';
  document.querySelector('input[name="intervalMode"][value="random"]').checked=true;
  $('#fixedSeconds').value=5; $('#minSeconds').value=1; $('#maxSeconds').value=5;
  $('#detectionMode').value='auto'; updateCustomRule(); $('#save').textContent='新增監控'; $('#cancelEdit').hidden=true;
  tpStages=[];tpTickets=[];tpSelectedStage=null;txStages=[];txTickets=[];txSelectedStage=null;if($('#excludeAccessible'))$('#excludeAccessible').checked=true;updateTicketplusPanel();updateTixcraftPanel();renderTpStages();renderTxStages();
}

async function api(url, opts={}){
  const r=await fetch(url,{cache:'no-store',headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) { const e=new Error(j.error||`HTTP ${r.status}`); e.details=j; throw e; }
  return j;
}

function siteName(t){return ({kham:'寬宏',kktix:'KKTIX',avex:'AVEX',tixcraft:'拓元',ibon:'ibon',ticketplus:'Ticket Plus',generic:'通用'})[t]||t}
function detectionName(m){
  if(m.execution==='browser')return '本機票種狀態';
  if(m.siteType!=='generic') return '網站自動判斷';
  return ({auto:'自動判斷',soldout:'售完/缺貨解除',stock:'庫存/剩餘 > 0',custom:'自訂文字'})[m.detectionMode||'auto']||'自動判斷';
}

function isTicketplusUrl(v){try{return new URL(v).hostname.toLowerCase().includes('ticketplus.com.tw')}catch{return false}}
function isTicketplusOrderUrl(v){try{return isTicketplusUrl(v)&&new URL(v).pathname.startsWith('/order/')}catch{return false}}
function updateTicketplusPanel(){const box=$('#ticketplusSetup');if(!box)return;const url=$('#url').value.trim(),isTp=isTicketplusUrl(url),isOrder=isTicketplusOrderUrl(url);box.hidden=!isTp;const stageBtn=$('#tpLoadStages'),diagBtn=$('#tpDiagnoseOrder'),area=$('#tpStageArea');if(stageBtn)stageBtn.hidden=isOrder;if(diagBtn)diagBtn.hidden=!isOrder;if(isOrder&&area)area.textContent='這是 Ticket Plus 單場 /order/ 網址，可直接按「診斷／讀取單場頁」。'}
function isTixcraftUrl(v){try{return new URL(v).hostname.toLowerCase().includes('tixcraft.com')}catch{return false}}
function updateTixcraftPanel(){const box=$('#tixcraftSetup');if(!box)return;box.hidden=!isTixcraftUrl($('#url').value.trim())}
$('#url')?.addEventListener('input',()=>{
  const url=$('#url').value.trim();updateTicketplusPanel();updateTixcraftPanel();
  if(!isTicketplusUrl(url)){tpStages=[];tpTickets=[];tpSelectedStage=null;renderTpStages();}
  if(!isTixcraftUrl(url)){txStages=[];txTickets=[];txSelectedStage=null;renderTxStages();}
});

function showTicketplusOrderDiagnostic(d){
  const dialog=$('#diagnosticDialog'), content=$('#diagnosticContent'), title=$('#diagnosticTitle');
  if(!dialog)return alert('請一併更新 public/index.html');
  if(title)title.textContent='Ticket Plus 單場頁診斷';
  const cls=({restricted:'驗證／限制頁',login_required:'需要登入',ticket_page:'票種頁',unknown:'無法辨識'})[d.classification]||d.classification;
  const rows=(d.tickets||[]).map(t=>`${t.accessible?'♿ ':''}${t.name}〔${t.state||'unknown'}〕`).join('\n');
  content.innerHTML=`<p><strong>${escapeHtml(d.message||'')}</strong></p>
    <div class="statusgrid"><span>HTTP</span><strong>${escapeHtml(d.status)}</strong><span>判斷</span><strong>${escapeHtml(cls)}</strong><span>頁面標題</span><strong>${escapeHtml(d.title||'—')}</strong><span>最後網址</span><strong>${escapeHtml(d.finalUrl||'—')}</strong></div>
    <h3>抓到的票種</h3><pre>${escapeHtml(rows||'目前沒有辨識到票種')}</pre>
    ${d.screenshotDataUrl?`<h3>Railway 實際看到的畫面</h3><img class="diagnostic-image" src="${d.screenshotDataUrl}" alt="Ticket Plus diagnostic screenshot">`:''}
    <details><summary>頁面文字</summary><pre>${escapeHtml(d.textPreview||'—')}</pre></details>`;
  if(!dialog.open)dialog.showModal();
}
$('#tpDiagnoseOrder')?.addEventListener('click',async()=>{
  const url=$('#url').value.trim();if(!isTicketplusOrderUrl(url))return alert('請貼 Ticket Plus /order/ 單場網址');
  const b=$('#tpDiagnoseOrder');b.disabled=true;b.textContent='讀取中…';
  try{const d=await api('/api/ticketplus/diagnose-order',{method:'POST',body:JSON.stringify({url})});tpSelectedStage=null;tpTickets=d.tickets||[];renderTpTickets();showTicketplusOrderDiagnostic(d);}
  catch(e){alert(e.message)}finally{b.disabled=false;b.textContent='診斷／讀取單場頁'}
});

function renderTpStages(){
  const area=$('#tpStageArea'), btn=$('#tpLoadTickets'), tickets=$('#tpTicketArea'); if(!area)return;
  if(!tpStages.length){area.innerHTML='貼上 Ticket Plus 活動網址後按「讀取場次」。'; if(btn)btn.hidden=true;if(tickets)tickets.innerHTML='';return}
  area.innerHTML='<strong>選擇場次：</strong>'+tpStages.map((x,i)=>`<label class="row" style="align-items:flex-start"><input type="radio" name="tpStage" value="${i}" ${tpSelectedStage&&JSON.stringify(tpSelectedStage)===JSON.stringify(x)?'checked':''}/> <span>${escapeHtml(x.label||`場次 ${i+1}`)}</span></label>`).join('');
  area.querySelectorAll('input[name="tpStage"]').forEach(r=>r.addEventListener('change',()=>{tpSelectedStage=tpStages[Number(r.value)];tpTickets=[];renderTpTickets();if(btn)btn.hidden=false}));
  if(btn)btn.hidden=!tpSelectedStage;
}
function renderTpTickets(selectedKeys=[]){
  const area=$('#tpTicketArea');if(!area)return;
  if(!tpTickets.length){area.innerHTML='';return}
  const selected=new Set(selectedKeys);
  area.innerHTML='<strong>票種（可多選；全不選＝全部一般票）：</strong>'+tpTickets.map((t,i)=>`<label class="row" style="align-items:flex-start"><input type="checkbox" name="tpTicket" value="${escapeHtml(t.key)}" ${selected.has(t.key)?'checked':''}/> <span>${t.accessible?'♿ ':''}${escapeHtml(t.name||t.price||`票種 ${i+1}`)} <small>〔${escapeHtml(t.state||'unknown')}〕</small></span></label>`).join('');
}
$('#tpLoadStages')?.addEventListener('click',async()=>{
  const url=$('#url').value.trim(); if(!isTicketplusUrl(url))return alert('請先貼 Ticket Plus 活動網址');
  const b=$('#tpLoadStages');b.disabled=true;b.textContent='讀取中…';
  try{const j=await api('/api/ticketplus/stages',{method:'POST',body:JSON.stringify({url})});tpStages=j.stages||[];tpSelectedStage=null;tpTickets=[];renderTpStages();if(!tpStages.length)alert('目前沒有抓到可選場次，可能活動尚未開放或頁面結構需要再調整。');}
  catch(e){alert(e.message)}finally{b.disabled=false;b.textContent='讀取場次'}
});
$('#tpLoadTickets')?.addEventListener('click',async()=>{
  if(!tpSelectedStage)return alert('請先選場次');const b=$('#tpLoadTickets');b.disabled=true;b.textContent='讀取中…';
  try{const j=await api('/api/ticketplus/tickets',{method:'POST',body:JSON.stringify({url:$('#url').value.trim(),stage:tpSelectedStage})});tpTickets=j.tickets||[];renderTpTickets();if(!tpTickets.length)alert('場次已開啟，但目前沒有辨識到票種。可能尚未開賣，或需要再調整 Ticket Plus 規則。');}
  catch(e){alert(e.message)}finally{b.disabled=false;b.textContent='讀取這個場次的票種'}
});



function renderTxStages(){
  const area=$('#txStageArea'), btn=$('#txLoadTickets'), tickets=$('#txTicketArea'); if(!area)return;
  if(!txStages.length){area.innerHTML='貼上拓元活動網址後按「讀取場次」。'; if(btn)btn.hidden=true;if(tickets)tickets.innerHTML='';return}
  area.innerHTML='<strong>選擇場次：</strong>'+txStages.map((x,i)=>`<label class="row" style="align-items:flex-start"><input type="radio" name="txStage" value="${i}" ${txSelectedStage&&JSON.stringify(txSelectedStage)===JSON.stringify(x)?'checked':''}/> <span>${escapeHtml(x.label||`場次 ${i+1}`)}</span></label>`).join('');
  area.querySelectorAll('input[name="txStage"]').forEach(r=>r.addEventListener('change',()=>{txSelectedStage=txStages[Number(r.value)];txTickets=[];renderTxTickets();if(btn)btn.hidden=false}));
  if(btn)btn.hidden=!txSelectedStage;
}
function renderTxTickets(selectedKeys=[]){
  const area=$('#txTicketArea');if(!area)return;
  if(!txTickets.length){area.innerHTML='';return}
  const selected=new Set(selectedKeys);
  area.innerHTML='<strong>票種／票區（可多選；全不選＝全部一般票）：</strong>'+txTickets.map((t,i)=>`<label class="row" style="align-items:flex-start"><input type="checkbox" name="txTicket" value="${escapeHtml(t.key)}" ${selected.has(t.key)?'checked':''}/> <span>${t.accessible?'♿ ':''}${escapeHtml(t.name||t.price||`票種 ${i+1}`)} <small>〔${escapeHtml(t.state||'unknown')}〕</small></span></label>`).join('');
}
$('#txLoadStages')?.addEventListener('click',async()=>{
  const url=$('#url').value.trim(); if(!isTixcraftUrl(url))return alert('請先貼拓元活動網址');
  const b=$('#txLoadStages');b.disabled=true;b.textContent='讀取中…';
  try{const j=await api('/api/tixcraft/stages',{method:'POST',body:JSON.stringify({url})});txStages=j.stages||[];txSelectedStage=null;txTickets=[];renderTxStages();if(!txStages.length)alert('目前沒有抓到可選場次，可能活動尚未開放或頁面結構需要再調整。');}
  catch(e){alert(e.message)}finally{b.disabled=false;b.textContent='讀取場次'}
});
$('#txLoadTickets')?.addEventListener('click',async()=>{
  if(!txSelectedStage)return alert('請先選場次');const b=$('#txLoadTickets');b.disabled=true;b.textContent='讀取中…';
  try{const j=await api('/api/tixcraft/tickets',{method:'POST',body:JSON.stringify({url:$('#url').value.trim(),stage:txSelectedStage})});txTickets=j.tickets||[];renderTxTickets();if(!txTickets.length)alert('場次已開啟，但目前沒有辨識到票種／票區。可能尚未開賣、需要登入，或拓元頁面結構需要再調整。');}
  catch(e){alert(e.message)}finally{b.disabled=false;b.textContent='讀取這個場次的票種'}
});

function updateCustomRule(){ $('#customRule').hidden = $('#detectionMode').value !== 'custom'; }
$('#detectionMode').addEventListener('change', updateCustomRule);
updateCustomRule();
function stateName(m){
  if(m.state==='local_active')return '🖥 本機回報中';
  if(m.state==='waiting_device')return '等待本機／前景分頁';
  if(m.detectedAt) return '🚨 已偵測到變化';
  if(m.state==='paused') return '⏸ 已暫停（請看錯誤原因）';
  if(m.state==='checking') return '檢查中';
  if(m.state==='waiting') return '等待監控時段';
  if(m.running) return '監控中';
  return '已停止';
}
function nextText(m){if(m.state==='checking')return '檢查中';if(!m.nextAt)return '—'; const s=Math.max(0,Math.ceil((m.nextAt-Date.now())/1000));return `${s} 秒後`}

function render(ms){
  if(!ms.length){monitorsEl.innerHTML='<div class="card empty">目前還沒有監控。上面貼網址後新增即可。</div>';return}
  monitorsEl.innerHTML=ms.map(m=>`<section class="card monitor ${m.detectedAt?'detected':''} ${m.state==='error'||m.state==='paused'?'error':''}">
    <div class="top"><div><strong>${escapeHtml(m.name)}</strong><div class="site">${siteName(m.siteType)}</div></div><span class="pill">${stateName(m)}</span></div>
    <div class="statusgrid">
      <span>網址</span><strong>${escapeHtml(m.url)}</strong>
      <span>執行位置</span><strong>${m.execution==='browser'?'本機瀏覽器（非 Railway 抓取）':'雲端 Railway'}</strong>
      ${m.execution==='browser'?`<span>裝置</span><strong>${escapeHtml(m.localDeviceName||'未連線')} ${m.localOnline?'（最近 60 秒內有回報）':'（未回報或已停止）'}</strong><span>裝置回報</span><strong>${escapeHtml(localTime(m.localSeenAt))}</strong><span>本機票種</span><strong>${escapeHtml((m.localSelection||[]).map(t=>t.label).join('、')||'等待在售票頁選擇')}</strong>`:''}
      <span>頻率</span><strong>${m.intervalMode==='fixed'?`每 ${m.fixedSeconds} 秒`:`隨機 ${m.minSeconds}～${m.maxSeconds} 秒`}</strong>
      <span>判斷</span><strong>${detectionName(m)}</strong>
      ${m.siteType==='ticketplus'&&m.execution!=='browser'?`<span>場次</span><strong>${escapeHtml(m.ticketplusStage?.label||'未選擇')}</strong><span>票種</span><strong>${m.ticketplusTicketKeys?.length?`${m.ticketplusTicketKeys.length} 個指定票種`:'全部一般票種'}${m.excludeAccessible!==false?'（排除身障票）':''}</strong>`:''}
      ${m.siteType==='tixcraft'?`<span>場次</span><strong>${escapeHtml(m.tixcraftStage?.label||'未選擇')}</strong><span>票種</span><strong>${m.tixcraftTicketKeys?.length?`${m.tixcraftTicketKeys.length} 個指定票種`:'全部一般票種'}${m.excludeAccessible!==false?'（排除身障票）':''}</strong>`:''}
      <span>最後檢查</span><strong>${m.lastCheck||'—'}</strong>
      <span>下次檢查</span><strong class="next" data-id="${m.id}">${nextText(m)}</strong>
      <span>結果</span><strong>${escapeHtml(m.lastResult||'—')}</strong>
      <span>檢查次數</span><strong>${m.checks||0}</strong>
      <span>錯誤</span><strong>${escapeHtml(m.lastError||'—')}</strong>
    </div>
    <div class="monitor-actions">
      <button data-act="${m.running?'stop':'start'}" data-id="${m.id}" class="${m.running?'danger':'good'}">${m.running?'停止':'開始'}</button>
      <button data-act="test" data-id="${m.id}" class="secondary" ${m.running||m.execution==='browser'?'disabled':''}>測試抓取</button>
      <button data-act="notify" data-id="${m.id}" class="secondary">測試通知</button>
      ${m.siteType==='kktix'?`<button data-act="diagnostic" data-id="${m.id}" class="secondary">檢視抓取畫面</button>`:''}
      ${m.siteType==='ticketplus'&&isTicketplusOrderUrl(m.url)?`<button data-act="pair" data-id="${m.id}" class="secondary" ${m.running?'disabled':''}>配對電腦 / SE2</button>`:''}
      <button data-act="edit" data-id="${m.id}" class="secondary">編輯</button>
      <button data-act="delete" data-id="${m.id}" class="secondary">刪除</button>
    </div>
  </section>`).join('');
  monitorsEl.querySelectorAll('button[data-id]').forEach(b=>{if(busyActions.has(b.dataset.id)) b.disabled=true});
}
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}

let cache=[];
monitorsEl.innerHTML='<div class="card empty">正在載入監控…</div>';
let loading=false;
async function load(){
  if(loading)return;
  loading=true;
  try{
    cache=await api('/api/monitors');render(cache);
    const status=$('#loadStatus');if(status)status.textContent='';
  }catch(error){
    const status=$('#loadStatus');if(status)status.textContent=`讀取清單失敗：${error.message}（不代表監控被刪除）`;
    if(!cache.length)monitorsEl.innerHTML='<div class="card empty">暫時無法讀取監控清單，正等待重試。</div>';
  }finally{loading=false}
}

function localTime(value){return value?new Date(value).toLocaleString('zh-TW',{hour12:false}):'—'}
async function showDiagnostic(id){
  const dialog=$('#diagnosticDialog'), content=$('#diagnosticContent');
  if(!dialog)return alert('請一併更新 public/index.html');
  content.textContent='正在讀取診斷…';
  if(!dialog.open)dialog.showModal();
  try{
    const d=await api(`/api/monitors/${id}/diagnostic`);
    const rows=(d.ticketRows||[]).map(r=>`${r.name}: ${r.state}${r.evidence?' ('+r.evidence+')':''}`).join('\n');
    content.innerHTML=`<p><strong>${escapeHtml(d.message)}</strong></p>
      <div class="statusgrid">
        <span>HTTP</span><strong>${d.httpStatus===null?'未取得':escapeHtml(d.httpStatus)}</strong>
        <span>判斷代碼</span><strong>${escapeHtml(d.code)}</strong>
        <span>檢查時間</span><strong>${escapeHtml(localTime(d.checkedAt))}</strong>
        <span>頁面標題</span><strong>${escapeHtml(d.title||'—')}</strong>
        <span>最後網址</span><strong>${escapeHtml(d.finalUrl||'—')}</strong>
        <span>沿用工作階段</span><strong>${d.sessionReused?'是':'否（首次或重建）'}</strong>
      </div>
      <p class="hint">「無法判斷」不是「已售完」。HTTP 403 也不能單獨證明是 IP 被鎖。</p>
      <h3>抓到的票種</h3><pre>${escapeHtml(rows||'無可辨識票種')}</pre>
      ${d.imageUrl?`<h3>雲端實際看到的畫面</h3><p>截圖時間：${escapeHtml(localTime(d.screenshotAt))}</p><a href="${escapeHtml(d.imageUrl)}" target="_blank" rel="noopener"><img class="diagnostic-image" src="${escapeHtml(d.imageUrl)}?v=${encodeURIComponent(d.screenshotAt||'')}" alt="KKTIX diagnostic screenshot"></a>`:`<p>無截圖：${escapeHtml(d.screenshotError||'瀏覽器未能建立或截圖失敗')}</p>`}
      <details><summary>頁面文字／資料請求錯誤</summary><pre>${escapeHtml(d.textPreview||'—')}</pre><pre>${escapeHtml(JSON.stringify(d.requestFailures||[],null,2))}</pre><p>${escapeHtml(d.sessionNote||'')}</p></details>`;
  }catch(error){content.textContent=error.message}
}
$('#closeDiagnostic')?.addEventListener('click',()=>$('#diagnosticDialog').close());

$('#save').addEventListener('click',async()=>{
  try{
    const data=formData();
    if(!data.url) return alert('請貼上售票網址');
    if(editingId) await api(`/api/monitors/${editingId}`,{method:'PUT',body:JSON.stringify(data)});
    else await api('/api/monitors',{method:'POST',body:JSON.stringify(data)});
    resetForm(); await load();
  }catch(e){alert(e.message)}
});
$('#cancelEdit').addEventListener('click',resetForm);

monitorsEl.addEventListener('click',async e=>{
  const b=e.target.closest('button[data-act]'); if(!b)return;
  const id=b.dataset.id, act=b.dataset.act, m=cache.find(x=>x.id===id);
  if(busyActions.has(id))return;
  if(act==='diagnostic')return showDiagnostic(id);
  if(act==='edit')return fillForm(m);
  busyActions.add(id);b.disabled=true;
  try{
    if(act==='pair'){await showPair(m);return;}
    if(act==='delete'){if(!confirm('刪除這個監控？'))return;await api(`/api/monitors/${id}`,{method:'DELETE'});}
    if(act==='start'||act==='stop')await api(`/api/monitors/${id}/${act}`,{method:'POST'});
    if(act==='test'){
      b.textContent='測試中…';
      const j=await api(`/api/monitors/${id}/test`,{method:'POST'});
      if(m?.siteType==='kktix')await showDiagnostic(id);
      else alert(`${siteName(j.siteType)}\n${j.result.summary}\n\n${j.result.available?'目前符合通知條件':'目前尚未符合'}`);
    }
    if(act==='notify'){await api(`/api/monitors/${id}/test-notification`,{method:'POST'});alert('測試通知已送出');}
  }catch(error){
    if(act==='test'&&error.details?.hasDiagnostic)await showDiagnostic(id);
    else alert(error.message);
  }finally{busyActions.delete(id);await load()}
});

setInterval(()=>{document.querySelectorAll('.next').forEach(el=>{const m=cache.find(x=>x.id===el.dataset.id);if(m)el.textContent=nextText(m)})},1000);
setInterval(load,5000);
load();
api('/api/info').then(info=>{const el=$('#buildVersion');if(el)el.textContent=`V3.5 電腦 / SE2 共用管理版 | 後端 ${info.version}`}).catch(()=>{const el=$('#buildVersion');if(el)el.textContent='前端 V3.5；請確認 server.js 也已更新'});

function updateLocalMode(){
  const local=$('#execution').value==='browser';
  $('#localHint').hidden=!local;
  if(local) $('#ticketplusSetup').hidden=true;
  else updateTicketplusPanel();
}
$('#execution').addEventListener('change',updateLocalMode);
$('#url').addEventListener('input',updateLocalMode);
const originalFill=fillForm;
fillForm=function(m){originalFill(m);updateLocalMode();};
const originalReset=resetForm;
resetForm=function(){originalReset();$('#execution').value='cloud';updateLocalMode();};
async function showPair(m){
  if(m.localPaired && !confirm('\u91cd\u65b0\u7522\u751f\u914d\u5c0d\u78bc\u6703\u4f7f\u6240\u6709\u88dd\u7f6e\u7684\u820a\u914d\u5c0d\u78bc\u5931\u6548\u3002\u78ba\u5b9a\uff1f'))return;
  const j=await api(`/api/monitors/${m.id}/pair-local`,{method:'POST'});
  const raw=JSON.stringify({v:1,origin:location.origin,id:j.monitorId,token:j.token,url:j.url});
  const encoded=btoa(String.fromCharCode(...new TextEncoder().encode(raw))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  $('#pairCode').value='tcm1.'+encoded;$('#pairDialog').showModal();
}
$('#closePair').onclick=()=>{$('#pairCode').value='';$('#pairDialog').close();};
$('#copyPair').onclick=async()=>{try{await navigator.clipboard.writeText($('#pairCode').value);$('#copyPair').textContent='\u5df2\u8907\u88fd';}catch{$('#pairCode').select();}};
