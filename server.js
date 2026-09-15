import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'monitors.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MIN_SECONDS = Math.max(1, Math.min(86400, Math.ceil(Number(process.env.MIN_SECONDS) || 1)));
const TZ = process.env.TZ || 'Asia/Taipei';

await fs.mkdir(DATA_DIR, { recursive: true });

const app = express();
for (const verb of ['get', 'post', 'put', 'delete']) {
  const register = app[verb].bind(app);
  app[verb] = (...args) => register(...args.map(arg =>
    typeof arg === 'function' ? (req, res, next) => Promise.resolve().then(() => arg(req, res, next)).catch(next) : arg));
}
app.use(express.json({ limit: '512kb' }));

if (ADMIN_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    const auth = req.headers.authorization || '';
    const expected = `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64')}`;
    if (auth !== expected) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Ticket Monitor"');
      return res.status(401).send('Authentication required');
    }
    next();
  });
}

app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(process.cwd(), 'public'), { etag: false, maxAge: 0 }));

let browser;
async function getBrowser() {
  if (browser?.isConnected()) return browser;
  if (!browserLaunch) {
    const options = { headless: true };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    browserLaunch = chromium.launch(options).then(b => { browser = b; return b; }).finally(() => { browserLaunch = null; });
  }
  return browserLaunch;
}

// KKTIX diagnostics v3.1: ordinary browser state only, no anti-bot bypass.
const BUILD_VERSION = '3.1.0-kktix-diagnostics';
const DIAGNOSTICS_DIR = path.join(DATA_DIR, 'diagnostics');
const SESSION_DIR = path.join(DATA_DIR, 'browser-sessions');
await fs.mkdir(DIAGNOSTICS_DIR, { recursive: true, mode: 0o700 });
await fs.mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
const kktixSessions = new Map();
const activeInspections = new Set();
const activeRuns = new Set();
let browserLaunch;
let shuttingDown = false;

function diagnosticKey(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex');
}
function sessionFile(id) { return path.join(SESSION_DIR, `${diagnosticKey(id)}.json`); }
function imageFile(id) { return path.join(DIAGNOSTICS_DIR, `${diagnosticKey(id)}.jpg`); }
function safePageUrl(value) {
  try {
    const u = new URL(value);
    u.username = ''; u.password = ''; u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/token|auth|key|hash|session|password|email|code/i.test(k)) u.searchParams.set(k, '[redacted]');
    }
    return u.toString();
  } catch { return ''; }
}
function monitorError(code, message, pause = true) {
  const error = new Error(message);
  error.code = code; error.pause = pause;
  return error;
}
async function closeKktixSession(id) {
  const session = kktixSessions.get(id);
  if (!session) return;
  kktixSessions.delete(id);
  await session.context.close().catch(() => {});
}
async function acquireKktixSession(m) {
  let session = kktixSessions.get(m.id);
  if (session && (session.url !== m.url || session.page.isClosed())) {
    await closeKktixSession(m.id); session = null;
  }
  if (session) { session.usedAt = Date.now(); return session; }
  // Limit memory use. Evict only idle sessions, never an in-flight check.
  const limit = Math.max(1, Number(process.env.MAX_KKTIX_SESSIONS) || 4);
  if (kktixSessions.size >= limit) {
    const idle = [...kktixSessions.entries()]
      .filter(([id]) => !activeInspections.has(id))
      .sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
    if (!idle) throw monitorError('browser_busy', '瀏覽器正在忙碌，稍後再試。', false);
    await closeKktixSession(idle[0]);
  }
  const b = await getBrowser();
  const options = { locale: 'zh-TW', viewport: { width: 1180, height: 860 } };
  // Use Chromium's genuine default User-Agent, not an iPhone Safari identity.
  try {
    const saved = JSON.parse(await fs.readFile(sessionFile(m.id), 'utf8'));
    if (saved.url === m.url && Date.now() - saved.savedAt < 24 * 60 * 60 * 1000) options.storageState = saved.state;
  } catch {}
  const context = await b.newContext(options);
  context.setDefaultTimeout(5000);
  const page = await context.newPage();
  page.on('dialog', d => d.dismiss().catch(() => {}));
  session = { context, page, url: m.url, usedAt: Date.now(), visits: 0, savedAt: 0, failures: [] };
  page.on('response', response => {
    try {
      const request = response.request();
      const u = new URL(response.url());
      const sameSite = /(^|\.)kktix\.(com|cc)$/.test(u.hostname) || u.hostname === new URL(m.url).hostname;
      if (sameSite && ['xhr', 'fetch'].includes(request.resourceType()) && response.status() >= 400) {
        session.failures.push({ status: response.status(), url: `${u.origin}${u.pathname}` });
        session.failures = session.failures.slice(-8);
      }
    } catch {}
  });
  kktixSessions.set(m.id, session);
  return session;
}
async function saveKktixSession(m, session) {
  if (Date.now() - session.savedAt < 60000) return;
  const state = await session.context.storageState();
  const target = sessionFile(m.id), tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ url: m.url, savedAt: Date.now(), state }), { mode: 0o600 });
  await fs.rename(tmp, target);
  session.savedAt = Date.now();
}

// This function runs inside the page. Keep it self-contained and read-only.
function collectKktixDom() {
  const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = el => {
    if (!el || el.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(el), rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const enabled = el => visible(el) && !el.disabled &&
    !el.matches(':disabled') && !el.closest('[aria-disabled="true"],fieldset[disabled],.disabled');
  const sold = /已售完|售完|售罄|完售|sold\s*out|無剩餘票/i;
  const future = /尚未開賣|尚未開始|未開賣|not\s+(?:yet\s+)?on\s+sale/i;
  const ended = /已結束|停止販售|販售結束|sales?\s+ended/i;
  const candidates = [...document.querySelectorAll('.ticket-unit,.ticket-row,tr[data-ticket-id],[data-ticket-id],[ng-repeat*="ticket"],.display-table-row')]
    .filter(el => visible(el) && !el.closest('header,footer,nav'));
  // Use the smallest ticket container. Do not inspect a whole event table as one ticket.
  const meaningful = candidates.filter(el => {
    const text = norm(el.innerText);
    return !!el.querySelector('.ticket-name,.ticket-price,[data-ticket-name]') ||
      (/ticket/i.test(el.className || '') && /(?:NT\$|TWD|NTD|\$|免費)/i.test(text)) ||
      (el.hasAttribute('data-ticket-id') && !!el.querySelector('input,select'));
  });
  const roots = meaningful.filter(el => !meaningful.some(child => child !== el && el.contains(child)));
  const rows = roots.slice(0, 100).map(el => {
    const text = norm(el.innerText);
    const name = norm(el.querySelector('.ticket-name,[data-ticket-name],.ticket-title')?.innerText) || text.slice(0, 100);
    const price = norm(el.querySelector('.ticket-price')?.innerText);
    const selects = [...el.querySelectorAll('select')].filter(visible);
    const inputs = [...el.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')]
      .filter(x => visible(x) && (x.type === 'number' || /quantity|qty|count|ticket/i.test(`${x.name} ${x.id} ${x.className} ${x.getAttribute('ng-model') || ''}`) || x.closest('.ticket-quantity')));
    const plus = [...el.querySelectorAll('button')].filter(x =>
      enabled(x) && (/^\s*\+\s*$/.test(x.innerText) || /(^|\s)plus(\s|$)/.test(x.className) ||
      !!x.querySelector('.fa-plus,.glyphicon-plus') || /增加數量|increase\s+quantity/i.test(x.getAttribute('aria-label') || '')));
    const hasPrice = (!!price && /\d|免費|free/i.test(price)) || /(?:NT\$|TWD|NTD|\$)\s*[\d,]+|免費/i.test(text);
    const positiveSelect = selects.some(x => enabled(x) && [...x.options].some(o =>
      !o.disabled && !o.parentElement?.disabled && /^(?:[1-9]\d*)(?:\.0+)?$/.test(o.value.trim())));
    const positiveInput = inputs.some(x => {
      if (!enabled(x) || (x.readOnly && plus.length === 0)) return false;
      const max = x.getAttribute('max'), min = Number(x.getAttribute('min') || 0);
      if (max !== null && (Number(max) <= 0 || Number(max) < Math.max(1, min))) return false;
      return (max !== null && Number.isFinite(Number(max)) && Number(max) >= Math.max(1, min)) || plus.length > 0;
    });
    const isSold = sold.test(text), isFuture = future.test(text), isEnded = ended.test(text);
    const available = hasPrice && !isSold && !isFuture && !isEnded && (positiveSelect || positiveInput);
    return { name: name.slice(0, 140), price: price.slice(0, 80), text: text.slice(0, 500),
      state: available ? 'available' : isSold ? 'sold_out' : isFuture ? 'not_started' : isEnded ? 'ended' : 'unknown',
      evidence: available ? (positiveSelect ? 'enabled_quantity_select' : 'enabled_quantity_input') : '',
      quantityControls: selects.length + inputs.length, hasPrice };
  }).filter(row => row.hasPrice);
  const text = norm(document.body?.innerText).slice(0, 120000);
  const title = norm(document.title);
  const loginForm = [...document.querySelectorAll('input[type="password"]')].some(visible);
  const challenge = /just a moment|attention required|access denied|security verification/i.test(title) ||
    [...document.querySelectorAll('#challenge-running,#challenge-stage,.cf-error-details')].some(visible) ||
    (!rows.length && /checking your browser|verify you are human|cloudflare ray id|請完成安全驗證/i.test(text));
  const queue = !rows.length && /您正在排隊|排隊中|you are (?:now )?in (?:the )?(?:queue|line)|waiting room/i.test(text);
  return { text, title, rows, loginForm, challenge, queue };
}

function decideKktix(snapshot, status, finalUrl, requestFailures = []) {
  if (status === null) throw monitorError('no_response', '未取得主頁面的 HTTP 回應，無法確認票況。', false);
  if (status === 429) throw monitorError('rate_limited', 'HTTP 429：網站要求降低請求頻率，已暫停。');
  if (status === 403) throw monitorError('access_denied', 'HTTP 403：這次請求被拒絕；單靠代碼無法確定是 IP、登入或其他原因。');
  if (status === 401) throw monitorError('login_required', 'HTTP 401：需要登入或授權。');
  if (status >= 500) throw monitorError('server_error', `HTTP ${status}：網站伺服器錯誤，不代表售完。`, false);
  if (status >= 400) throw monitorError('http_error', `HTTP ${status}：無法正常讀取此頁。`);
  if (snapshot.challenge) throw monitorError('verification_required', '目前是驗證／防護頁，不是票況頁，已暫停。');
  if (snapshot.queue) throw monitorError('queue', '目前是排隊頁，已暫停。');
  if (/\/(?:users\/sign_in|login|sign_in)(?:[/?#]|$)/i.test(finalUrl) || (snapshot.loginForm && !snapshot.rows.length)) {
    throw monitorError('login_required', '目前是登入頁，無法確認票況。');
  }
  if (!/\/events\/[^/]+\/registrations\/new(?:[/?#]|$)/.test(finalUrl)) {
    throw monitorError('wrong_page', '目前不是 KKTIX 票種選擇頁；活動介紹頁的「下一步」不代表有票。');
  }
  const rows = snapshot.rows || [];
  const available = rows.filter(x => x.state === 'available');
  if (available.length) return { site: 'kktix', available: true, known: true,
    summary: '發現可選數量的票種：' + available.map(x => `${x.name} ${x.price}`).join('\n'),
    fingerprint: JSON.stringify(rows.map(({ name, price, state }) => ({ name, price, state }))) };
  if (rows.length && rows.every(x => ['sold_out','not_started','ended'].includes(x.state))) {
    return { site: 'kktix', available: false, known: true,
      summary: rows.map(x => `${x.name}：${({ sold_out:'已售完',not_started:'尚未開賣',ended:'已結束' })[x.state]}`).join('\n'),
      fingerprint: JSON.stringify(rows.map(({ name, state }) => ({ name, state }))) };
  }
  const failed = requestFailures.find(x => [401,403,429].includes(x.status));
  if (failed) throw monitorError('ticket_data_denied', `票種尚未完整讀取，且頁面資料請求回應 HTTP ${failed.status}；請查看診斷。`);
  throw monitorError('unknown_ticket_state', rows.length
    ? '已看到票種，但無法確認可選數量或售完狀態，已暫停。'
    : '沒有讀到可辨識的票種列，不會當成售完；請查看抓取畫面。');
}

async function recordKktixDiagnostic(m, page, info, snapshot, capture) {
  const old = m.diagnostic || {};
  const diagnostic = {
    version: BUILD_VERSION, checkedAt: new Date().toISOString(),
    requestedUrl: safePageUrl(m.url), finalUrl: safePageUrl(page?.url() || m.url),
    httpStatus: info.httpStatus ?? null, code: info.code, message: info.message,
    title: (snapshot?.title || '').slice(0, 300),
    textPreview: (snapshot?.text || '').slice(0, 2500),
    ticketRows: (snapshot?.rows || []).slice(0, 30),
    requestFailures: info.failures || [], sessionReused: !!info.sessionReused,
    sessionNote: info.sessionNote || '',
    screenshotAt: old.screenshotAt || '', imageAvailable: !!old.imageAvailable,
    screenshotError: '',
  };
  if (capture && page && !page.isClosed()) {
    try {
      await page.screenshot({ path: imageFile(m.id), type: 'jpeg', quality: 72,
        fullPage: false, timeout: 5000,
        mask: [page.locator('input[type="password"],input[type="email"]')] });
      diagnostic.screenshotAt = new Date().toISOString(); diagnostic.imageAvailable = true;
      await fs.chmod(imageFile(m.id), 0o600).catch(() => {});
    } catch (error) {
      diagnostic.imageAvailable = false; diagnostic.screenshotAt = '';
      diagnostic.screenshotError = String(error.message).slice(0, 300);
    }
  }
  m.diagnostic = diagnostic;
  return diagnostic;
}

async function kktixSnapshot(m, { diagnostic = false } = {}) {
  let session, snapshot = null, status = null, response;
  const info = { httpStatus: null, failures: [], sessionReused: false };
  try {
    session = await acquireKktixSession(m);
    const { page } = session;
    info.sessionReused = session.visits > 0;
    session.failures = [];
    response = session.visits > 0 && page.url() === m.url
      ? await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 })
      : await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    session.visits += 1;
    status = response?.status() ?? null; info.httpStatus = status;
    if (status === 429) {
      const retry = response?.headers()['retry-after'];
      const ms = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry || '') - Date.now();
      m.retryAfterAt = Date.now() + (Number.isFinite(ms) && ms > 0 ? ms : 60000);
    }
    snapshot = await page.evaluate(collectKktixDom);
    // Wait for rendered ticket rows, not an arbitrary fixed sleep. This loop only
    // reads the DOM and does not create additional network requests.
    if (status !== null && status < 400 && !snapshot.challenge && !snapshot.queue && !snapshot.loginForm) {
      const deadline = Date.now() + 8000;
      while (!snapshot.rows.some(x => x.state !== 'unknown') && Date.now() < deadline) {
        await page.waitForTimeout(350);
        snapshot = await page.evaluate(collectKktixDom);
        if (snapshot.challenge || snapshot.queue || snapshot.loginForm || session.failures.some(x => [401,403,429].includes(x.status))) break;
      }
    }
    info.failures = session.failures.slice();
    const result = decideKktix(snapshot, status, page.url(), info.failures);
    info.code = result.available ? 'available' : 'unavailable'; info.message = result.summary;
    await saveKktixSession(m, session).catch(e => { info.sessionNote = `工作階段寫入失敗：${e.message}`; });
    const capture = diagnostic || result.available || !m.diagnostic || Date.now() - Date.parse(m.diagnostic.screenshotAt || 0) > 60000;
    await recordKktixDiagnostic(m, page, info, snapshot, capture);
    m.lastDiagnosisCode = info.code;
    return result;
  } catch (error) {
    info.code = error.code || (/timeout/i.test(error.message) ? 'load_timeout' : 'browser_error');
    info.message = error.message; info.httpStatus = status;
    info.failures = session?.failures || [];
    if (info.failures.some(x => x.status === 429)) m.retryAfterAt = Math.max(m.retryAfterAt || 0, Date.now() + 60000);
    if (session?.page && !session.page.isClosed()) {
      snapshot = snapshot || await session.page.evaluate(collectKktixDom).catch(() => null);
    }
    await recordKktixDiagnostic(m, session?.page, info, snapshot, true).catch(() => {});
    m.lastDiagnosisCode = info.code;
    error.diagnosticCode = info.code;
    if (error.pause) await closeKktixSession(m.id);
    throw error;
  }
}

let store = { monitors: [] };
try {
  store = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  if (!Array.isArray(store.monitors)) store.monitors = [];
} catch {}

const runtime = new Map();

let saveQueue = Promise.resolve();
function saveStore() {
  // Multiple monitors must not rename the same temporary file concurrently.
  const serialized = JSON.stringify(store, null, 2);
  const task = saveQueue.catch(() => {}).then(async () => {
    const tmp = `${DATA_FILE}.tmp`;
    await fs.writeFile(tmp, serialized, { mode: 0o600 });
    await fs.rename(tmp, DATA_FILE);
  });
  saveQueue = task;
  return task;
}

function siteType(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('kham.com.tw')) return 'kham';
    if (host === 'kktix.com' || host.endsWith('.kktix.com') || host === 'kktix.cc' || host.endsWith('.kktix.cc')) return 'kktix';
    if (host.includes('shopping.avex.com.tw')) return 'avex';
    if (host.includes('tixcraft.com')) return 'tixcraft';
    if (host.includes('ibon.com.tw') || host.includes('ticket.ibon.com.tw')) return 'ibon';
    return 'generic';
  } catch { return 'generic'; }
}

function validSeconds(value, fallback) {
  const n = Number(value);
  return Math.max(MIN_SECONDS, Math.min(86400, Number.isFinite(n) && n > 0 ? Math.ceil(n) : fallback));
}
function secondsFor(m) {
  if (m.intervalMode === 'fixed') return validSeconds(m.fixedSeconds, 5);
  const min = validSeconds(m.minSeconds, 1);
  const max = Math.max(min, validSeconds(m.maxSeconds, 5));
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function nowParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    hm: `${parts.hour}:${parts.minute}`
  };
}

function inSchedule(m) {
  if (!m.limitedTime) return true;
  const { hm } = nowParts();
  const start = m.startTime || '00:00';
  const end = m.endTime || '23:59';
  if (start <= end) return hm >= start && hm <= end;
  return hm >= start || hm <= end; // overnight window
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function blockedText(text, status = 200) {
  const t = String(text || '').toLowerCase();
  // HTTP 200 is normal. Avoid false positives from ordinary page text such as
  // customer-service forms that merely contain the word "驗證碼".
  if ([403, 429, 503].includes(Number(status))) return true;
  return /too many requests|access denied|cloudflare ray id|checking your browser|verify you are human|robot check|請完成(?:安全)?驗證|安全驗證|您正在排隊|排隊中/.test(t);
}

async function httpHtml(url) {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      'accept-language': 'zh-TW,zh;q=0.9,en;q=0.7'
    },
    signal: AbortSignal.timeout(15000)
  });
  const text = await r.text();
  if (blockedText(text, r.status)) {
    const e = new Error(`網站回應 ${r.status} 或出現驗證/限制頁`);
    e.pause = true;
    throw e;
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return text;
}

function parseKham(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('tr').each((_, tr) => {
    const cells = $(tr).find('th,td').map((__, c) => cleanText($(c).text())).get().filter(Boolean);
    if (cells.length >= 2) rows.push(cells);
  });

  const candidates = rows.filter(c => c.some(v => /已售完|空位|票價|樓|區|包廂|輪椅/.test(v)));
  const available = [];
  for (const cells of candidates) {
    const line = cells.join(' | ');
    if (/空位/.test(line) && /票區|票價/.test(line)) continue;
    if (/已售完/.test(line)) continue;
    if (/\b[1-9]\d*\b/.test(line) || /立即|選購|購買|可售|剩餘/.test(line)) available.push(line);
  }
  return {
    site: 'kham',
    available: available.length > 0,
    summary: available.length ? available.slice(0, 8).join('\n') : '目前各票區仍顯示售完/無可售票況',
    fingerprint: cleanText(candidates.map(c => c.join('|')).join('||')).slice(0, 8000)
  };
}

function parseAvex(html) {
  const $ = cheerio.load(html);
  const body = cleanText($('body').text());
  const match = body.match(/庫存(?:量)?\s*[:：]?\s*(\d+)/);
  if (match) {
    const count = Number(match[1]);
    return { site: 'avex', available: count > 0, summary: `庫存量：${count}`, fingerprint: `stock:${count}` };
  }
  const sold = /售完|缺貨|補貨中|庫存不足/.test(body);
  return { site: 'avex', available: !sold && /加入購物車|立即購買|購買/.test(body), summary: sold ? '目前顯示售完/缺貨' : '頁面未找到明確庫存數字', fingerprint: body.slice(0, 8000) };
}

function stockFromText(text) {
  const patterns = [
    /(?:庫存(?:量)?|剩餘(?:數量|票數)?|餘票|可售(?:數量)?|stock|remaining)\s*[:：]?\s*(\d+)/gi,
    /(\d+)\s*(?:張|件)\s*(?:可售|剩餘|available)/gi
  ];
  const found = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) found.push(Number(m[1]));
  }
  return found.filter(Number.isFinite);
}

function genericDecision(text, controls, m) {
  const mode = m.detectionMode || (m.watchText ? 'custom' : 'auto');
  const soldRe = /已售完|售罄|完售|sold out|暫無票|無票|缺貨|庫存不足|補貨中/gi;
  const soldMatches = text.match(soldRe) || [];
  const stock = stockFromText(text);
  const enabledBuy = (controls || []).filter(c => !c.disabled && /購買|立即購買|立即報名|下一步|選購|加入購物車|buy|register|order/i.test(`${c.text || ''} ${c.href || ''}`));

  if (mode === 'stock') {
    if (!stock.length) return { available: false, summary: '未找到明確庫存/剩餘數字', fingerprint: 'stock:none' };
    const max = Math.max(...stock);
    return { available: max > 0, summary: `找到庫存/剩餘數字：${stock.join('、')}`, fingerprint: `stock:${stock.join(',')}` };
  }

  if (mode === 'soldout') {
    const sold = soldMatches.length > 0;
    return { available: !sold, summary: sold ? `目前仍有售完/缺貨提示（${soldMatches.length} 處）` : '售完/缺貨提示已解除', fingerprint: `sold:${soldMatches.length}` };
  }

  if (mode === 'custom') {
    const watch = cleanText(m.watchText || '已售完');
    const has = watch ? text.includes(watch) : false;
    const matched = m.watchCondition === 'appears' ? has : !has;
    return { available: matched, summary: watch ? `「${watch}」目前${has ? '存在' : '不存在'}` : '未設定監控文字', fingerprint: `${watch}:${has}` };
  }

  // Auto: first trust explicit stock numbers, then sold-out state, then enabled purchase controls.
  if (stock.length) {
    const max = Math.max(...stock);
    return { available: max > 0, summary: `自動判斷庫存/剩餘：${stock.join('、')}`, fingerprint: `auto-stock:${stock.join(',')}` };
  }
  if (soldMatches.length) {
    return { available: false, summary: `自動判斷：目前仍顯示售完/缺貨（${soldMatches.length} 處）`, fingerprint: `auto-sold:${soldMatches.length}` };
  }
  if (enabledBuy.length) {
    return { available: true, summary: `自動判斷：發現可購買控制項 ${enabledBuy.slice(0, 5).map(x => x.text || x.tag).join('、')}`, fingerprint: `auto-buy:${enabledBuy.slice(0,10).map(x=>x.text||x.href||x.tag).join('|')}` };
  }
  return { available: false, summary: '自動判斷：未找到明確庫存、售完或可購買狀態', fingerprint: 'auto:unknown' };
}

function parseGenericHtml(html, m) {
  const $ = cheerio.load(html);
  const text = cleanText($('body').text());
  const controls = $('button,select,input[type="button"],input[type="submit"],a').map((_, el) => ({
    tag: el.tagName || '',
    text: cleanText($(el).text() || $(el).attr('value') || $(el).attr('aria-label') || ''),
    disabled: $(el).is(':disabled') || $(el).attr('aria-disabled') === 'true',
    href: $(el).attr('href') || ''
  })).get().slice(0, 800);
  const d = genericDecision(text, controls, m);
  return { site: 'generic', ...d };
}

async function browserSnapshot(url, m, type) {
  const b = await getBrowser();
  const page = await b.newPage({
    locale: 'zh-TW',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
  });
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1800);
    const status = response?.status() || 200;
    const body = cleanText(await page.locator('body').innerText().catch(() => ''));
    if (blockedText(body, status)) {
      const e = new Error(`網站回應 ${status} 或出現驗證/排隊/限制頁`);
      e.pause = true;
      throw e;
    }

    const snapshot = await page.evaluate(() => {
      const visible = el => {
        const s = getComputedStyle(el); const r = el.getBoundingClientRect();
        return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
      };
      const controls = [...document.querySelectorAll('button,select,input[type="button"],input[type="submit"],a')]
        .filter(visible)
        .slice(0, 800)
        .map(el => ({
          tag: el.tagName,
          text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim(),
          disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
          href: el.href || '',
          cls: el.className || ''
        }));
      return { text: document.body.innerText, controls };
    });

    const text = cleanText(snapshot.text);
    const enabled = snapshot.controls.filter(c => !c.disabled && /購買|立即|下一步|張|票|register|buy|order|選擇|報名/i.test(`${c.text} ${c.href}`));
    const soldCount = (text.match(/已售完|售罄|sold out|暫無票|無票|完售/gi) || []).length;

    if (type === 'generic') return parseGenericBrowser(text, snapshot.controls, m);

    let available = false;
    let summary = '';
    if (type === 'tixcraft' || type === 'ibon') {
      available = enabled.length > 0 && !/尚未開賣|停止售票|已結束/.test(text);
      summary = available ? `發現可購買控制項：${enabled.slice(0, 5).map(x => x.text || x.tag).join('、')}` : `目前未發現可購買控制項（售完提示 ${soldCount} 處）`;
    } else {
      return parseGenericBrowser(text, snapshot.controls, m);
    }

    return {
      site: type,
      available,
      summary,
      fingerprint: cleanText(JSON.stringify(snapshot.controls.slice(0, 120))).slice(0, 10000)
    };
  } finally {
    await page.close();
  }
}

function parseGenericBrowser(text, controls, m) {
  const d = genericDecision(text, controls, m);
  return { site: 'generic', ...d, fingerprint: `${d.fingerprint}:${controls.length}` };
}

async function inspectUnchecked(m, options = {}) {
  const type = siteType(m.url);
  if (type === 'kham') return parseKham(await httpHtml(m.url));
  if (type === 'avex') return parseAvex(await httpHtml(m.url));
  if (type === 'kktix') return kktixSnapshot(m, options);
  if (['tixcraft', 'ibon'].includes(type)) return browserSnapshot(m.url, m, type);
  try {
    return parseGenericHtml(await httpHtml(m.url), m);
  } catch (e) {
    if (e.pause) throw e;
    return browserSnapshot(m.url, m, 'generic');
  }
}

async function inspect(m, options = {}) {
  if (activeInspections.has(m.id)) throw monitorError('check_busy', '這筆監控正在檢查，請稍後再試。', false);
  if (m.retryAfterAt > Date.now()) throw monitorError('retry_after', '網站要求等待，請稍後再試。');
  activeInspections.add(m.id);
  try { return await inspectUnchecked(m, options); }
  finally { activeInspections.delete(m.id); }
}

async function notify(m, result) {
  const topic = cleanText(m.ntfyTopic);
  if (!topic) return;
  const title = `🎫 ${m.name || '售票監控'} 有變化`;
  const body = `${result.summary}\n${m.url}`;
  const r = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      'Title': encodeURIComponent(title),
      'Priority': 'urgent',
      'Tags': 'ticket,rotating_light',
      'Click': m.url,
      'Content-Type': 'text/plain; charset=utf-8'
    },
    body
  });
  if (!r.ok) throw new Error(`ntfy ${r.status}`);
}

function publicMonitor(m) {
  const r = runtime.get(m.id) || {};
  return { ...m, state: r.state || (m.pauseReason ? 'paused' : m.running ? 'running' : 'stopped'),
    nextAt: r.nextAt || null, lastError: r.lastError ?? m.lastError ?? '', siteType: siteType(m.url) };
}

function scheduleNext(m, delaySec) {
  if (shuttingDown || !m.running || !store.monitors.includes(m)) return;
  clearTimeout(runtime.get(m.id)?.timer);
  const nextAt = Date.now() + delaySec * 1000;
  const timer = setTimeout(() => dispatchMonitor(m.id), delaySec * 1000);
  runtime.set(m.id, { ...runtime.get(m.id), timer, nextAt });
}

function dispatchMonitor(id) {
  runMonitor(id).catch(async error => {
    console.error('[Monitor] background task failed:', error.message);
    const m = store.monitors.find(x => x.id === id);
    if (!m) return;
    m.running = false; m.pauseReason = 'internal_error';
    m.lastError = `監控程式錯誤：${error.message}`;
    clearTimeout(runtime.get(id)?.timer);
    runtime.set(id, { state: 'paused', lastError: m.lastError, nextAt: null });
    await saveStore().catch(e => console.error('[Monitor] cannot save:', e.message));
  });
}

async function runMonitor(id) {
  const m = store.monitors.find(x => x.id === id);
  if (!m || !m.running || shuttingDown || activeRuns.has(id)) return;
  clearTimeout(runtime.get(id)?.timer);
  if (activeInspections.has(id)) return scheduleNext(m, 1);
  if (!inSchedule(m)) {
    runtime.set(id, { ...runtime.get(id), state: 'waiting', lastError: '' });
    return scheduleNext(m, 30);
  }
  activeRuns.add(id);
  runtime.set(id, { ...runtime.get(id), state: 'checking', lastError: '', nextAt: null });
  try {
    const result = await inspect(m);
    // An in-flight response must not restart a stopped/deleted/edited monitor.
    if (!m.running || !store.monitors.includes(m) || shuttingDown) return;
    const t = nowParts();
    m.checks = Number(m.checks || 0) + 1;
    m.lastCheck = `${t.date} ${t.time}`; m.lastResult = result.summary;
    m.lastFingerprint = result.fingerprint; m.detected = !!result.available;
    m.lastError = ''; m.pauseReason = ''; m.retryAfterAt = 0;
    if (result.available) {
      m.running = false; m.detectedAt = m.lastCheck;
      runtime.set(id, { ...runtime.get(id), state: 'detected', nextAt: null, lastError: '' });
      await saveStore();
      await closeKktixSession(id);
      await notify(m, result).catch(error => {
        m.lastError = `通知失敗：${error.message}`;
        runtime.set(id, { ...runtime.get(id), lastError: m.lastError });
      });
      await saveStore();
      return;
    }
    await saveStore();
    runtime.set(id, { ...runtime.get(id), state: 'running', lastError: '' });
    scheduleNext(m, secondsFor(m));
  } catch (error) {
    if (!m.running || !store.monitors.includes(m) || shuttingDown) return;
    const t = nowParts(); m.lastCheck = `${t.date} ${t.time}`; m.lastError = error.message;
    if (siteType(m.url) === 'kktix') m.lastResult = '本次無法判斷票況（不代表售完）';
    if (error.pause) {
      m.running = false; m.pauseReason = error.diagnosticCode || error.code || 'restricted';
      runtime.set(id, { ...runtime.get(id), state: 'paused', lastError: error.message, nextAt: null });
      await saveStore(); await closeKktixSession(id); return;
    }
    runtime.set(id, { ...runtime.get(id), state: 'error', lastError: error.message });
    await saveStore(); scheduleNext(m, Math.max(30, secondsFor(m)));
  } finally {
    activeRuns.delete(id);
    if (!m.running || !store.monitors.includes(m) || shuttingDown) await closeKktixSession(id);
  }
}

function normalizeMonitor(input, existing = {}) {
  const url = String(input.url || existing.url || '').trim();
  const parsedUrl = new URL(url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) throw new Error('Please use an HTTP(S) URL without credentials.');
  return {
    ...existing,
    id: existing.id || crypto.randomUUID(),
    name: String(input.name || existing.name || '').trim() || new URL(url).hostname,
    url,
    intervalMode: input.intervalMode === 'fixed' ? 'fixed' : 'random',
    fixedSeconds: validSeconds(input.fixedSeconds, 5),
    minSeconds: validSeconds(input.minSeconds, 1),
    maxSeconds: Math.max(validSeconds(input.minSeconds, 1), validSeconds(input.maxSeconds, 5)),
    limitedTime: !!input.limitedTime,
    startTime: input.startTime || '11:55',
    endTime: input.endTime || '12:30',
    detectionMode: ['auto','stock','soldout','custom'].includes(input.detectionMode)
      ? input.detectionMode
      : (existing.detectionMode || (existing.id && existing.watchText ? 'custom' : 'auto')),
    watchText: String(input.watchText || existing.watchText || '已售完'),
    watchCondition: input.watchCondition === 'appears' ? 'appears' : (input.watchCondition === 'disappears' ? 'disappears' : (existing.watchCondition || 'disappears')),
    ntfyTopic: String(input.ntfyTopic || existing.ntfyTopic || '').trim(),
    running: !!existing.running,
    checks: Number(existing.checks || 0),
    lastCheck: existing.lastCheck || '',
    lastResult: existing.lastResult || '',
    lastError: existing.lastError || '',
    detectedAt: existing.detectedAt || ''
  };
}

app.get('/api/monitors', (req, res) => res.json(store.monitors.map(publicMonitor)));

app.post('/api/monitors', async (req, res) => {
  try {
    const m = normalizeMonitor(req.body);
    store.monitors.push(m);
    await saveStore();
    res.json(publicMonitor(m));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/monitors/:id', async (req, res) => {
  try {
    const idx = store.monitors.findIndex(x => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'not found' });
    const old = store.monitors[idx];
    if (activeInspections.has(old.id) || activeRuns.has(old.id)) return res.status(409).json({ error: '請先停止監控並等待檢查結束，再儲存編輯。' });
    const m = normalizeMonitor(req.body, old);
    old.running = false;
    m.running = false; m.pauseReason = ''; m.lastError = ''; m.detectedAt = '';
    clearTimeout(runtime.get(old.id)?.timer);
    runtime.set(old.id, { state: 'stopped', nextAt: null, lastError: '' });
    await closeKktixSession(old.id);
    if (m.url !== old.url) {
      delete m.diagnostic; delete m.lastDiagnosisCode;
      await fs.unlink(sessionFile(old.id)).catch(() => {});
      await fs.unlink(imageFile(old.id)).catch(() => {});
    }
    store.monitors[idx] = m;
    await saveStore();
    res.json(publicMonitor(m));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/monitors/:id', async (req, res) => {
  const idx = store.monitors.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  clearTimeout(runtime.get(req.params.id)?.timer);
  const removed = store.monitors[idx]; removed.running = false;
  runtime.delete(req.params.id);
  store.monitors.splice(idx, 1);
  await closeKktixSession(removed.id);
  await fs.unlink(sessionFile(removed.id)).catch(() => {});
  await fs.unlink(imageFile(removed.id)).catch(() => {});
  await saveStore();
  res.json({ ok: true });
});

app.post('/api/monitors/:id/start', async (req, res) => {
  const m = store.monitors.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (m.running) return res.json(publicMonitor(m));
  if (activeRuns.has(m.id) || activeInspections.has(m.id)) return res.status(409).json({ error: '前一次檢查還在結束中，請稍後再試。' });
  if (m.retryAfterAt > Date.now()) return res.status(429).json({ error: '網站要求等待，請稍後再開始。' });
  m.running = true; m.lastError = ''; m.pauseReason = ''; m.detectedAt = ''; m.detected = false;
  runtime.set(m.id, { ...runtime.get(m.id), state: 'running', lastError: '' });
  await saveStore(); scheduleNext(m, 0.05);
  res.json(publicMonitor(m));
});

app.post('/api/monitors/:id/stop', async (req, res) => {
  const m = store.monitors.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  m.running = false; m.pauseReason = '';
  clearTimeout(runtime.get(m.id)?.timer);
  runtime.set(m.id, { ...runtime.get(m.id), state: 'stopped', nextAt: null });
  if (!activeInspections.has(m.id)) await closeKktixSession(m.id);
  await saveStore(); res.json(publicMonitor(m));
});

app.post('/api/monitors/:id/test', async (req, res) => {
  const m = store.monitors.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (m.running || activeInspections.has(m.id) || activeRuns.has(m.id)) return res.status(409).json({ error: '請先停止這筆監控，等目前檢查結束後再測試抓取。' });
  runtime.set(m.id, { ...runtime.get(m.id), state: 'checking', nextAt: null, lastError: '' });
  try {
    const result = await inspect(m, { diagnostic: true });
    const t = nowParts(); m.lastCheck = `${t.date} ${t.time}`;
    m.lastResult = result.summary; m.lastError = ''; m.pauseReason = '';
    runtime.set(m.id, { ...runtime.get(m.id), state: 'stopped', lastError: '', nextAt: null });
    await saveStore(); res.json({ ok: true, siteType: siteType(m.url), result });
  } catch (error) {
    const t = nowParts(); m.lastCheck = `${t.date} ${t.time}`; m.lastError = error.message;
    if (siteType(m.url) === 'kktix') m.lastResult = '本次無法判斷票況（不代表售完）';
    m.pauseReason = error.pause ? (error.diagnosticCode || error.code || 'restricted') : '';
    runtime.set(m.id, { ...runtime.get(m.id), state: error.pause ? 'paused' : 'error', lastError: error.message, nextAt: null });
    await saveStore();
    res.status(400).json({ error: error.message, pause: !!error.pause, diagnosticCode: error.diagnosticCode || error.code || '', hasDiagnostic: !!m.diagnostic });
  }
});

app.get('/api/info', (req, res) => res.json({ version: BUILD_VERSION, minSeconds: MIN_SECONDS }));
app.get('/api/monitors/:id/diagnostic', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(403).json({ error: '請先設定 ADMIN_PASSWORD，才能開啟受保護的抓取畫面。' });
  const m = store.monitors.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (!m.diagnostic) return res.status(404).json({ error: '還沒有診斷資料，請先按「測試抓取」。' });
  res.json({ ...m.diagnostic, imageUrl: m.diagnostic.imageAvailable ? `/api/monitors/${encodeURIComponent(m.id)}/diagnostic/image` : null });
});
app.get('/api/monitors/:id/diagnostic/image', async (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(403).send('Authentication must be configured');
  const m = store.monitors.find(x => x.id === req.params.id);
  if (!m || !m.diagnostic?.imageAvailable) return res.status(404).send('No diagnostic image');
  try { res.type('image/jpeg').send(await fs.readFile(imageFile(m.id))); }
  catch { res.status(404).send('Diagnostic image unavailable'); }
});

app.post('/api/monitors/:id/test-notification', async (req, res) => {
  const m = store.monitors.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  try {
    await notify(m, { summary: '這是測試通知，收到代表 iPhone 推播設定正常。' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/healthz', (req, res) => res.json({ ok: true, version: BUILD_VERSION }));

app.use((error, req, res, next) => {
  console.error('[Monitor] request error:', error.message);
  if (!res.headersSent) res.status(500).json({ error: '儲存或伺服器處理失敗，請查看 Railway Logs。' });
});

app.listen(PORT, () => console.log(`Ticket Cloud Monitor listening on :${PORT}`));

for (const m of store.monitors) {
  if (m.running) setTimeout(() => dispatchMonitor(m.id), 500 + Math.random() * 1500);
}

const idleCleanup = setInterval(() => {
  for (const [id, session] of kktixSessions) {
    if (!activeInspections.has(id) && Date.now() - session.usedAt > 10 * 60 * 1000) closeKktixSession(id).catch(() => {});
  }
}, 60000);
idleCleanup.unref();
async function shutdown() {
  shuttingDown = true;
  for (const r of runtime.values()) clearTimeout(r.timer);
  await saveQueue.catch(() => {});
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
