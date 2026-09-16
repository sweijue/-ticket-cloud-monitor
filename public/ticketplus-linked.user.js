// ==UserScript==
// @name         Ticket Plus Linked Monitor
// @namespace    local.ticket-monitor.se2
// @version      1.1.2
// @description  Ticket Plus 單場前景監控：選票種、排除身障票、重整後繼續、ntfy 提醒。不代購、不匯出登入資訊。
// @match        https://ticketplus.com.tw/*
// @match        https://www.ticketplus.com.tw/*
// @run-at       document-end
// @inject-into  content
// @noframes
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      ntfy.sh
// @connect      ticket-cloud-monitor-production.up.railway.app
// ==/UserScript==

/*
 * Userscripts (Safari) / Tampermonkey (Windows) script. Optional scoped cloud pairing.
 * Only ordinary reloads, ntfy notifications, and scoped management relay requests.
 * No cookie, password, authorization token, localStorage token, hidden API,
 * anti-bot bypass, purchase action or automatic login is used.
 * DOM detection is deliberately conservative and needs user verification.
 * Runtime lives in GM tab storage, settings in GM extension storage.
 */
(() => {
  'use strict';
  if (window.top !== window.self) return;
  const VERSION = '1.1.2';

  const rawGM = typeof GM === 'undefined' ? {} : GM;
  const adapter = {
    getValue: (k,d) => typeof rawGM.getValue==='function' ? rawGM.getValue(k,d) : Promise.resolve(GM_getValue(k,d)),
    setValue: (k,v) => typeof rawGM.setValue==='function' ? rawGM.setValue(k,v) : Promise.resolve(GM_setValue(k,v)),
    xmlHttpRequest: d => typeof rawGM.xmlHttpRequest==='function' ? rawGM.xmlHttpRequest(d) : GM_xmlhttpRequest(d)
  };
  const LINK_ORIGIN='https://ticket-cloud-monitor-production.up.railway.app';
  const uniqueId=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');

  const HOST_ID = 'se2-ticketplus-monitor-root';
  const RUNTIME_KEY = 'se2TicketMonitorV1';
  const SETTING_PREFIX = 'se2TicketMonitor.settings.';
  const ENDPOINT = 'https://ntfy.sh/';
  const SOLD = /已售完|已售罄|售罄|完售|售完|售光|已額滿|額滿|缺貨|sold\s*out\b|\bunavailable\b|\bnot available\b/i;
  const FUTURE = /尚未開賣|尚未開放|尚未開售|未開賣|暫停販售|停止販售|販售結束|已截止|\bcoming soon\b|\bnot on sale\b/i;
  const ACCESSIBLE = /身心障礙|身障|輪椅|陪同(?:票|席|座)|愛心(?:票|席)|\bwheelchair\b|\baccessible\b|\bcompanion\b/i;
  const INSTRUCTIONS = /購票須知|購票流程|訂單明細|信用卡付款|服務條款|隱私權政策|驗證碼說明|退票辦法/;
  const QTY_SELECTOR = 'select,input[type="number"],[role="spinbutton"]';
  const BLOCK_SELECTOR = '[role="dialog"],.v-dialog--active,.v-overlay--active,.modal.show';
  const clock = () => Date.now();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const norm = s => String(s || '').normalize('NFKC').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

  function canonicalURL(href = location.href) {
    const u = new URL(href);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  }
  function isOrder(href = location.href) {
    try {
      const u = new URL(href);
      return /^(?:www\.)?ticketplus\.com\.tw$/.test(u.hostname) &&
        /^\/order\/[a-z0-9_-]+\/[a-z0-9_-]+\/?$/i.test(u.pathname);
    } catch (_) { return false; }
  }
  function visible(el) {
    if (!el || !el.isConnected || el.nodeType !== 1 || el.closest(`#${HOST_ID},[hidden],[aria-hidden="true"]`)) return false;
    const css = getComputedStyle(el);
    return css.display !== 'none' && css.visibility !== 'hidden' && css.opacity !== '0' && el.getClientRects().length > 0;
  }
  function text(el) { return norm(el?.innerText || el?.textContent || ''); }
  function enabled(el) {
    return visible(el) && !el.disabled && !el.readOnly &&
      !el.closest('[disabled],[aria-disabled="true"],.v-btn--disabled,.is-disabled,.disabled');
  }
  function prices(s) {
    const out = [];
    const re = /(?:NT\s*\$|NTD|TWD|\$)\s*(\d[\d,]*)|(\d[\d,]*)\s*元|(?:票價|售價|價格)\s*[:：]?\s*(\d[\d,]*)/gi;
    for (const m of s.matchAll(re)) {
      const n = Number((m[1] || m[2] || m[3]).replace(/,/g, ''));
      if (Number.isFinite(n)) out.push(n);
    }
    return [...new Set(out)];
  }
  function countEvidence(s) {
    const m = s.match(/(?:庫存(?:量)?|剩餘(?:票券|票數|數量|座位)?|可售(?:票數|數量)?|空位|remaining)\s*[:：]?\s*(\d[\d,]*)\s*(?:張|席|個|tickets)?/i);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }
  function stableName(el, s) {
    const heading = [...el.querySelectorAll('[data-ticket-name],.ticket-name,.ticket-title,[class*="ticketName"],[class*="ticket-name"],h3,h4')]
      .find(x => visible(x) && text(x).length >= 2 && text(x).length < 130);
    // Quantity options and +/- labels are mutable controls, not ticket identity.
    const parts = [];
    if (!heading) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (parent && !parent.closest('select,option,input,button,[role="button"],script,style') && visible(parent)) parts.push(node.textContent);
      }
    }
    const source = heading ? text(heading) : norm(parts.join(' '));
    return norm(source
      .replace(/(?:NT\s*\$|NTD|TWD|\$)\s*\d[\d,]*|\d[\d,]*\s*元|(?:票價|售價|價格)\s*[:：]?\s*\d[\d,]*/gi, ' ')
      .replace(/(?:庫存(?:量)?|剩餘(?:票券|票數|數量|座位)?|可售(?:票數|數量)?|空位|remaining)\s*[:：]?\s*\d[\d,]*\s*(?:張|席|個|tickets)?/gi, ' ')
      .replace(/已售完|已售罄|售罄|完售|售完|售光|已額滿|額滿|缺貨|尚未開賣|尚未開放|尚未開售|未開賣|暫停販售|停止販售|販售結束|已截止|sold\s*out|not available|unavailable|coming soon|not on sale/gi, ' ')
      .replace(/尚有票券|尚有票|可購買|可選購|available/gi, ' ')
      .replace(/請選擇(?:數量)?|選擇數量|購買數量|數量|增加數量|減少數量|加入購物車|下一步|立即購票/gi, ' ')
      .replace(/(?:^|\s)(?:張|席|qty|quantity)(?=\s|$)/gi, ' ')
      .replace(/(?:^|\s)\d+(?=\s|$)/g, ' ')
      .replace(/[+＋−\-：:|]/g, ' ')).slice(0, 140);
  }
  function plusControl(el) {
    return [...el.querySelectorAll('button,[role="button"]')].find(b => {
      const label = norm(`${text(b)} ${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''}`);
      const plus = /^(\+|＋|add)$/i.test(label) || /增加數量|增加張數|increase quantity/i.test(label) ||
        b.querySelector('.mdi-plus,.fa-plus,.glyphicon-plus,[data-icon="plus"]');
      return plus && enabled(b);
    });
  }
  function rowEvidence(el) {
    if (!visible(el)) return null;
    const s = text(el);
    if (s.length < 4 || s.length > 650 || INSTRUCTIONS.test(s)) return null;
    const ps = prices(s);
    if (ps.length !== 1) return null;
    const label = stableName(el, s);
    if (label.length < 2 || !/[a-z\u3400-\u9fff]/i.test(label)) return null;
    const controls = [...el.querySelectorAll(QTY_SELECTOR)].filter(visible);
    const validSelect = controls.find(q => q.tagName === 'SELECT' && enabled(q) &&
      [...q.options].some(o => !o.disabled && /^\d+$/.test(String(o.value).trim()) && Number(o.value) > 0));
    const validInput = controls.find(q => q.tagName !== 'SELECT' && enabled(q) &&
      q.hasAttribute('max') && Number(q.getAttribute('max')) > 0);
    const plus = plusControl(el);
    const count = countEvidence(s);
    let state = 'unknown', reason = '未找到可確認的售完或數量證據';
    if (SOLD.test(s)) { state = 'sold'; reason = '票種列顯示售完／缺貨'; }
    else if (FUTURE.test(s)) { state = 'not_started'; reason = '尚未開賣、暫停或販售結束'; }
    else if (count === 0) { state = 'sold'; reason = '票種列剩餘數量為 0'; }
    else if (validSelect) { state = 'available'; reason = '此票種有可選的正數張數'; }
    else if (validInput) { state = 'available'; reason = '此票種數量欄啟用且 max > 0'; }
    else if (plus) { state = 'available'; reason = '此票種增加張數按鈕啟用'; }
    else if (count > 0 && !controls.some(q => !enabled(q))) { state = 'available'; reason = `此票種明示剩餘 ${count}`; }
    const semantic = /ticket|price|area|tickettype/i.test(String(el.className || '')) ||
      el.matches('tr,[role="row"],[data-ticket-id],[data-ticket-type-id],[data-price-id]');
    if (state === 'unknown' && !controls.length && !semantic) return null;
    const explicit = ['data-ticket-id', 'data-ticket-type-id', 'data-price-id', 'data-area-id']
      .map(a => el.getAttribute(a)).find(Boolean);
    const key = explicit ? `id:${explicit}|${ps[0]}` : `label:${label.toLowerCase()}|${ps[0]}`;
    return { key, label, price: ps[0], state, reason, accessible: ACCESSIBLE.test(label), preview: s.slice(0, 240), el };
  }
  function findRow(seed) {
    let el = seed?.nodeType === 1 ? seed : seed?.parentElement;
    for (let n = 0; el && n < 7 && !el.matches('body,html,main,#app'); n++, el = el.parentElement) {
      const row = rowEvidence(el);
      if (row) return row;
    }
    return null;
  }
  function detectRows(root = document) {
    const seeds = new Set(root.querySelectorAll(
      '[data-ticket-id],[data-ticket-type-id],[data-price-id],.ticket-item,.ticket-row,.ticket-type,.ticket-card,.ticketInfo,' +
      'tr,[role="row"],.v-list-item,select,input[type="number"],[role="spinbutton"]'
    ));
    for (const el of root.querySelectorAll('span,p,div,td,li,button')) {
      if (el.children.length || el.closest(`#${HOST_ID},nav,header,footer,script,style`)) continue;
      const s = norm(el.textContent);
      if (s.length > 0 && s.length < 180 && (prices(s).length || SOLD.test(s) || FUTURE.test(s))) seeds.add(el);
      if (seeds.size >= 500) break;
    }
    const candidates = new Map();
    for (const seed of seeds) {
      const row = findRow(seed);
      if (row) candidates.set(row.el, row);
    }
    const all = [...candidates.values()];
    // Never treat the parent of two different ticket rows as one "ticket".
    const minimal = all.filter(a => !all.some(b => a.el !== b.el && a.el.contains(b.el)));
    const grouped = new Map();
    for (const row of minimal) {
      if (!grouped.has(row.key)) grouped.set(row.key, []);
      grouped.get(row.key).push(row);
    }
    const out = [];
    for (const group of grouped.values()) {
      const first = group[0];
      // Responsive duplicate copies with identical state can be collapsed.
      // Conflicting duplicates are ambiguous; never produce an availability alert.
      if (group.some(r => r.state !== first.state)) {
        out.push({ ...first, state: 'unknown', reason: '同名票種有不同狀態，請用點選方式確認' });
      } else out.push(first);
    }
    return out.slice(0, 100);
  }
  function pageGate() {
    const body = text(document.body);
    if (/sorry,?\s*you have been blocked|attention required.{0,40}cloudflare|verify you are human|checking your browser|just a moment|access denied|存取已被封鎖|存取遭拒|請完成安全驗證/i.test(body) ||
      document.querySelector('#challenge-running,#cf-challenge-running,#challenge-form')) return '網站驗證／限制頁，已停止；請手動處理，不會自動闖過。';
    if (/您正在排隊|目前正在排隊|正在等候入場|you are now in line|you are in a queue/i.test(body)) return '網站排隊中，已停止；請依網站流程等候。';
    const dialog = [...document.querySelectorAll(BLOCK_SELECTOR)].filter(visible).map(text).join(' ');
    if (/請先登入|登入會員|會員登入|登入已逾時|登入狀態已失效|重新登入|sign in|log in/i.test(dialog) ||
      [...document.querySelectorAll('input[type="password"]')].some(visible)) return '需要登入，已停止；請在這台裝置的原網頁手動登入，再按開始。';
    if (/登入已逾時|登入狀態已失效|連線逾時請重新登入|操作過於頻繁|請求過於頻繁|too many requests/i.test(body)) return '登入已失效或網站限制請求，已停止，請手動確認。';
    const captcha = [...document.querySelectorAll('iframe')].some(f => visible(f) &&
      /recaptcha|hcaptcha|challenges\.cloudflare/.test(f.getAttribute('src') || ''));
    if (captcha) return '出現人機驗證，已停止；請手動完成，不會自動解題。';
    return '';
  }
  function selectorFor(el) {
    if (!el) return '';
    const segments = [];
    for (let n = 0; el && el.nodeType === 1 && n < 14; n++, el = el.parentElement) {
      if (el.id) { segments.unshift('#' + CSS.escape(el.id)); break; }
      const tag = el.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') { segments.unshift(tag); break; }
      const siblings = el.parentElement ? [...el.parentElement.children].filter(x => x.tagName === el.tagName) : [el];
      segments.unshift(`${tag}:nth-of-type(${siblings.indexOf(el)+1})`);
    }
    return segments.join(' > ');
  }
  const serialRow = r => ({ key: r.key, label: r.label, price: r.price, accessible: r.accessible, selector:r.selector || selectorFor(r.el) });
  const rowStamp = rows => JSON.stringify(rows.map(r => [r.key, r.state]).sort((a,b) => a[0].localeCompare(b[0])));
  const stateLabel = s => ({ available:'可選購', sold:'售完／0 張', not_started:'未開賣／已結束', unknown:'無法確認' }[s] || '無法確認');

  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({mode:'closed'});
  shadow.innerHTML = `
    <style>
      :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18293b;font-size:14px;line-height:1.5}
      *,*:before,*:after{box-sizing:border-box}button,input,select{font:inherit}
      button{border:1px solid #c4d0db;border-radius:9px;background:white;color:#15273c;padding:9px 11px;min-height:42px;cursor:pointer}
      button:disabled{opacity:.45;cursor:default}input:not([type=checkbox]),select{width:100%;border:1px solid #bac7d4;border-radius:8px;padding:9px;min-height:40px;font-size:16px;background:#fff;color:#142539}
      label{display:block;margin:8px 0 4px}input[type=checkbox]{width:18px;height:18px;vertical-align:middle;flex:none}
      #toggle{position:fixed;bottom:12px;left:10px;z-index:2147483647;background:#14334d;color:white;box-shadow:0 3px 10px #0003}
      #panel{position:fixed;z-index:2147483647;bottom:64px;left:8px;width:calc(100vw - 16px);max-width:420px;max-height:70vh;overflow:auto;-webkit-overflow-scrolling:touch;border:1px solid #bac7d4;border-radius:14px;background:#fff;box-shadow:0 8px 35px #0004;padding:12px;padding-bottom:16px}
      #panel[hidden]{display:none}#status{padding:8px;background:#eef4f8;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}
      .line{display:flex;gap:7px;align-items:center;margin:8px 0}.line>*{flex:1}.line input[type=checkbox]{flex:none}.top{justify-content:space-between}.top strong{font-size:16px}
      .primary{background:#11656c;color:#fff;border-color:#11656c}.danger{background:#ad3636;color:#fff;border-color:#ad3636}
      .small{font-size:12px;color:#516476}.warn{font-size:12px;color:#8b4e10}.ticket{padding:8px;border:1px solid #dde5ec;border-radius:9px;margin:6px 0;display:flex;gap:8px;align-items:flex-start}
      .ticket span{overflow-wrap:anywhere}.ticket b{font-size:14px}.ticket small{display:block;color:#516476}.ticket:has(input:disabled){opacity:.6}
      .ok{color:#14745d}.bad{color:#a33b32}#notice{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
      summary{cursor:pointer;padding:8px 0}#picker{border:2px solid #0c8276;padding:8px;background:#effcf8;border-radius:8px}
    </style>
    <button id="toggle">監票</button>
    <section id="panel">
      <div class="line top"><strong>Ticket Plus 電腦 / SE2 監控</strong><button id="collapse">收合</button></div>
      <div class="small">1.1.2 · Windows 修正版 · 本機執行</div>
      <p id="status">正在啟動…</p>
      <p id="notice"></p>
      <details id="linkDetails"><summary>連到原本的管理頁（電腦 / SE2 共用）</summary>
      <p id="linkState" class="small">未配對；單機設定不會自動同步。</p>
      <label>這台裝置名稱<input id="deviceName" maxlength="40" placeholder="Windows 或 SE2"></label>
      <label>貼上管理頁產生的配對碼<input id="pairInput" type="password" autocomplete="off" placeholder="tcm1...."></label>
      <div class="line"><button id="connectLink">配對</button><button id="pullLink">同步共用設定</button></div>
      <button id="saveLocalSelection">儲存票種到管理頁</button>
      <button id="unlink">取消這台裝置配對</button>
      <p class="small">配對後，名稱、頻率、時段、Topic 由管理頁統一設定。售票網站登入狀態留在這台裝置，不會上傳。</p></details>

      <div class="line"><button id="scan">讀取票種</button><button id="pick">點選票種</button></div>
      <div id="picker" hidden>
        <div id="pickText">面板會收起，請點網頁上的一個票種。</div>
        <div class="line"><button id="pickAdd">加入這個票種</button><button id="pickCancel">取消</button></div>
      </div>
      <label><input id="exclude" type="checkbox" checked> 排除身障／輪椅／陪同票</label>
      <div id="tickets"><p class="small">先按「讀取票種」，再核對名稱和狀態。</p></div>
      <label><input id="verified" type="checkbox"> 我已核對票種名稱和狀態與網頁相符</label>
      <label>通知名稱<input id="name" maxlength="80" placeholder="例如：遠大演唱會"></label>
      <label>ntfy Topic<input id="topic" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="填原本手機訂閱的 Topic"></label>
      <div class="line"><label><input id="showTopic" type="checkbox"> 顯示 Topic</label><button id="testPush">測試通知</button></div>
      <details><summary>刷新時間與進階設定</summary>
        <label>刷新模式<select id="mode"><option value="random">隨機間隔</option><option value="fixed">固定間隔</option></select></label>
        <div class="line" id="randomFields"><label>最短秒數<input id="min" type="number" min="1" max="3600" value="1"></label><label>最長秒數<input id="max" type="number" min="1" max="3600" value="5"></label></div>
        <label id="fixedFields" hidden>固定秒數<input id="fixed" type="number" min="1" max="3600" value="5"></label>
        <label><input id="scheduled" type="checkbox"> 限定開始／結束時間（本機時區）</label>
        <div id="scheduleFields" hidden><label>開始<input id="startAt" type="datetime-local"></label><label>結束<input id="endAt" type="datetime-local"></label></div>
        <label><input id="pauseAlerts" type="checkbox" checked> 讀不到票種或需要登入時也通知</label>
        <label><input id="sound" type="checkbox"> 嘗試 本機提示音（重整後可能無聲）</label>
        <p class="warn">間隔在頁面載入、讀取完成後才開始計時，實際週期更長。1～5 秒可能觸發網站限制，不是防封鎖模式。</p>
      </details>
      <div class="line"><button id="start" class="primary">開始監控</button><button id="stop" class="danger">停止</button></div>
      <button id="retry" hidden>重送未成功的通知</button>
      <div class="small">只讀畫面，不選位、不加張數、不下單。找到有票會先停止刷新。請讓這個瀏覽器分頁保持前景。</div>
    </section>`;
  const $ = id => shadow.getElementById(id);
  let settings = { name:'Ticket Plus 票況', topic:'', exclude:true, mode:'random', min:1, max:5, fixed:5, scheduled:false, startAt:'', endAt:'', pauseAlerts:true, sound:false, selected:[], verified:false };
  let runtime = { url:'', running:false, checks:0, message:'待設定', nextAt:0, pending:null };
  let rows = [], selected = new Set(), settingURL = '', loadingProfile = false;
  let cycleToken = 0, reloadTimer = null, busy = false, audioContext = null;
  let pickMode = false, picked = null, previousOutline = '';
  let link = null, localClientId = "", remoteConfig = null, relayQueue=Promise.resolve();
  const hasGM = (typeof rawGM.getValue==='function' || typeof GM_getValue==='function') &&
    (typeof rawGM.setValue==='function' || typeof GM_setValue==='function') &&
    (typeof rawGM.xmlHttpRequest==='function' || typeof GM_xmlhttpRequest==='function');
  const notice = s => { $('notice').textContent = s; };
  function panel(show) { $('panel').hidden = !show; }
  function setStatus(s) {
    runtime.message = s;
    $('status').textContent = s;
  }
  function renderStatus() {
    const count = runtime.checks ? `\n已檢查 ${runtime.checks} 次` : '';
    const next = runtime.running && runtime.nextAt ? `\n下次刷新：約 ${Math.max(0, Math.ceil((runtime.nextAt-clock())/1000))} 秒後` : '';
    $('status').textContent = `${runtime.message || '待設定'}${count}${next}`;
    $('toggle').textContent = runtime.running ? '監票 · 執行中' : '監票 · 已停止';
    $('retry').hidden = !runtime.pending || !!link;
    $('linkState').textContent=link ? '已配對：'+(remoteConfig?.name || settings.name)+'（同一筆監控）' : '未配對；單機設定不會自動同步。';
    $('start').disabled = !!runtime.running;
    for (const id of ['name','topic','exclude','verified','mode','min','max','fixed','scheduled','startAt','endAt','pauseAlerts','sound'])
      $(id).disabled = !!runtime.running || (!!link && ['name','topic','exclude','mode','min','max','fixed','scheduled','startAt','endAt'].includes(id));
  }
  function runtimeStorageKey(url = settingURL || canonicalURL()) {
    return `${RUNTIME_KEY}.${url}`;
  }
  async function saveRuntime() {
    const snapshot = JSON.parse(JSON.stringify(runtime));
    await adapter.setValue(runtimeStorageKey(runtime.url || settingURL || canonicalURL()), snapshot);
  }
  function readSettingsUI() {
    settings.name = $('name').value.trim().slice(0,80) || 'Ticket Plus 票況';
    settings.topic = $('topic').value.trim();
    settings.exclude = $('exclude').checked;
    settings.mode = $('mode').value;
    for (const k of ['min','max','fixed']) settings[k] = Number($(k).value);
    for (const k of ['scheduled','pauseAlerts','sound','verified']) settings[k] = $(k).checked;
    if(link) settings.scheduled=false;
    settings.startAt = $('startAt').value;
    settings.endAt = $('endAt').value;
    settings.selected = rows.filter(r => selected.has(r.key)).map(serialRow);
    return settings;
  }
  function fillUI() {
    for (const k of ['name','topic','mode','min','max','fixed','startAt','endAt']) $(k).value = settings[k];
    for (const k of ['exclude','scheduled','pauseAlerts','sound','verified']) $(k).checked = !!settings[k];
    updateOptions();
  }
  function updateOptions() {
    $('randomFields').hidden = $('mode').value !== 'random';
    $('fixedFields').hidden = $('mode').value !== 'fixed';
    $('scheduleFields').hidden = !$('scheduled').checked;
  }
  async function saveSettings() {
    readSettingsUI();
    await adapter.setValue(SETTING_PREFIX + settingURL, settings);
    await adapter.setValue('se2TicketMonitor.defaultTopic', settings.topic);
  }
  function renderRows() {
    const list = $('tickets');
    list.replaceChildren();
    if (!rows.length) {
      const p = document.createElement('p'); p.className = 'small';
      p.textContent = '尚未辨識到票種。可等網頁載入後再讀取，或按「點選票種」。';
      list.appendChild(p); return;
    }
    for (const row of rows) {
      const label = document.createElement('label'); label.className='ticket';
      const box = document.createElement('input'); box.type='checkbox';
      box.checked = selected.has(row.key);
      box.disabled = !!(settings.exclude && row.accessible) || runtime.running;
      if (settings.exclude && row.accessible) { box.checked=false; selected.delete(row.key); }
      box.addEventListener('change', () => {
        if (box.checked) selected.add(row.key); else selected.delete(row.key);
        settings.verified=false; $('verified').checked=false;
      });
      const span = document.createElement('span'), b = document.createElement('b'), small = document.createElement('small');
      b.textContent = `${row.label} · $${row.price.toLocaleString()}`;
      small.textContent = `${stateLabel(row.state)}${row.accessible ? ' · 特殊席' : ''}｜${row.reason || ''}`;
      span.append(b, small); label.append(box,span); list.appendChild(label);
    }
  }
  function validate(s) {
    if (!isOrder()) throw Error('請在登入後的 Ticket Plus /order/ 單場票種頁使用，不是活動首頁。');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(s.topic)) throw Error('ntfy Topic 請填原本訂閱的名稱，只能用英數、-、_，不是網址。');
    for (const k of [s.mode === 'fixed' ? 'fixed' : 'min', ...(s.mode === 'random' ? ['max'] : [])])
      if (!Number.isInteger(s[k]) || s[k]<1 || s[k]>3600) throw Error('秒數請填 1～3600 的整數。');
    if (s.mode==='random' && s.min>s.max) throw Error('最短秒數不能大於最長秒數。');
    if (!s.selected.length) throw Error('請先讀取並勾選至少一個一般票種。');
    if (!s.verified) throw Error('請核對讀到的票種名稱和狀態，再勾選「我已核對」。');
    if (s.scheduled && (!Number.isFinite(Date.parse(s.startAt)) || !Number.isFinite(Date.parse(s.endAt)) ||
      Date.parse(s.endAt)<=Math.max(Date.parse(s.startAt),clock()))) throw Error('請填有效的開始、結束日期時間，且結束必須晚於現在和開始。');
  }
  function randomDelay(s = settings) {
    const sec = s.mode === 'fixed' ? s.fixed : s.min + Math.floor(Math.random() * (s.max - s.min + 1));
    return sec * 1000;
  }
  function postNotice(payload) {
    // JSON body avoids Unicode HTTP header problems with Chinese titles.
    return new Promise((resolve,reject) => {
      let finished=false;
      const finish = (err,res) => { if (finished) return; finished=true; clearTimeout(guard); err ? reject(err) : resolve(res); };
      const guard = setTimeout(() => finish(Error('ntfy 傳送逾時，請確認通知權限與連線。')), 20000);
      try {
        const request = adapter.xmlHttpRequest({
          method:'POST', url:ENDPOINT, timeout:15000,
          headers:{'Content-Type':'application/json'},
          data:JSON.stringify(payload),
          onload:res => {
            if (res.status<200 || res.status>=300) return finish(Error(`ntfy HTTP ${res.status}，通知尚未確認送達。`));
            try {
              const result = JSON.parse(res.responseText || res.response || '{}');
              if (!result.id) throw Error('沒有訊息識別碼');
              finish(null,result);
            } catch (e) { finish(Error(`ntfy 回應無法確認：${e.message}`)); }
          },
          onerror:() => finish(Error('ntfy 連線失敗；請檢查 Userscripts 權限／網路。')),
          ontimeout:() => finish(Error('ntfy 傳送逾時，請檢查網路。')),
          onabort:() => finish(Error('ntfy 傳送中斷。'))
        });
        // API may return a Promise for request registration; callbacks carry the HTTP result.
        if (request && typeof request.catch === 'function') request.catch(e => finish(Error(String(e))));
      } catch(e) { finish(e); }
    });
  }
  function payload(message, kind='ticket') {
    return {
      topic:settings.topic,
      title:`${kind==='test'?'測試通知':kind==='pause'?'監控暫停':'票況提醒'}｜${settings.name}`.slice(0,180),
      message:message.slice(0,1400),
      priority:kind==='ticket'?5:3,
      tags:[kind==='ticket'?'ticket':'information_source'],
      click:runtime.url || settingURL,
      actions:[{action:'view',label:'開啟售票頁',url:runtime.url || settingURL}]
    };
  }
  async function sendPending() {
    const item=runtime.pending;
    if (!item) return;
    try {
      const res=await postNotice(item.payload);
      if (runtime.pending?.id===item.id) { runtime.pending=null; await saveRuntime(); }
      notice(`已交給 ntfy（訊息 ${String(res.id).slice(0,12)}）。是否已在另一台手機顯示，請以接收端為準。`);
    } catch(e) {
      notice(`通知尚未確認送達：${e.message}\n已保留通知，按「重送未成功的通知」再試；網路逾時後重送可能收到重複訊息。`);
    }
    renderStatus();
  }
  async function queueNotice(message,kind) {
    runtime.pending={id:`${clock()}-${Math.random().toString(16).slice(2,8)}`,payload:payload(message,kind)};
    await saveRuntime(); renderStatus(); await sendPending();
  }
  function clearTimer() {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer=null; runtime.nextAt=0;
  }
  async function halt(message, notify=false) {
    ++cycleToken; clearTimer(); runtime.running=false; runtime.message=message;
    if(link){try{await relay('release',{error:notify?message:''});}catch(e){notice('回報停止失敗；管理頁稍後會顯示離線。');}}
    renderStatus(); renderRows();
    await saveRuntime();
    if (notify && settings.pauseAlerts && !link && /^[A-Za-z0-9_-]{1,64}$/.test(settings.topic)) {
      await queueNotice(`${message}\n${new Date().toLocaleString()}`, 'pause');
    }
  }
  async function waitForRows(token) {
    let previous='', same=0, lastRows=[];
    const deadline=clock()+30000;
    while (clock()<deadline) {
      if (!runtime.running || token!==cycleToken) return null;
      if (document.hidden) return null;
      if (canonicalURL()!==runtime.url) throw Error('已離開原本單場頁，停止監控。');
      if (settings.scheduled && clock()>=Date.parse(settings.endAt)) throw Error('已到設定的結束時間。');
      if (!navigator.onLine) throw Error('手機目前離線，監控已停止；恢復連線後請按開始。');
      const gate=pageGate(); if (gate) throw Error(gate);
      const current=detectRows();
      const map=new Map(current.map(r=>[r.key,r]));
      for (const saved of settings.selected) {
        if (map.has(saved.key) || !saved.selector) continue;
        try {
          const candidate = rowEvidence(document.querySelector(saved.selector));
          if (candidate && candidate.key === saved.key) { current.push(candidate); map.set(candidate.key,candidate); }
        } catch (_) { /* Stale selector is not a ticket match. */ }
      }
      // Match by stable ticket name/price or a website-provided ID; never by list position.
      lastRows=settings.selected.map(w=>map.get(w.key) || {...w,state:'missing',reason:'這次頁面沒有找到原本勾選的票種'});
      const missing=lastRows.some(r=>r.state==='missing'||r.state==='unknown');
      const stamp=rowStamp(lastRows);
      if (!missing && lastRows.length && stamp===previous) same++; else same=0;
      previous=stamp;
      if (same>=1) return { all:current, watched:lastRows };
      runtime.message=missing?'正在等待票種載入／辨識（最多 30 秒）':'正在確認票種狀態…';
      renderStatus(); await sleep(800);
    }
    const missing=lastRows.filter(r=>r.state==='missing'||r.state==='unknown').map(r=>r.label).join('、');
    throw Error(`30 秒內未能確認票種：${missing || '頁面沒有完整票況'}。已停止，不會當成售完或有票。`);
  }
  async function beep() {
    if (!settings.sound) return;
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      await audioContext.resume();
      const osc=audioContext.createOscillator(), gain=audioContext.createGain();
      osc.frequency.value=740; gain.gain.value=.08; osc.connect(gain); gain.connect(audioContext.destination);
      osc.start(); osc.stop(audioContext.currentTime+.4);
    } catch (_) { /* Audio after reload is optional; ntfy remains the primary alert. */ }
  }
  async function checkAndSchedule() {
    if (!runtime.running || busy || document.hidden) return;
    if (settings.scheduled && clock()>=Date.parse(settings.endAt)) return halt('已到結束時間，已停止。');
    if (settings.scheduled && clock()<Date.parse(settings.startAt)) {
      runtime.message='等待設定的開始時間；此分頁需保持前景。';
      renderStatus(); clearTimer();
      reloadTimer=setTimeout(()=>{checkAndSchedule().catch(handleError);},Math.min(1000,Date.parse(settings.startAt)-clock()));
      return;
    }
    const token=cycleToken;
    busy=true;
    try {
      if(link){if(!await localPermit())return;if(!remoteConfig.inSchedule){runtime.message='等待管理頁設定的監控時段';renderStatus();reloadTimer=setTimeout(()=>checkAndSchedule().catch(handleError),15000);return;}}
      const result=await waitForRows(token);
      if (!result || !runtime.running || token!==cycleToken) return;
      rows=result.all; selected=new Set(settings.selected.map(w=>w.key));
      runtime.checks=(runtime.checks || 0)+1; runtime.lastCheck=clock();
      renderRows();
      const hits=result.watched.filter(r=>r.state==='available' && !(settings.exclude && r.accessible));
      if(link){const ack=await relay('report',{nonce:uniqueId(),rows:result.watched.map(({key,state,reason})=>({key,state,reason}))});if(!ack.running && !hits.length){await halt('管理頁已停止，請查看結果');return;}}
      if (hits.length) {
        await halt('偵測到可選購的票種，已停止刷新。');
        panel(true); await beep();
        if(link){notice('已回報管理頁，由 Railway 發送 ntfy 通知。請確認通知有送達。');return;}
        await queueNotice(`${hits.map(r=>`${r.label} $${r.price}：${r.reason}`).join('\n')}\n${new Date().toLocaleString()}\n以售票頁實際結果為準，不代表已保留票券。`,'ticket');
        return;
      }
      runtime.message=`監控中：勾選的 ${result.watched.length} 種目前沒有可選購證據。`;
      const delay=randomDelay();
      runtime.nextAt=clock()+delay;
      await saveRuntime(); renderStatus();
      reloadTimer=setTimeout(async()=>{
        if (!runtime.running || token!==cycleToken || document.hidden) return;
        if (settings.scheduled && clock()>=Date.parse(settings.endAt)) return halt('已到結束時間，已停止。');
        if (canonicalURL()!==runtime.url) return halt('頁面已切換，已停止。');
        const gate=pageGate(); if (gate) return halt(gate,true);
        runtime.nextAt=0; runtime.message='正在重新整理單場頁…';
        try { if(link && !await localPermit())return; if(!runtime.running || token!==cycleToken || document.hidden)return; await saveRuntime(); location.reload(); } catch(e) { handleError(e); }
      },delay);
    } catch(e) {
      if (runtime.running && token===cycleToken) await halt(e.message,true);
    } finally { busy=false; }
  }
  async function handleError(e) {
    console.error('[SE2 Monitor]', e?.message || 'error');
    ++cycleToken; clearTimer(); runtime.running=false;
    setStatus(`已停止：${e?.message || '未預期錯誤'}`);
    renderStatus();
    try { await saveRuntime(); } catch(_) { notice('Userscripts 儲存失敗，請不要啟動刷新。'); }
  }
  function unpick() {
    if (picked?.el) picked.el.style.outline=previousOutline;
    picked=null; pickMode=false; $('picker').hidden=true;
  }
  async function scan() {
    if (runtime.running) await halt('已停止刷新，重新讀取票種。');
    const gate=pageGate(); if (gate) throw Error(gate);
    if (!isOrder()) throw Error('請先在 Ticket Plus 打開單場 /order/ 票種頁。');
    rows=detectRows();
    const old=new Set(settings.selected.map(r=>r.key));
    selected=new Set(rows.filter(r=>(old.size?old.has(r.key):true) && !(settings.exclude&&r.accessible)).map(r=>r.key));
    settings.verified=false; $('verified').checked=false;
    renderRows();
    notice(rows.length?`讀到 ${rows.length} 個候選票種。請核對網頁：只勾選你要的票種；「無法確認」不是售完。`:'未辨識到完整票種。請試「點選票種」，不用輸入監控文字。');
  }
  async function start() {
    notice('正在啟動監控…');
    setStatus('正在啟動監控…');
    renderStatus();
    await ensureProfile();
    if (runtime.running) return;
    readSettingsUI(); validate(settings);
    if (rows.filter(r=>selected.has(r.key)).some(r=>r.state==='unknown')) throw Error('勾選票種仍有「無法確認」，請先重新讀取或用點選方式確認。');
    await saveSettings();
    const savedPending=runtime.pending;
    if (savedPending && !confirm('還有未確認送達的通知。開始新監控會清除這筆待重送通知，確定嗎？')) return;
    let localRunId='';
    if(link){const gate=pageGate();if(gate)throw Error(gate);await saveSharedSelection();const cfg=await relay('begin');localRunId=cfg.runId;applyShared(cfg,false);}
    ++cycleToken; clearTimer();
    runtime={localRunId,url:canonicalURL(),running:true,checks:0,message:'啟動監控…',nextAt:0,pending:null};
    await saveRuntime(); await beep();
    notice('偵測到可選購會直接通知，包括開始時就已經有票的情況。請勿在監控中操作購票按鈕。');
    renderStatus(); renderRows();
    checkAndSchedule().catch(handleError);
  }
  async function ensureProfile() {
    const u=canonicalURL();
    if (u===settingURL || loadingProfile) return;
    loadingProfile=true;
    try {
      if (runtime.running && runtime.url!==u) await halt('已離開監控的單場頁，已停止。',true);
      settingURL=u;
      const defaults={name:'Ticket Plus 票況',topic:await adapter.getValue('se2TicketMonitor.defaultTopic',''),exclude:true,mode:'random',min:1,max:5,fixed:5,scheduled:false,startAt:'',endAt:'',pauseAlerts:true,sound:false,selected:[],verified:false};
      const saved=await adapter.getValue(SETTING_PREFIX+u,{});
      settings={...defaults,...saved};
      link=await adapter.getValue('tcm.link.'+u,null);
      $('deviceName').value=link?.deviceName || (/Win/i.test(navigator.platform)?'Windows':'SE2');
      if (!Array.isArray(settings.selected)) settings.selected=[];
      rows=settings.selected.map(w=>({...w,state:'unknown',reason:'已儲存，等待重新讀取'}));
      selected=new Set(settings.selected.map(w=>w.key)); fillUI(); renderRows();
      if (!isOrder()) setStatus('請進入登入後的單場票種頁；目前不會刷新。');
      else if (!runtime.running) setStatus('已就緒；先讀取票種與測試通知。');
    } finally { loadingProfile=false; }
  }

  function relay(action,extra={}) {
    if(!link) return Promise.reject(Error('Not paired'));
    const cfg={...link};
    const body={action,monitorId:cfg.id,url:settingURL,clientId:localClientId,
      deviceName:cfg.deviceName,runId:runtime.localRunId || '',...extra};
    const work=()=>new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,data)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(data);};
      const timer=setTimeout(()=>finish(Error('\u7ba1\u7406\u9801\u9023\u7dda\u903e\u6642\uff0c\u5df2\u505c\u6b62\u5237\u65b0\u3002')),16000);
      const onload=r=>{try{const j=JSON.parse(r.responseText || '{}');if(r.status<200||r.status>=300)finish(Error(j.error || `HTTP ${r.status}`));else finish(null,j);}catch(e){finish(Error('\u7ba1\u7406\u9801\u56de\u61c9\u7121\u6cd5\u8b80\u53d6\u3002'));}};
      try { const req=adapter.xmlHttpRequest({method:'POST',url:cfg.origin+'/api/local',timeout:15000,
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+cfg.token},
        data:JSON.stringify(body),onload,onerror:()=>finish(Error('\u7121\u6cd5\u9023\u5230\u7ba1\u7406\u9801')),ontimeout:()=>finish(Error('\u9023\u7dda\u903e\u6642'))});
        if(req&&typeof req.then==='function') req.then(r=>{if(!settled&&r)onload(r);},e=>finish(Error(e?.message||'Request failed')));
      } catch(e) {finish(e);}
    });
    const task=relayQueue.catch(()=>{}).then(work);relayQueue=task;return task;
  }
  function applyShared(cfg,replaceSelection=false){
    remoteConfig=cfg;
    for(const k of ['name','topic','mode','min','max','fixed','exclude']) settings[k]=cfg[k];
    settings.scheduled=false;
    if(replaceSelection){
      settings.selected=cfg.selected||[];settings.verified=false;
      rows=settings.selected.map(w=>({...w,state:'unknown',reason:'\u5f9e\u5171\u7528\u8a2d\u5b9a\u8b80\u53d6\uff0c\u8acb\u6838\u5c0d\u672c\u6a5f\u9801\u9762'}));
      selected=new Set(settings.selected.map(w=>w.key));
    }
    fillUI();renderStatus();if(replaceSelection)renderRows();
  }
  async function pullShared(){
    const cfg=await relay('sync');applyShared(cfg,true);
    await adapter.setValue(SETTING_PREFIX+settingURL,settings);
    notice('\u5df2\u540c\u6b65\u8a2d\u5b9a\u3002\u8acb\u8b80\u53d6\u7968\u7a2e\uff0c\u6838\u5c0d\u5f8c\u518d\u958b\u59cb\u3002');
  }
  async function saveSharedSelection(){
    if(!link)throw Error('\u8acb\u5148\u914d\u5c0d\u3002');
    readSettingsUI();validate(settings);
    const cfg=await relay('configure',{selected:settings.selected,verified:settings.verified});
    applyShared(cfg,false);await saveSettings();notice('\u7968\u7a2e\u5df2\u5132\u5b58\u5230\u540c\u4e00\u7b46\u76e3\u63a7\uff0c\u5176\u4ed6\u88dd\u7f6e\u53ef\u6309\u540c\u6b65\u3002');
  }
  async function localPermit(){
    const cfg=await relay('heartbeat',{nextAt:runtime.nextAt||null});
    applyShared(cfg,false);
    if(!cfg.running) {await halt('\u7ba1\u7406\u9801\u5df2\u505c\u6b62\u9019\u7b46\u76e3\u63a7\u3002');return false;}
    return true;
  }

  const action=(id,fn)=>$(id).addEventListener('click',async()=>{
    const btn=$(id), oldText=btn.textContent;
    btn.disabled=true;
    if(id==='start') btn.textContent='啟動中…';
    if(id==='scan') btn.textContent='讀取中…';
    if(id==='saveLocalSelection') btn.textContent='儲存中…';
    try { await fn(); } catch(e) {
      const msg=e?.message || String(e);
      notice('無法執行：'+msg);
      setStatus('未啟動：'+msg);
      renderStatus();
      if(id==='start') alert('開始監控失敗：'+msg);
    } finally {
      btn.textContent=oldText;
      if(!runtime.running || id!=='start') btn.disabled=false;
    }
  });
  $('toggle').onclick=()=>panel($('panel').hidden);
  $('collapse').onclick=()=>panel(false);
  $('mode').onchange=updateOptions; $('scheduled').onchange=updateOptions;
  $('showTopic').onchange=()=>{$('topic').type=$('showTopic').checked?'text':'password';};
  $('exclude').onchange=()=>{
    settings.exclude=$('exclude').checked; settings.verified=false; $('verified').checked=false; renderRows();
  };

  action('connectLink',async()=>{
    if(runtime.running)throw Error('\u8acb\u5148\u505c\u6b62\u76e3\u63a7\u3002');
    const code=$('pairInput').value.trim();
    if(!code.startsWith('tcm1.'))throw Error('\u8acb\u8cbc\u4e0a\u7ba1\u7406\u9801\u7522\u751f\u7684\u5b8c\u6574\u914d\u5c0d\u78bc');
    let v;try{const encoded=code.slice(5).replace(/-/g,'+').replace(/_/g,'/');v=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))));}catch{throw Error('\u914d\u5c0d\u78bc\u683c\u5f0f\u4e0d\u6b63\u78ba');}
    if(v.v!==1 || v.origin!==LINK_ORIGIN || !/^[A-Za-z0-9_-]{43}$/.test(v.token || '') || canonicalURL(v.url)!==canonicalURL()) throw Error('\u914d\u5c0d\u78bc\u4e0d\u5c6c\u65bc\u9019\u500b\u5834\u6b21\u6216\u4e0d\u662f\u6307\u5b9a\u7ba1\u7406\u9801');
    const previous=link;link={...v,deviceName:$('deviceName').value.trim().slice(0,40)||'Browser'};
    try{const cfg=await relay('sync');await adapter.setValue('tcm.link.'+settingURL,link);$('pairInput').value='';applyShared(cfg,true);await adapter.setValue(SETTING_PREFIX+settingURL,settings);notice('\u914d\u5c0d\u5b8c\u6210\u3002\u8acb\u8b80\u53d6\u7968\u7a2e\u3001\u6838\u5c0d\u5f8c\u5132\u5b58\u3002');}catch(e){link=previous;throw e;}
  });
  action('pullLink',async()=>{if(runtime.running)throw Error('\u8acb\u5148\u505c\u6b62\u3002');await pullShared();});
  action('saveLocalSelection',async()=>{notice('正在儲存票種…'); await saveSharedSelection();});
  action('unlink',async()=>{await halt('\u5df2\u53d6\u6d88\u672c\u6a5f\u914d\u5c0d\u3002');await adapter.setValue('tcm.link.'+settingURL,null);link=null;remoteConfig=null;renderStatus();});

  action('scan',async()=>{notice('正在讀取票種…'); setStatus('正在讀取票種…'); renderStatus(); await ensureProfile(); await scan();});
  action('start',start);
  action('stop',async()=>{unpick();await halt('已手動停止。');});
  action('retry',sendPending);
  action('testPush',async()=>{
    await ensureProfile(); if (runtime.running) await halt('已停止刷新，先測試通知。'); readSettingsUI();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(settings.topic)) throw Error('先填正確 ntfy Topic，不是網址。');
    if (!isOrder()) throw Error('請在單場票種頁測試，通知才會連到正確頁面。');
    await saveSettings();
    const res=await postNotice(payload(`這是本機監控的測試，不是釋票。\n${new Date().toLocaleString()}`,'test'));
    notice(`測試已交給 ntfy（${String(res.id).slice(0,12)}）。請看平常使用的手機是否收到，並測試通知連結。`);
  });
  action('pick',async()=>{
    await ensureProfile();
    if (!isOrder()) throw Error('請先開啟單場票種頁。');
    if (runtime.running) await halt('已停止，請點選票種。');
    unpick();pickMode=true;
    $('picker').hidden=false;$('pickText').textContent='請點網頁上的一個票種名稱、價格或售完狀態；不會代你購買。';
    notice('請點原售票頁的一列票種。');panel(false);$('toggle').textContent='請點票種 · 取消可按此';
  });
  action('pickAdd',async()=>{
    if (!picked) throw Error('還沒選到完整的票種列。');
    const row=picked;
    if (!rows.some(r=>r.key===row.key)) rows.push(row);
    if (!(settings.exclude&&row.accessible)) selected.add(row.key);
    unpick();panel(true);settings.verified=false;$('verified').checked=false;renderRows();
    notice('已加入這個票種。請核對狀態再開始。');
  });
  action('pickCancel',async()=>{unpick();panel(true);renderStatus();});
  document.addEventListener('click',event=>{
    if (event.composedPath().includes(host)) return;
    if (pickMode) {
      event.preventDefault();event.stopImmediatePropagation();
      const row=findRow(event.target);
      if (picked?.el) picked.el.style.outline=previousOutline;
      if (!row) { picked=null;notice('這個位置沒有完整票種資料。請點包含票種名、價格、售完／數量欄的那一列。');panel(true);return; }
      picked=row;previousOutline=row.el.style.outline;row.el.style.outline='3px solid #0c8276';
      $('pickText').textContent=`${row.label}｜$${row.price}｜${stateLabel(row.state)}\n${row.reason}`;
      $('picker').hidden=false;panel(true);
    } else if (runtime.running) {
      halt('你開始操作售票頁，已停止刷新。').catch(handleError);
    }
  },true);
  document.addEventListener('visibilitychange',()=>{
    if (!runtime.running) return;
    clearTimer();++cycleToken;
    if (document.hidden) {
      if(link)relay('suspend').catch(()=>{});
      runtime.message='分頁不在前景，暫停刷新；回到此頁會重新檢查。';renderStatus();saveRuntime().catch(handleError);
    } else {
      // Let an interrupted scan finish its finally block before starting another.
      const resume=()=>{ if (!runtime.running||document.hidden) return; if (busy) setTimeout(resume,150); else checkAndSchedule().catch(handleError); };
      resume();
    }
  });
  if (!hasGM) {
    setStatus('Tampermonkey 權限不完整：需要 GM 儲存與跨網域請求權限。請重新安裝此腳本。');
    $('start').disabled=true;$('scan').disabled=true;$('testPush').disabled=true;
    return;
  }
  (async()=>{
    localClientId=await adapter.getValue('tcm.clientId','');
    if(!localClientId){ localClientId=uniqueId(); await adapter.setValue('tcm.clientId',localClientId); }
    await ensureProfile();
    const restored=await adapter.getValue(runtimeStorageKey(settingURL),null);
    if (restored&&restored.url===settingURL) {
      runtime={...runtime,...restored,nextAt:0};
      if (runtime.running) {
        if (!settings.selected.length || !settings.verified) await halt('缺少已確認票種設定，已停止。');
        else {notice('已從這個瀏覽器分頁恢復監控。');checkAndSchedule().catch(handleError);}
      }
    } else if (restored?.running) {
      // Do not revive a monitor in a different page after login/checkout navigation.
      runtime={...restored,running:false,nextAt:0,message:'已離開原監控頁，停止刷新。'};
      await saveRuntime();
    }
    renderStatus();
    setInterval(()=>{
      if(link&&runtime.running&&!document.hidden&&!busy)localPermit().catch(e=>halt(e.message));
    },15000);
    setInterval(()=>{
      renderStatus();
      if (canonicalURL()!==settingURL) ensureProfile().catch(handleError);
    },500);
  })().catch(handleError);
})();
