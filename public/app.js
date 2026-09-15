const $ = s => document.querySelector(s);
const monitorsEl = $('#monitors');
let editingId = null;

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
  const r=await fetch(url,{headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`HTTP ${r.status}`);
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
  if(m.state==='paused') return '⏸ 已因網站限制暫停';
  if(m.state==='checking') return '檢查中';
  if(m.state==='waiting') return '等待監控時段';
  if(m.running) return '監控中';
  return '已停止';
}
function nextText(m){if(!m.nextAt)return '—'; const s=Math.max(0,Math.ceil((m.nextAt-Date.now())/1000));return `${s} 秒後`}

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
      <button data-act="test" data-id="${m.id}" class="secondary">測試抓取</button>
      <button data-act="notify" data-id="${m.id}" class="secondary">測試通知</button>
      <button data-act="edit" data-id="${m.id}" class="secondary">編輯</button>
      <button data-act="delete" data-id="${m.id}" class="secondary">刪除</button>
    </div>
  </section>`).join('');
}
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}

let cache=[];
monitorsEl.innerHTML='<div class="card empty">正在載入監控…</div>';
async function load(){cache=await api('/api/monitors');render(cache)}

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
  try{
    if(act==='edit') return fillForm(m);
    if(act==='delete'){if(!confirm('刪除這個監控？'))return;await api(`/api/monitors/${id}`,{method:'DELETE'});}
    if(act==='start'||act==='stop') await api(`/api/monitors/${id}/${act}`,{method:'POST'});
    if(act==='test'){b.disabled=true;b.textContent='測試中…';const j=await api(`/api/monitors/${id}/test`,{method:'POST'});alert(`${siteName(j.siteType)}\n${j.result.summary}\n\n判斷：${j.result.available?'目前符合通知條件':'目前尚未符合'}`);}
    if(act==='notify'){await api(`/api/monitors/${id}/test-notification`,{method:'POST'});alert('測試通知已送出');}
  }catch(err){alert(err.message)}finally{if(b){b.disabled=false}await load()}
});

setInterval(()=>{document.querySelectorAll('.next').forEach(el=>{const m=cache.find(x=>x.id===el.dataset.id);if(m)el.textContent=nextText(m)})},1000);
setInterval(load,5000);
load().catch(e=>alert(e.message));
