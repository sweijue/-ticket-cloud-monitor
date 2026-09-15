const $ = s => document.querySelector(s);
const monitorsEl = $('#monitors');
let editingId = null;
const busyActions = new Set();

function formData(){
  const mode = document.querySelector('input[name="intervalMode"]:checked')?.value || 'random';
  return {
    name: $('#name').value.trim(), url: $('#url').value.trim(),
    intervalMode: mode, fixedSeconds:+$('#fixedSeconds').value,
    minSeconds:+$('#minSeconds').value, maxSeconds:+$('#maxSeconds').value,
    limitedTime: $('#limitedTime').checked, startTime:$('#startTime').value, endTime:$('#endTime').value,
    detectionMode: $('#detectionMode').value, watchText: $('#watchText').value, watchCondition:$('#watchCondition').value,
    ntfyTopic: $('#ntfyTopic').value.trim()
  };
}

function fillForm(m){
  editingId = m.id;
  $('#name').value=m.name||''; $('#url').value=m.url||'';
  document.querySelector(`input[name="intervalMode"][value="${m.intervalMode||'random'}"]`).checked=true;
  $('#fixedSeconds').value=m.fixedSeconds||5; $('#minSeconds').value=m.minSeconds||1; $('#maxSeconds').value=m.maxSeconds||5;
  $('#limitedTime').checked=!!m.limitedTime; $('#startTime').value=m.startTime||'11:55'; $('#endTime').value=m.endTime||'12:30';
  $('#detectionMode').value=m.detectionMode||'auto'; $('#watchText').value=m.watchText||'已售完'; $('#watchCondition').value=m.watchCondition||'disappears'; $('#ntfyTopic').value=m.ntfyTopic||''; updateCustomRule();
  $('#save').textContent='更新監控'; $('#cancelEdit').hidden=false;
  window.scrollTo({top:0,behavior:'smooth'});
}

function resetForm(){
  editingId=null; $('#name').value=''; $('#url').value='';
  document.querySelector('input[name="intervalMode"][value="random"]').checked=true;
  $('#fixedSeconds').value=5; $('#minSeconds').value=1; $('#maxSeconds').value=5;
  $('#detectionMode').value='auto'; updateCustomRule(); $('#save').textContent='新增監控'; $('#cancelEdit').hidden=true;
}

async function api(url, opts={}){
  const r=await fetch(url,{cache:'no-store',headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) { const e=new Error(j.error||`HTTP ${r.status}`); e.details=j; throw e; }
  return j;
}

function siteName(t){return ({kham:'寬宏',kktix:'KKTIX',avex:'AVEX',tixcraft:'拓元',ibon:'ibon',generic:'通用'})[t]||t}
function detectionName(m){
  if(m.siteType!=='generic') return '網站自動判斷';
  return ({auto:'自動判斷',soldout:'售完/缺貨解除',stock:'庫存/剩餘 > 0',custom:'自訂文字'})[m.detectionMode||'auto']||'自動判斷';
}
function updateCustomRule(){ $('#customRule').hidden = $('#detectionMode').value !== 'custom'; }
$('#detectionMode').addEventListener('change', updateCustomRule);
updateCustomRule();
function stateName(m){
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
      <span>頻率</span><strong>${m.intervalMode==='fixed'?`每 ${m.fixedSeconds} 秒`:`隨機 ${m.minSeconds}～${m.maxSeconds} 秒`}</strong>
      <span>判斷</span><strong>${detectionName(m)}</strong>
      <span>最後檢查</span><strong>${m.lastCheck||'—'}</strong>
      <span>下次檢查</span><strong class="next" data-id="${m.id}">${nextText(m)}</strong>
      <span>結果</span><strong>${escapeHtml(m.lastResult||'—')}</strong>
      <span>檢查次數</span><strong>${m.checks||0}</strong>
      <span>錯誤</span><strong>${escapeHtml(m.lastError||'—')}</strong>
    </div>
    <div class="monitor-actions">
      <button data-act="${m.running?'stop':'start'}" data-id="${m.id}" class="${m.running?'danger':'good'}">${m.running?'停止':'開始'}</button>
      <button data-act="test" data-id="${m.id}" class="secondary" ${m.running?'disabled':''}>測試抓取</button>
      <button data-act="notify" data-id="${m.id}" class="secondary">測試通知</button>
      ${m.siteType==='kktix'?`<button data-act="diagnostic" data-id="${m.id}" class="secondary">檢視抓取畫面</button>`:''}
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
api('/api/info').then(info=>{const el=$('#buildVersion');if(el)el.textContent=`V3.1 KKTIX 診斷版 | 後端 ${info.version}`}).catch(()=>{const el=$('#buildVersion');if(el)el.textContent='前端 V3.1；請確認 server.js 也已更新'});
