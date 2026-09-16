// ==UserScript==
// @name         Ticket Plus Linked Monitor
// @namespace    local.ticket-monitor.se2
// @version      1.5.2
// @description  Ticket Plus 單場前景監控：選票種、排除身障票、重整後繼續、ntfy 提醒。不代購、不匯出登入資訊。
// @match        https://ticketplus.com.tw/*
// @match        https://www.ticketplus.com.tw/*
// @match        https://*.ticketplus.com.tw/*
// @run-at       document-end
// @inject-into  content
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
  const VERSION = '1.5.2';

  // Ticket Plus may render the ticket picker inside an iframe. The previous
  // implementation only listened in the top document (frame execution disabled + early return),
  // so clicks inside that frame could never reach manual multi-select.
  function setupFrameBridge() {
    let framePickMode = false;
    const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
    const visibleLocal = el => {
      if (!el || el.nodeType !== 1) return false;
      const st = getComputedStyle(el), r = el.getBoundingClientRect();
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const priceLocal = s => {
      const nums = [...clean(s).matchAll(/(?:NT\$|TWD|\$)?\s*([1-9]\d{2,5})(?:\s*元)?/gi)]
        .map(m => Number(m[1].replace(/,/g,''))).filter(n => n >= 100 && n <= 100000);
      return nums[0] || 0;
    };
    const selectorLocal = el => {
      const seg=[];
      for (let n=0; el && el.nodeType===1 && n<14; n++, el=el.parentElement) {
        if (el.id) { seg.unshift('#'+CSS.escape(el.id)); break; }
        const tag=el.tagName.toLowerCase();
        if (tag==='body'||tag==='html') { seg.unshift(tag); break; }
        const sib=el.parentElement?[...el.parentElement.children].filter(x=>x.tagName===el.tagName):[el];
        seg.unshift(`${tag}:nth-of-type(${sib.indexOf(el)+1})`);
      }
      return seg.join(' > ');
    };
    const pickInfo = seed => {
      const first = seed?.nodeType===1 ? seed : seed?.parentElement;
      if (!first || !visibleLocal(first)) return null;
      const path=[]; let el=first;
      for (let i=0; el && i<10 && !el.matches('html'); i++,el=el.parentElement) {
        if (visibleLocal(el)) path.push(el);
        if (el.matches('body')) break;
      }
      if (!path.length) return null;
      const infoText = el => clean(`${el.getAttribute?.('aria-label')||''} ${el.getAttribute?.('title')||''} ${el.innerText||el.textContent||''}`);
      const identityText = t => {
        const core=clean(String(t||'')
          .replace(/(?:NT\$|TWD|\$)?\s*[1-9]\d{2,5}(?:\s*元)?/gi,' ')
          .replace(/已售完|已售罄|售罄|完售|售完|售光|無票|0\s*張|sold\s*out/gi,' '));
        return priceLocal(t)>0 && core.length>=2;
      };
      // If the user clicks only the "售完" badge, climb to the nearest row that also
      // contains the real area/name + price.  The old code captured "售完項目 1",
      // which cannot be re-identified after a reload.
      let chosen = path.find(el=>identityText(infoText(el))) || path.find((el,i)=>{
        const t=infoText(el);
        return t && ((i<=2 && t.length<=280) || (/票|區|price|ticket|area/i.test(t) && t.length<=600));
      }) || path[0];
      const raw=clean(`${chosen.getAttribute?.('aria-label')||''} ${chosen.getAttribute?.('title')||''} ${chosen.innerText||chosen.textContent||''}`);
      if (!raw) return null;
      const price=priceLocal(raw);
      let label=raw
        .replace(/(?:NT\$|TWD|\$)?\s*[1-9]\d{2,5}(?:\s*元)?/gi,' ')
        .replace(/已售完|已售罄|售罄|完售|售完|售光|無票|0\s*張|sold\s*out/gi,' ')
        .replace(/\s+/g,' ').trim();
      if (!label) label = price ? `票價 ${price.toLocaleString()}` : raw.slice(0,100);
      label=label.slice(0,180);
      const sold=/售完|sold\s*out|已售罄|無票|0\s*張/i.test(raw);
      const accessible=/身障|身心障礙|輪椅|陪同|愛心席|accessible|wheelchair/i.test(raw);
      return {label,price,accessible,state:sold?'sold':'unknown',reason:sold?'畫面顯示售完':'手動選取',selector:selectorLocal(chosen),frameUrl:location.href,preview:raw.slice(0,500)};
    };
    const snapshotOne = saved => {
      if (!saved || !saved.selector) return null;
      let el=null; try { el=document.querySelector(saved.selector); } catch(_) {}
      if (!el && saved.label) {
        const needle=clean(saved.label).toLowerCase();
        el=[...document.querySelectorAll('label,li,tr,[role="row"],button,div,span,p')]
          .find(x=>visibleLocal(x) && clean(x.innerText||x.textContent).toLowerCase().includes(needle)) || null;
      }
      if (!el) return {key:saved.key,state:'missing',reason:'iframe 內找不到原本選取項目'};
      let scope=el; for(let i=0;i<5 && scope.parentElement;i++){
        const t=clean(scope.innerText||scope.textContent);
        if (/售完|sold\s*out|已售罄|無票|0\s*張/i.test(t)) return {key:saved.key,state:'sold',reason:'iframe 畫面顯示售完'};
        const sel=scope.querySelector?.('select');
        if (sel && [...sel.options].some(o=>!o.disabled && Number(o.value||o.textContent)>0)) return {key:saved.key,state:'available',reason:'iframe 數量選單有可選數量'};
        const inp=scope.querySelector?.('input[type="number"]');
        if (inp && !inp.disabled && Number(inp.max||0)>0) return {key:saved.key,state:'available',reason:'iframe 數量欄位可選'};
        const plus=[...scope.querySelectorAll?.('button,[role="button"]')||[]].find(b=>!b.disabled && /\+|增加|plus/i.test(clean(b.getAttribute('aria-label')||b.textContent)));
        if (plus) return {key:saved.key,state:'available',reason:'iframe 有可用增加數量控制'};
        scope=scope.parentElement;
      }
      return {key:saved.key,state:'unknown',reason:'iframe 已找到票種，但目前沒有足夠可售證據'};
    };
    const broadcastChildren = msg => {
      for (const f of document.querySelectorAll('iframe')) { try { f.contentWindow?.postMessage(msg,'*'); } catch(_) {} }
    };
    window.addEventListener('message', e=>{
      const d=e.data;
      if (!d || d.__tcmBridge!==1) return;
      if (d.type==='pick-mode') { framePickMode=!!d.active; broadcastChildren(d); }
      if (d.type==='snapshot-request') {
        const here=String(location.href).split('#')[0];
        const rows=(Array.isArray(d.items)?d.items:[]).filter(x=>!x.frameUrl || String(x.frameUrl).split('#')[0]===here).map(snapshotOne).filter(Boolean);
        if (rows.length) window.top.postMessage({__tcmBridge:1,type:'snapshot-response',requestId:d.requestId,rows},'*');
        broadcastChildren(d);
      }
    });
    window.addEventListener('pointerdown', e=>{
      if (!framePickMode) return;
      const path=typeof e.composedPath==='function'?e.composedPath():[];
      const target=path.find(n=>n?.nodeType===1) || e.target;
      const item=pickInfo(target);
      if (!item) return;
      e.preventDefault(); e.stopImmediatePropagation();
      window.top.postMessage({__tcmBridge:1,type:'ticket-pick',item},'*');
    },true);
    window.top.postMessage({__tcmBridge:1,type:'frame-ready',frameUrl:location.href},'*');
  }

  if (window.top !== window.self) { setupFrameBridge(); return; }

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

  function hashTicketIdentity(value) {
    let h = 2166136261;
    for (const ch of String(value || '')) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(36);
  }
  function ticketIdentityKey(label, price=0, explicit='') {
    const cleanLabel = norm(label).toLowerCase();
    const base = explicit ? `id|${explicit}|${Number(price)||0}` : `label|${cleanLabel}|${Number(price)||0}`;
    const shortLabel = cleanLabel.replace(/\s+/g,'').slice(0,36).replace(/[^a-z0-9\u3400-\u9fff_-]/gi,'');
    return `tk:${hashTicketIdentity(base)}:${Number(price)||0}:${shortLabel || 'ticket'}`;
  }

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
  function cleanTicketLabel(source, price=0) {
    let out = norm(source || '');
    if (price) {
      const p = String(price).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      out = out.replace(new RegExp(`(?:NT\\s*\\$|NTD|TWD|\\$)?\\s*${p.replace(/,/g,'[,]?')}\\s*(?:元)?`, 'gi'), ' ');
    }
    return norm(out
      .replace(/(?:NT\s*\$|NTD|TWD|\$)\s*\d[\d,]*|\d[\d,]*\s*元|(?:票價|售價|價格)\s*[:：]?\s*\d[\d,]*/gi, ' ')
      .replace(/(?:庫存(?:量)?|剩餘(?:票券|票數|數量|座位)?|可售(?:票數|數量)?|空位|remaining)\s*[:：]?\s*\d[\d,]*\s*(?:張|席|個|tickets)?/gi, ' ')
      .replace(/已售完|已售罄|售罄|完售|售完|售光|已額滿|額滿|缺貨|尚未開賣|尚未開放|尚未開售|未開賣|暫停販售|停止販售|販售結束|已截止|sold\s*out|not available|unavailable|coming soon|not on sale/gi, ' ')
      .replace(/尚有票券|尚有票|可購買|可選購|available/gi, ' ')
      .replace(/請選擇(?:數量)?|選擇數量|購買數量|數量|增加數量|減少數量|加入購物車|下一步|立即購票/gi, ' ')
      .replace(/[+＋−|]/g, ' ')).slice(0, 180);
  }
  function nearestLeafPrice(seed, scope) {
    const leaves = [...scope.querySelectorAll('span,p,div,td,li,b,strong,label')].filter(x =>
      visible(x) && !x.children.length && prices(text(x)).length === 1
    );
    if (!leaves.length) return null;
    let best = leaves[0], bestScore = 1e9;
    for (const el of leaves) {
      let score = 0, n = seed?.nodeType === 1 ? seed : seed?.parentElement;
      while (n && n !== scope && !n.contains(el)) { score++; n=n.parentElement; if(score>20)break; }
      if (score < bestScore) { bestScore=score; best=el; }
    }
    return prices(text(best))[0] || null;
  }
  function makeRow(el, seed=null, relaxed=false) {
    if (!visible(el)) return null;
    const s = text(el);
    if (s.length < 2 || s.length > (relaxed ? 1400 : 900) || INSTRUCTIONS.test(s)) return null;
    const ps = prices(s);
    if (!ps.length) return null;
    const price = ps.length === 1 ? ps[0] : nearestLeafPrice(seed || el, el);
    if (!price) return null;
    let label = stableName(el, s);
    if (!label || label.length < 2) label = cleanTicketLabel(s, price);
    if (label.length < 2 || !/[a-z\u3400-\u9fff]/i.test(label)) return null;
    const controls = [...el.querySelectorAll(QTY_SELECTOR)].filter(visible);
    const validSelect = controls.find(q => q.tagName === 'SELECT' && enabled(q) &&
      [...q.options].some(o => !o.disabled && /^\d+$/.test(String(o.value).trim()) && Number(o.value) > 0));
    const validInput = controls.find(q => q.tagName !== 'SELECT' && enabled(q) &&
      (!q.hasAttribute('max') || Number(q.getAttribute('max')) > 0));
    const plus = plusControl(el);
    const count = countEvidence(s);
    const disabledQty = controls.length && controls.every(q => !enabled(q));
    let state = 'unknown', reason = '目前沒有明確可購買證據；仍可監控，只有出現可購買證據時才通知';
    if (SOLD.test(s)) { state = 'sold'; reason = '票種列顯示售完／缺貨'; }
    else if (FUTURE.test(s)) { state = 'not_started'; reason = '尚未開賣、暫停或販售結束'; }
    else if (count === 0) { state = 'sold'; reason = '票種列剩餘數量為 0'; }
    else if (validSelect) { state = 'available'; reason = '此票種有可選的正數張數'; }
    else if (validInput) { state = 'available'; reason = '此票種數量欄可操作'; }
    else if (plus) { state = 'available'; reason = '此票種增加張數按鈕啟用'; }
    else if (count > 0) { state = 'available'; reason = `此票種明示剩餘 ${count}`; }
    else if (disabledQty) { state = 'sold'; reason = '此票種數量控制目前不可用'; }
    const semantic = /ticket|price|area|tickettype|product|order/i.test(String(el.className || '')) ||
      el.matches('tr,[role="row"],[data-ticket-id],[data-ticket-type-id],[data-price-id]');
    if (!relaxed && state === 'unknown' && !controls.length && !semantic) return null;
    const explicit = ['data-ticket-id', 'data-ticket-type-id', 'data-price-id', 'data-area-id']
      .map(a => el.getAttribute(a)).find(Boolean);
    const selector = selectorFor(el);
    const key = ticketIdentityKey(label, price, explicit || '');
    return { key, label, price, state, reason, accessible: ACCESSIBLE.test(label), preview: s.slice(0, 300), el, selector };
  }
  function rowEvidence(el) { return makeRow(el, el, false); }
  function findRow(seed, relaxed=false) {
    let el = seed?.nodeType === 1 ? seed : seed?.parentElement;
    let fallback = null;
    for (let n = 0; el && n < 14 && !el.matches('body,html'); n++, el = el.parentElement) {
      if (el.closest(`#${HOST_ID}`)) return null;
      const row = makeRow(el, seed, relaxed);
      if (!row) continue;
      if (row.state !== 'unknown' || el.querySelector(QTY_SELECTOR) || /ticket|price|area/i.test(String(el.className||''))) return row;
      fallback ||= row;
    }
    return fallback;
  }
  function detectRows(root = document) {
    const seeds = new Set(root.querySelectorAll(
      '[data-ticket-id],[data-ticket-type-id],[data-price-id],[class*="ticket"],[class*="Ticket"],[class*="price"],[class*="Price"],' +
      'tr,[role="row"],.v-list-item,select,input[type="number"],[role="spinbutton"],button'
    ));
    for (const el of root.querySelectorAll('span,p,div,td,li,label,strong,b')) {
      if (el.closest(`#${HOST_ID},nav,header,footer,script,style`)) continue;
      const s = norm(el.textContent);
      if (s.length > 0 && s.length < 220 && (prices(s).length || SOLD.test(s) || FUTURE.test(s))) seeds.add(el);
      if (seeds.size >= 1200) break;
    }
    const candidates = new Map();
    for (const seed of seeds) {
      const row = findRow(seed, true);
      if (row) candidates.set(row.el, row);
    }
    const all = [...candidates.values()];
    const minimal = all.filter(a => !all.some(b => a.el !== b.el && a.el.contains(b.el) && b.price === a.price));
    const grouped = new Map();
    for (const row of minimal) {
      const groupKey = `${row.label.toLowerCase()}|${row.price}`;
      if (!grouped.has(groupKey)) grouped.set(groupKey, []);
      grouped.get(groupKey).push(row);
    }
    const out = [];
    for (const group of grouped.values()) {
      const first = group[0];
      if (group.some(r => r.state !== first.state && r.state !== 'unknown' && first.state !== 'unknown'))
        out.push({ ...first, state:'unknown', reason:'同名票種有不同狀態，請手動核對' });
      else out.push(group.find(r=>r.state!=='unknown') || first);
    }
    return out.slice(0, 150);
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
  function manualRowFromTarget(seed) {
    // Manual selection means the user has already told us "this is the thing I want".
    // Do not reject the click just because Ticket Plus separates name/price/status into
    // different DOM nodes. Capture a stable locator plus the nearest useful text.
    const target = seed?.nodeType === 1 ? seed : seed?.parentElement;
    if (!target || target.closest(`#${HOST_ID}`) || !visible(target)) return null;

    const attrText = el => norm([
      el?.getAttribute?.('aria-label'), el?.getAttribute?.('title'),
      el?.getAttribute?.('data-name'), el?.getAttribute?.('data-title'),
      el?.getAttribute?.('data-ticket-name')
    ].filter(Boolean).join(' '));

    const chain=[];
    let el=target;
    for (let n=0; el && n<12 && !el.matches('html'); n++, el=el.parentElement) {
      if (el.closest(`#${HOST_ID}`)) return null;
      if (visible(el)) chain.push(el);
      if (el.matches('body')) break;
    }
    if (!chain.length) return null;

    // Prefer the smallest ancestor that contains a stable ticket identity
    // (real name/area + price). This matters when the actual click target is only
    // a "售完" badge or a price span.
    const identityText = t => {
      const p=prices(t)[0]||0;
      const core=norm(String(t||'')
        .replace(/(?:NT\s*\$|NTD|TWD|\$)?\s*\d[\d,]*\s*(?:元)?/gi,' ')
        .replace(/已售完|已售罄|售罄|完售|售完|售光|無票|0\s*張|sold\s*out/gi,' '));
      return p>0 && core.length>=2;
    };
    let chosen = chain.find(el => identityText(norm(`${attrText(el)} ${text(el)}`))) || chain.find((el,n) => {
      const t=norm(`${attrText(el)} ${text(el)}`);
      if (!t) return false;
      if (n <= 2 && t.length <= 260 && !/^(?:售完|已售完|sold\s*out|無票)$/i.test(t)) return true;
      const hasTicketEvidence = prices(t).length || FUTURE.test(t) ||
        el.querySelector?.(QTY_SELECTOR) || plusControl(el) || /ticket|price|area|product|item|order/i.test(String(el.className||''));
      return hasTicketEvidence && t.length <= 800;
    }) || chain.find(el => norm(`${attrText(el)} ${text(el)}`).length <= 900) || target;

    const chosenText = norm(`${attrText(chosen)} ${text(chosen)}`);
    const targetText = norm(`${attrText(target)} ${text(target)}`);
    const ps = prices(chosenText);
    const price = ps[0] || prices(targetText)[0] || 0;

    let label='';
    const useful = [chosenText, targetText, ...chain.slice(0,7).map(x=>norm(`${attrText(x)} ${text(x)}`))]
      .filter(Boolean);
    for (const t of useful) {
      if (t.length > 180) continue;
      if (prices(t).length && t.replace(/(?:NT\s*\$|NTD|TWD|\$)?\s*\d[\d,]*\s*(?:元)?/gi,'').trim()==='') {
        label = `票價 ${prices(t)[0].toLocaleString()}`;
        break;
      }
      if (SOLD.test(t) && t.length <= 40) continue;
      if (t.length >= 1) { label = cleanTicketLabel(t, price); if (label && !/^(?:售完|已售完|sold\s*out|無票)$/i.test(label)) break; label=''; }
    }
    if (!label) label = price ? `票價 ${price.toLocaleString()}` : `手動票種 ${selected.size+1}`;

    const s = chosenText || targetText || label;
    const controls=[...chosen.querySelectorAll?.(QTY_SELECTOR) || []].filter(visible);
    const validSelect=controls.find(q=>q.tagName==='SELECT' && enabled(q) && [...q.options].some(o=>!o.disabled && /^\d+$/.test(String(o.value).trim()) && Number(o.value)>0));
    const validInput=controls.find(q=>q.tagName!=='SELECT' && enabled(q) && (!q.hasAttribute('max') || Number(q.getAttribute('max'))>0));
    const plus=plusControl(chosen), count=countEvidence(s);
    let state='unknown', reason='已手動指定這個項目；等待頁面顯示可購買／售完證據';
    if (SOLD.test(s) || count===0) { state='sold'; reason='所選區塊顯示售完或剩餘 0'; }
    else if (FUTURE.test(s)) { state='not_started'; reason='所選區塊顯示尚未開賣、暫停或販售結束'; }
    else if (validSelect || validInput || plus || count>0) { state='available'; reason='所選區塊有可操作數量或明示剩餘票'; }

    const selector = selectorFor(chosen);
    const targetSelector = selectorFor(target);
    const explicit = ['data-ticket-id','data-ticket-type-id','data-price-id','data-area-id']
      .map(a=>chosen.getAttribute?.(a) || target.getAttribute?.(a)).find(Boolean);
    const key = ticketIdentityKey(label, price, explicit || '');
    return {key,label,price,state,reason,accessible:ACCESSIBLE.test(`${label} ${s}`),preview:s.slice(0,500),el:chosen,selector:selector || targetSelector,frameUrl:location.href};
  }
  function evidenceForSaved(saved) {
    let el = null;
    if (saved?.selector) {
      try { el = document.querySelector(saved.selector); } catch (_) { el = null; }
    }
    if (!el && saved?.label) {
      const needle = norm(saved.label).toLowerCase();
      const candidates = [...document.querySelectorAll('[data-ticket-id],[data-ticket-type-id],[data-price-id],[class*="ticket"],[class*="price"],tr,[role="row"],.v-list-item,label,li,button,span,p')];
      el = candidates.find(x => visible(x) && norm(text(x)).toLowerCase().includes(needle)) || null;
    }
    if (!el) return null;
    const row=makeRow(el,el,true) || manualRowFromTarget(el);
    if (!row) return null;
    return {...row,key:saved.key,label:saved.label || row.label,price:saved.price || row.price || 0,accessible:!!saved.accessible,selector:saved.selector || row.selector};
  }
  async function saveSelectionDraft() {
    settings.selected = selectedRowsForSave();
    settings.verified = false;
    try { await adapter.setValue(SETTING_PREFIX + settingURL, settings); } catch (_) {}
    renderSelectionSummary();
  }

  const serialRow = r => ({ key: r.key, label: r.label, price: r.price, accessible: r.accessible, selector:r.selector || selectorFor(r.el), frameUrl:r.frameUrl || '' });

  function dedupeTicketRows(list=[]) {
    const out = new Map();
    for (const item of Array.isArray(list) ? list : []) {
      if (!item) continue;
      const row = {...item};
      row.price = Number(row.price) || 0;
      row.label = norm(row.label || (row.price ? `票價 ${row.price.toLocaleString()}` : '票種'));
      row.key = String(row.key || '').startsWith('tk:') ? row.key : ticketIdentityKey(row.label, row.price, '');
      if (!out.has(row.key)) out.set(row.key, row);
      else {
        const old = out.get(row.key);
        out.set(row.key, {
          ...old,
          selector: old.selector || row.selector || '',
          frameUrl: old.frameUrl || row.frameUrl || '',
          accessible: !!(old.accessible || row.accessible)
        });
      }
    }
    return [...out.values()];
  }
  function selectedRowsForSave() {
    const current = rows.filter(r => selected.has(r.key)).map(serialRow);
    const fallback = (settings.selected || []).filter(r => selected.has(r.key));
    return dedupeTicketRows(current.length ? current : fallback);
  }
  async function removeSelectedTicket(key) {
    if (runtime.running) await halt('已停止監控，因為你修改了票種。');
    const row = rows.find(r => r.key === key) || (settings.selected || []).find(r => r.key === key);
    selected.delete(key);
    settings.selected = dedupeTicketRows((settings.selected || []).filter(r => r.key !== key));
    rows = rows.filter(r => r.key !== key);
    settings.verified = false;
    if ($('verified')) $('verified').checked = false;
    renderRows();
    await saveSelectionDraft();
    notice(`已刪除：${row?.label || '票種'}。目前剩 ${selected.size} 個。`);
  }
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
      #toggle{position:fixed;bottom:12px;left:10px;z-index:2147483647;background:#14334d;color:white;box-shadow:0 3px 10px #0003}#toggle.running{background:#087a55;border-color:#087a55}#toggle.stopped{background:#14334d}
      #panel{position:fixed;z-index:2147483647;bottom:64px;left:8px;width:calc(100vw - 16px);max-width:440px;max-height:82vh;overflow:auto;-webkit-overflow-scrolling:touch;border:1px solid #bac7d4;border-radius:14px;background:#fff;box-shadow:0 8px 35px #0004;padding:12px;padding-bottom:0}
      #panel[hidden]{display:none}#stateCard{padding:10px;border-radius:10px;border:1px solid #cbd6df;background:#f4f7fa;margin:8px 0}#stateCard.running{background:#ebfaf4;border-color:#5ab99b}#stateCard.stopped{background:#f7f8fa;border-color:#ccd3da}#stateCard.error{background:#fff0ee;border-color:#dc8c82}#runTitle{font-size:15px}#status{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}#selectionSummaryTop{margin-top:6px;font-size:12px;color:#42596d;overflow-wrap:anywhere}#actionBar{position:sticky;bottom:0;margin:12px -12px 0;padding:10px 12px;background:#fff;border-top:1px solid #dce4ea;box-shadow:0 -5px 14px #00000012;z-index:5}
      .line{display:flex;gap:7px;align-items:center;margin:8px 0}.line>*{flex:1}.line input[type=checkbox]{flex:none}.top{justify-content:space-between}.top strong{font-size:16px}
      .primary{background:#11656c;color:#fff;border-color:#11656c}.danger{background:#ad3636;color:#fff;border-color:#ad3636}
      .small{font-size:12px;color:#516476}.warn{font-size:12px;color:#8b4e10}.ticket{padding:8px;border:1px solid #dde5ec;border-radius:9px;margin:6px 0;display:flex;gap:8px;align-items:flex-start}
      .ticket span{overflow-wrap:anywhere}.ticket.selected{border-color:#0c8276;background:#effcf8}.ticket b{font-size:14px}.ticket small{display:block;color:#516476}.ticket:has(input:disabled){opacity:.6}
      .ok{color:#14745d}.bad{color:#a33b32}#notice{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
      #selectedManager{display:grid;gap:6px;margin:6px 0 10px}.selectedManageItem{display:flex;gap:8px;align-items:center;padding:7px 8px;border:1px solid #d9e2e8;border-radius:9px;background:#fff}.selectedManageItem span{flex:1;overflow-wrap:anywhere}.removeTicket{flex:none;min-height:32px;padding:5px 9px;border-color:#d3a4a4;color:#9a2f2f;background:#fff6f6}
      summary{cursor:pointer;padding:8px 0}#picker{border:2px solid #0c8276;padding:8px;background:#effcf8;border-radius:8px}
    </style>
    <button type="button" id="toggle">監票</button>
    <section id="panel">
      <div class="line top"><strong>Ticket Plus 電腦 / SE2 監控</strong><button type="button" id="collapse">收合</button></div>
      <div class="small">${VERSION} · 票種去重／可刪除版 · 本機執行</div>
      <div id="stateCard" class="stopped">
        <div class="line top"><strong id="runTitle">⏹ 已停止</strong><span id="runChecks" class="small">0 次</span></div>
        <p id="status">正在啟動…</p>
        <div id="selectionSummaryTop">已選 0 個票種</div>
      </div>
      <p id="notice"></p><p id="debugAction" class="small">最後操作：尚未操作</p>
      <details id="linkDetails"><summary>連到原本的管理頁（電腦 / SE2 共用）</summary>
      <p id="linkState" class="small">未配對；單機設定不會自動同步。</p>
      <label>這台裝置名稱<input id="deviceName" maxlength="40" placeholder="Windows 或 SE2"></label>
      <label>貼上管理頁產生的配對碼<input id="pairInput" type="password" autocomplete="off" placeholder="tcm1...."></label>
      <div class="line"><button type="button" id="connectLink">配對</button><button type="button" id="pullLink">同步共用設定</button></div>
      <button type="button" id="saveLocalSelection">儲存票種到管理頁</button>
      <button type="button" id="unlink">取消這台裝置配對</button>
      <p class="small">配對後，名稱、頻率、時段、Topic 由管理頁統一設定。售票網站登入狀態留在這台裝置，不會上傳。</p></details>

      <div class="line"><button type="button" id="scan">自動讀取票種</button><button type="button" id="pick">手動多選票種</button></div>
      <div id="picker" hidden>
        <div id="pickText">面板會收起。請在售票頁連續點選一個或多個票種名稱、價格或該票種區塊；不要求名稱與價格必須在同一列。每點一次立即加入／取消，完成後按左下角「已選 X 個｜點我完成」。</div>
        <div class="line"><button type="button" id="pickAdd">完成選擇</button><button type="button" id="pickCancel">取消</button></div>
      </div>
      <label><input id="exclude" type="checkbox" checked> 排除身障／輪椅／陪同票</label>
      <div id="selectionSummary" style="padding:8px;background:#f4f7fa;border-radius:8px;margin:8px 0">已選 0 個票種</div>
      <div id="selectedManager"></div>
      <div class="line"><button type="button" id="selectAll">全選一般票種</button><button type="button" id="clearSelection">全部清除</button></div>
      <div id="tickets"><p class="small">先按「讀取票種」，再用勾選框一次選擇一個或多個票種。</p></div>
      <label><input id="verified" type="checkbox"> 我已核對票種名稱和狀態與網頁相符</label>
      <label>通知名稱<input id="name" maxlength="80" placeholder="例如：遠大演唱會"></label>
      <label>ntfy Topic<input id="topic" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="填原本手機訂閱的 Topic"></label>
      <div class="line"><label><input id="showTopic" type="checkbox"> 顯示 Topic</label><button type="button" id="testPush">測試通知</button></div>
      <details><summary>刷新時間與進階設定</summary>
        <label>刷新模式<select id="mode"><option value="random">隨機間隔</option><option value="fixed">固定間隔</option></select></label>
        <div class="line" id="randomFields"><label>最短秒數<input id="min" type="number" min="1" max="3600" value="1"></label><label>最長秒數<input id="max" type="number" min="1" max="3600" value="5"></label></div>
        <label id="fixedFields" hidden>固定秒數<input id="fixed" type="number" min="1" max="3600" value="5"></label>
        <label><input id="scheduled" type="checkbox"> 限定開始／結束時間（本機時區）</label>
        <div id="scheduleFields" hidden><label>開始<input id="startAt" type="datetime-local"></label><label>結束<input id="endAt" type="datetime-local"></label></div>
        <label><input id="pauseAlerts" type="checkbox" checked> 讀不到票種或需要登入時也通知</label>
        <label><input id="sound" type="checkbox"> 嘗試 本機提示音（重整後可能無聲）</label>
        <p class="warn">間隔在頁面載入、讀取完成後才開始計時。秒數過短可能觸發網站暫停存取；看到限制頁時請立即停止。</p>
      </details>
      <button type="button" id="retry" hidden>重送未成功的通知</button>
      <div class="small">只讀畫面，不選位、不加張數、不下單。找到有票會先停止刷新。請讓這個瀏覽器分頁保持前景。</div>
      <div id="actionBar"><div class="line"><button type="button" id="start" class="primary">開始監控</button><button type="button" id="stop" class="danger">停止</button></div></div>
    </section>`;
  const $ = id => shadow.getElementById(id);
  let settings = { name:'Ticket Plus 票況', topic:'', exclude:true, mode:'random', min:1, max:5, fixed:5, scheduled:false, startAt:'', endAt:'', pauseAlerts:true, sound:false, selected:[], verified:false };
  let runtime = { url:'', running:false, checks:0, message:'待設定', nextAt:0, pending:null };
  let rows = [], selected = new Set(), settingURL = '', loadingProfile = false;
  let cycleToken = 0, reloadTimer = null, busy = false, audioContext = null;
  let pickMode = false, picked = null, previousOutline = '';
  const manualOutlines = new Map();
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
    const seconds = runtime.running && runtime.nextAt ? Math.max(0, Math.ceil((runtime.nextAt-clock())/1000)) : null;
    const title = runtime.running ? `🟢 監控中${seconds!==null ? ` · ${seconds} 秒` : ''}` : (/錯誤|失敗|限制|驗證|無法|缺少/.test(runtime.message||'') ? '🔴 已停止' : '⏹ 已停止');
    $('runTitle').textContent = title;
    $('runChecks').textContent = `${Number(runtime.checks||0)} 次`;
    $('stateCard').classList.toggle('running', !!runtime.running);
    $('stateCard').classList.toggle('stopped', !runtime.running);
    $('stateCard').classList.toggle('error', !runtime.running && /錯誤|失敗|限制|驗證|無法|缺少/.test(runtime.message||''));
    $('toggle').textContent = runtime.running ? `監票 · 執行中${seconds!==null ? ` · ${seconds}秒` : ''}` : '監票 · 已停止';
    $('toggle').classList.toggle('running', !!runtime.running);
    $('toggle').classList.toggle('stopped', !runtime.running);
    $('start').textContent = runtime.running ? '監控中 ✓' : '開始監控';
    $('stop').disabled = !runtime.running;
    $('retry').hidden = !runtime.pending || !!link;
    $('linkState').textContent=link ? '已配對：'+(remoteConfig?.name || settings.name)+'（同一筆監控）' : '未配對；單機設定不會自動同步。';
    $('start').disabled = !!runtime.running;
    for (const id of ['name','topic','exclude','verified','mode','min','max','fixed','scheduled','startAt','endAt','pauseAlerts','sound'])
      $(id).disabled = !!runtime.running || (!!link && ['name','topic','exclude','mode','min','max','fixed','scheduled','startAt','endAt'].includes(id));
    renderSelectionSummary();
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
    settings.selected = selectedRowsForSave();
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
  function renderSelectionSummary() {
    let chosen = rows.filter(r => selected.has(r.key));
    if (!chosen.length && Array.isArray(settings.selected) && settings.selected.length)
      chosen = settings.selected.filter(r => selected.has(r.key) || !selected.size);
    chosen = dedupeTicketRows(chosen);
    const textValue = chosen.length
      ? `已選 ${chosen.length} 個：${chosen.map(r => r.price ? `${r.label} $${Number(r.price).toLocaleString()}` : r.label).join('、')}`
      : '已選 0 個票種';
    const box = $('selectionSummary'); if (box) box.textContent = textValue;
    const top = $('selectionSummaryTop'); if (top) top.textContent = textValue;
    const manager = $('selectedManager');
    if (manager) {
      manager.replaceChildren();
      for (const row of chosen) {
        const item=document.createElement('div'); item.className='selectedManageItem';
        const name=document.createElement('span');
        name.textContent=row.price ? `${row.label} · $${Number(row.price).toLocaleString()}` : row.label;
        const del=document.createElement('button'); del.type='button'; del.className='removeTicket'; del.textContent='刪除';
        del.addEventListener('click', e=>{ e.preventDefault(); e.stopPropagation(); removeSelectedTicket(row.key).catch(handleError); });
        item.append(name,del); manager.appendChild(item);
      }
    }
  }

  function renderRows() {
    const list = $('tickets');
    list.replaceChildren();
    if (!rows.length) {
      const p = document.createElement('p'); p.className = 'small';
      p.textContent = '尚未辨識到票種。可等網頁載入後再讀取，或按「手動多選票種」。';
      list.appendChild(p); renderSelectionSummary(); return;
    }
    for (const row of rows) {
      const label = document.createElement('label'); label.className='ticket';
      const box = document.createElement('input'); box.type='checkbox';
      box.checked = selected.has(row.key);
      box.disabled = !!(settings.exclude && row.accessible) || runtime.running;
      if (settings.exclude && row.accessible) { box.checked=false; selected.delete(row.key); }
      box.addEventListener('change', () => {
        if (box.checked) selected.add(row.key); else selected.delete(row.key);
        label.classList.toggle('selected', box.checked);
        settings.verified=false; $('verified').checked=false;
        renderSelectionSummary();
        notice(box.checked ? `已加入：${row.label}。目前共選 ${selected.size} 個。` : `已取消：${row.label}。目前共選 ${selected.size} 個。`);
        $('debugAction').textContent=`最後操作：${box.checked?'勾選':'取消'} ${row.label}`;
        saveSelectionDraft().catch(()=>{});
      });
      const span = document.createElement('span'), b = document.createElement('b'), small = document.createElement('small');
      b.textContent = row.price ? `${row.label} · $${row.price.toLocaleString()}` : row.label;
      small.textContent = `${stateLabel(row.state)}${row.accessible ? ' · 特殊席' : ''}｜${row.reason || ''}`;
      span.append(b, small); label.append(box,span); label.classList.toggle('selected', box.checked); list.appendChild(label);
    }
    renderSelectionSummary();
  }
  function validateSelection(s) {
    if (!isOrder()) throw Error('請在登入後的 Ticket Plus /order/ 單場票種頁使用。');
    if (!s.selected.length) throw Error('請先加入或勾選至少一個一般票種。');
    if (!s.verified) throw Error('請勾選「我已核對票種名稱和狀態」。');
  }
  function validate(s) {
    if (!isOrder()) throw Error('請在登入後的 Ticket Plus /order/ 單場票種頁使用，不是活動首頁。');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(s.topic)) throw Error('ntfy Topic 請填原本訂閱的名稱，只能用英數、-、_，不是網址。');
    for (const k of [s.mode === 'fixed' ? 'fixed' : 'min', ...(s.mode === 'random' ? ['max'] : [])])
      if (!Number.isInteger(s[k]) || s[k]<1 || s[k]>3600) throw Error('秒數請填 1～3600 的整數。');
    if (s.mode==='random' && s.min>s.max) throw Error('最短秒數不能大於最長秒數。');
    validateSelection(s);
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
    // Keep the prominent notice in sync with the real runtime state.
    // Previously it could still say "監控已開始" after the safety stop fired.
    notice(message);
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
          const candidate = evidenceForSaved(saved);
          if (candidate) { current.push(candidate); map.set(saved.key,candidate); }
        } catch (_) { /* Stale selector is not a ticket match. */ }
      }
      // Frame-aware manual selection: selected ticket controls may live inside an iframe.
      const frameEvidence=await requestFrameSnapshots(settings.selected.filter(w=>w.frameUrl && !map.has(w.key)));
      for (const [k,v] of frameEvidence) if (!map.has(k)) map.set(k,{...(settings.selected.find(w=>w.key===k)||{}),...v});
      // Match by stable ticket name/price or a website-provided ID; never by list position.
      lastRows=settings.selected.map(w=>map.get(w.key) || {...w,state:'missing',reason:'這次頁面沒有找到原本勾選的票種'});
      const missing=lastRows.some(r=>r.state==='missing');
      const stamp=rowStamp(lastRows);
      if (!missing && lastRows.length && stamp===previous) same++; else same=0;
      previous=stamp;
      if (same>=1) return { all:current, watched:lastRows };
      runtime.message=missing?'正在等待票種載入／辨識（最多 30 秒）':'正在確認票種狀態…';
      renderStatus(); await sleep(800);
    }
    const missing=lastRows.filter(r=>r.state==='missing').map(r=>r.label).join('、');
    throw Error(`30 秒內無法重新辨識已選票種：${missing || '頁面沒有完整票況'}。為避免監錯票區已停止；請重新選一次該票種。`);
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
  function broadcastPickMode(active) {
    const msg={__tcmBridge:1,type:'pick-mode',active:!!active};
    for (const f of document.querySelectorAll('iframe')) { try { f.contentWindow?.postMessage(msg,'*'); } catch(_) {} }
  }
  function normalizeFrameRow(item) {
    if (!item) return null;
    const label=norm(item.label || (item.price?`票價 ${Number(item.price).toLocaleString()}`:'手動票種'));
    const price=Number(item.price)||0;
    const frameUrl=String(item.frameUrl||'');
    const selector=String(item.selector||'');
    const key=ticketIdentityKey(label, price, '');
    return {key,label,price,state:item.state||'unknown',reason:item.reason||'手動選取',accessible:!!item.accessible,preview:String(item.preview||'').slice(0,500),el:null,selector,frameUrl};
  }
  async function toggleManualRow(row, source='頁面') {
    if (!row) return;
    $('debugAction').textContent=`最後操作：${source}選取「${row.label}」（${new Date().toLocaleTimeString()}）`;
    row={...row,key:ticketIdentityKey(row.label, Number(row.price)||0, '')};
    rows=dedupeTicketRows([...rows,row]);
    if (settings.exclude && row.accessible) {
      $('toggle').textContent='已排除身障／輪椅票';
      setTimeout(()=>{ if(pickMode)$('toggle').textContent=`已選 ${selected.size} 個｜點我完成`; },1200);
      return;
    }
    const removing=selected.has(row.key);
    if (removing) {
      selected.delete(row.key);
      if (row.el && manualOutlines.has(row.el)) { row.el.style.outline=manualOutlines.get(row.el); manualOutlines.delete(row.el); }
    } else {
      selected.add(row.key);
      if (row.el) { if (!manualOutlines.has(row.el)) manualOutlines.set(row.el,row.el.style.outline); row.el.style.outline='3px solid #0c8276'; }
    }
    settings.verified=false; $('verified').checked=false;
    renderSelectionSummary();
    saveSelectionDraft().catch(()=>{});
    $('toggle').textContent=`已選 ${selected.size} 個｜點我完成`;
    notice(`${removing?'已取消':'已加入'}：${row.label}${row.price ? ` · $${Number(row.price).toLocaleString()}` : ''}（目前 ${selected.size} 個）`);
  }
  const frameSnapshotWaiters=new Map();
  window.addEventListener('message',e=>{
    const d=e.data;
    if(!d || d.__tcmBridge!==1) return;
    if(d.type==='ticket-pick' && pickMode) {
      const row=normalizeFrameRow(d.item);
      toggleManualRow(row,'iframe').catch(handleError);
      return;
    }
    if(d.type==='frame-ready' && pickMode) { try { e.source?.postMessage({__tcmBridge:1,type:'pick-mode',active:true},'*'); } catch(_) {} return; }
    if(d.type==='snapshot-response' && d.requestId && frameSnapshotWaiters.has(d.requestId)) {
      const rec=frameSnapshotWaiters.get(d.requestId); for(const r of (d.rows||[])) rec.rows.set(r.key,r);
    }
  });
  async function requestFrameSnapshots(items) {
    const wanted=(items||[]).filter(x=>x.frameUrl);
    if(!wanted.length) return new Map();
    const requestId=`snap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const rec={rows:new Map()}; frameSnapshotWaiters.set(requestId,rec);
    const msg={__tcmBridge:1,type:'snapshot-request',requestId,items:wanted};
    for (const f of document.querySelectorAll('iframe')) { try { f.contentWindow?.postMessage(msg,'*'); } catch(_) {} }
    await sleep(300);
    frameSnapshotWaiters.delete(requestId);
    return rec.rows;
  }
  function unpick() {
    if (picked?.el) picked.el.style.outline=previousOutline;
    for (const [el, outline] of manualOutlines) { try { el.style.outline=outline; } catch(_) {} }
    manualOutlines.clear();
    picked=null; pickMode=false; broadcastPickMode(false); $('picker').hidden=true;
    $('toggle').textContent = runtime.running ? '監票 · 執行中' : '監票 · 已停止';
  }
  async function scan() {
    if (runtime.running) await halt('已停止刷新，重新讀取票種。');
    const gate=pageGate(); if (gate) throw Error(gate);
    if (!isOrder()) throw Error('請先在 Ticket Plus 打開單場 /order/ 票種頁。');
    const detected=detectRows();
    settings.selected=dedupeTicketRows(settings.selected);
    const old=new Set(settings.selected.map(r=>r.key));
    if (detected.length) {
      rows=detected;
      selected=new Set(rows.filter(r=>old.has(r.key) && !(settings.exclude&&r.accessible)).map(r=>r.key));
    } else {
      rows=settings.selected.map(w=>({...w,state:'unknown',reason:'已保留先前選擇；自動讀取目前找不到這一列'}));
      selected=new Set(rows.filter(r=>!(settings.exclude&&r.accessible)).map(r=>r.key));
    }
    settings.verified=false; $('verified').checked=false;
    renderRows();
    await saveSelectionDraft();
    notice(detected.length?`讀到 ${detected.length} 個候選票種。可一次勾選多個。`:'自動辨識目前找不到票種；已保留先前選擇。請改用「手動多選票種」直接點票種列。');
  }
  async function start() {
    notice('正在啟動監控…');
    setStatus('啟動中：正在確認設定…');
    renderStatus();
    await ensureProfile();
    if (runtime.running) { notice('目前已經在監控中。'); return; }
    readSettingsUI(); validate(settings);
    await saveSettings();
    const savedPending=runtime.pending;
    if (savedPending && !confirm('還有未確認送達的通知。開始新監控會清除這筆待重送通知，確定嗎？')) return;
    ++cycleToken; clearTimer();
    runtime={localRunId:'',url:canonicalURL(),running:true,checks:0,message:'🟢 監控已啟動：正在連接管理頁並確認票種…',nextAt:0,pending:null};
    renderStatus(); renderRows();
    await saveRuntime();
    try {
      if(link){
        const gate=pageGate(); if(gate) throw Error(gate);
        await saveSharedSelection();
        const cfg=await relay('begin');
        runtime.localRunId=cfg.runId || '';
        applyShared(cfg,false);
      }
      runtime.message='🟢 監控中：正在確認票種狀態…';
      renderStatus();
      notice('✅ 監控已開始。下方按鈕會維持「監控中 ✓」，左下角也會顯示執行中。');
      await saveRuntime(); await beep();
      checkAndSchedule().catch(handleError);
    } catch(e) {
      runtime.running=false; runtime.nextAt=0; runtime.message=`啟動失敗：${e?.message || e}`;
      renderStatus(); await saveRuntime(); throw e;
    }
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
      settings.selected=dedupeTicketRows(settings.selected);
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
      const incoming=dedupeTicketRows(cfg.selected||[]);
      const oldKeys=(settings.selected||[]).map(w=>w.key).sort().join('\n');
      const newKeys=incoming.map(w=>w.key).sort().join('\n');
      const keepVerified=!!settings.verified && oldKeys===newKeys && !!newKeys;
      settings.selected=incoming;settings.verified=keepVerified;
      rows=settings.selected.map(w=>({...w,state:'unknown',reason:'從共用設定讀取，等待本機頁面確認'}));
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
    readSettingsUI();
    settings.selected=dedupeTicketRows(settings.selected);
    selected=new Set(settings.selected.map(r=>r.key));
    validateSelection(settings);
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
    $('debugAction').textContent=`最後操作：${oldText}（${new Date().toLocaleTimeString()}）`;
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
      if(id==='start') {
        btn.textContent = runtime.running ? '監控中 ✓' : oldText;
      } else {
        btn.textContent=oldText;
      }
      if(!runtime.running || id!=='start') btn.disabled=false;
      renderStatus();
    }
  });
  $('toggle').onclick=()=>{
    if (pickMode) { unpick(); panel(true); renderRows(); notice(`手動選擇完成，目前已選 ${selected.size} 個票種。請核對清單後勾選「我已核對」。`); return; }
    panel($('panel').hidden);
  };
  $('collapse').onclick=()=>panel(false);
  $('mode').onchange=updateOptions; $('scheduled').onchange=updateOptions;
  $('showTopic').onchange=()=>{$('topic').type=$('showTopic').checked?'text':'password';};
  $('exclude').onchange=()=>{
    settings.exclude=$('exclude').checked; settings.verified=false; $('verified').checked=false; renderRows();
  };
  $('verified').onchange=()=>{ settings.verified=$('verified').checked; adapter.setValue(SETTING_PREFIX+settingURL,{...settings,selected:selectedRowsForSave()}).catch(()=>{}); notice($('verified').checked ? `已確認目前選擇：${selected.size} 個票種。` : '已取消票種核對。'); };

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
  action('saveLocalSelection',async()=>{notice(`正在儲存 ${selected.size} 個票種…`); await saveSharedSelection();});
  action('unlink',async()=>{await halt('\u5df2\u53d6\u6d88\u672c\u6a5f\u914d\u5c0d\u3002');await adapter.setValue('tcm.link.'+settingURL,null);link=null;remoteConfig=null;renderStatus();});

  action('scan',async()=>{notice('正在讀取票種…'); setStatus('正在讀取票種…'); renderStatus(); await ensureProfile(); await scan();});
  action('selectAll',async()=>{
    if (runtime.running) await halt('已停止監控，準備修改票種。');
    selected = new Set(rows.filter(r => !(settings.exclude && r.accessible)).map(r => r.key));
    settings.verified=false; $('verified').checked=false; renderRows(); await saveSelectionDraft();
    notice(`已選 ${selected.size} 個一般票種。請核對後勾選「我已核對」。`);
  });
  action('clearSelection',async()=>{
    if (runtime.running) await halt('已停止監控，準備修改票種。');
    selected.clear(); settings.selected=[]; settings.verified=false; $('verified').checked=false; renderRows(); await saveSelectionDraft();
    notice('已清除所有票種選擇。');
  });
  action('start',start);
  action('stop',async()=>{unpick();setStatus('正在停止監控…');renderStatus();await halt('⏹ 已手動停止監控。');notice('已停止，不會再自動重新整理。');});
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
    if (runtime.running) await halt('已停止，準備手動選票種。');
    unpick(); pickMode=true; broadcastPickMode(true);
    $('picker').hidden=false;
    $('pickText').textContent='已進入連續多選：支援主頁與 iframe 內票種。每點一次都會加入／取消；完成後按左下角按鈕。';
    const frameCount=document.querySelectorAll('iframe').length;
    $('debugAction').textContent=`最後操作：手動多選已啟動（目前頁面有 ${frameCount} 個 iframe）`;
    notice(`手動多選中：可直接點主頁或內嵌票種區塊；每點一次都會加入／取消並立即顯示數量。偵測到 ${frameCount} 個 iframe。`);
    panel(false); $('toggle').textContent=`已選 ${selected.size} 個｜點我完成`;
  });
  action('pickAdd',async()=>{ unpick(); panel(true); renderRows(); await saveSelectionDraft(); notice(`手動選擇完成，目前已選 ${selected.size} 個票種。`); });
  action('pickCancel',async()=>{unpick();panel(true);renderRows();renderStatus();});
  window.addEventListener('pointerdown',event=>{
    const path=typeof event.composedPath==='function'?event.composedPath():[];
    if (path.includes(host)) return;
    if (pickMode) {
      event.preventDefault(); event.stopImmediatePropagation();
      const target=path.find(n=>n?.nodeType===1) || event.target;
      const row=manualRowFromTarget(target);
      if (!row) {
        $('toggle').textContent=`這個位置沒有可用文字｜已選 ${selected.size} 個`;
        setTimeout(()=>{ if(pickMode)$('toggle').textContent=`已選 ${selected.size} 個｜點我完成`; },1200);
        return;
      }
      toggleManualRow(row,'主頁').catch(handleError);
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
    if (link) {
      try {
        const cfg=await relay('sync');
        applyShared(cfg,true);
        await adapter.setValue(SETTING_PREFIX+settingURL,settings);
      } catch(e) { notice('管理頁同步失敗：'+(e?.message||e)); }
    }
    const restored=await adapter.getValue(runtimeStorageKey(settingURL),null);
    if (restored&&restored.url===settingURL) {
      runtime={...runtime,...restored,nextAt:0};
      if (runtime.running) {
        if (!settings.selected.length || !settings.verified) await halt('缺少已確認票種設定，已停止。');
        else {
          runtime.message='監控中：頁面已重新載入，正在確認票種…';
          notice('✅ 監控仍在執行；這次重新整理是監控流程的一部分。');
          renderStatus();
          checkAndSchedule().catch(handleError);
        }
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
