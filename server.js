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
    if (req.path === '/healthz' || (req.path === '/api/local' && req.method === 'POST')) return next();
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
const BUILD_VERSION = '4.0.0-universal';
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
    if (host.includes('ticketplus.com.tw')) return 'ticketplus';
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

function looksLikeLoginPage(text, hasPassword = false) {
  const t = cleanText(text).toLowerCase();
  const strong = /請先登入|登入後(?:才|方|即可)|會員登入|帳號登入|sign\s*in\s*(?:to|required)|log\s*in\s*(?:to|required)|login\s*required|please\s*(?:sign|log)\s*in/.test(t);
  return !!hasPassword && strong;
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

function stablePageText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g, '<time>')
    .replace(/\b\d+\s*(?:秒|分鐘|小時|seconds?|minutes?|hours?)\s*(?:前|ago)?\b/gi, '<relative-time>')
    .replace(/\b[a-f0-9]{24,}\b/gi, '<token>')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<token>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120000);
}
function stablePageFingerprint(text, controls = []) {
  const relevantControls = (controls || []).slice(0, 500).map(c => [
    cleanText(c.text || '').slice(0, 160), !!c.disabled,
    cleanText(c.href || '').replace(/[?#].*$/, '').slice(0, 240)
  ]).filter(x => x[0] || x[2]);
  const payload = `${stablePageText(text)}\n--controls--\n${JSON.stringify(relevantControls)}`;
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function genericDecision(text, controls, m) {
  const mode = m.detectionMode || (m.watchText ? 'custom' : 'page');
  if (mode === 'page') {
    const fingerprint = stablePageFingerprint(text, controls);
    return { available: false, summary: '智慧整頁監控：已取得目前頁面基準。', fingerprint };
  }
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
  if (looksLikeLoginPage(text, $('input[type="password"]').length > 0)) {
    const e = monitorError('login_required', '雲端讀到登入頁，需要本機已登入的瀏覽器接手。');
    e.pause = true; throw e;
  }
  const controls = $('button,select,input[type="button"],input[type="submit"],a').map((_, el) => ({
    tag: el.tagName || '',
    text: cleanText($(el).text() || $(el).attr('value') || $(el).attr('aria-label') || ''),
    disabled: $(el).is(':disabled') || $(el).attr('aria-disabled') === 'true',
    href: $(el).attr('href') || ''
  })).get().slice(0, 800);
  const d = genericDecision(text, controls, m);
  return { site: 'generic', ...d };
}




function isTicketplusOrderUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.port && /^(?:www\.)?ticketplus\.com\.tw$/.test(u.hostname) && /^\/order\/[a-z0-9_-]+\/[a-z0-9_-]+\/?$/i.test(u.pathname);
  } catch { return false; }
}

function isTixcraftAreaUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.port && /^(?:www\.)?tixcraft\.com$/.test(u.hostname) && /^\/ticket\/area\/[^/]+\/[^/]+\/?$/i.test(u.pathname);
  } catch { return false; }
}

function supportsLocalBrowser(url, tixcraftStage = null) {
  try {
    const target = siteType(url) === 'tixcraft' && !isTixcraftAreaUrl(url) && tixcraftStage?.href ? tixcraftStage.href : url;
    const u = new URL(target);
    return ['http:','https:'].includes(u.protocol) && !u.username && !u.password;
  } catch { return false; }
}

async function diagnoseTicketplusOrder(url) {
  const b = await getBrowser();
  const page = await b.newPage({ locale: 'zh-TW', viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(9000);
  let response = null;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2200);
    const status = response?.status() || 200;
    const finalUrl = page.url();
    const title = await page.title().catch(() => '');
    const rawBody = await page.locator('body').innerText().catch(() => '');
    const body = cleanText(rawBody);
    const restricted = blockedText(body, status);
    const loginRequired = !restricted && (/登入|會員登入|請先登入|sign\s*in|log\s*in/i.test(body) || /\/login(?:\/|\?|$)/i.test(finalUrl));
    let tickets = [];
    if (!restricted && !loginRequired) tickets = await collectTicketplusTickets(page).catch(() => []);
    const ticketLike = tickets.length > 0 || /票種|票價|選擇票券|張數|數量|立即購票|下一步/i.test(body);
    const classification = restricted ? 'restricted' : loginRequired ? 'login_required' : ticketLike ? 'ticket_page' : 'unknown';
    const message = restricted
      ? `Ticket Plus 回應 ${status} 或出現驗證／限制頁。`
      : loginRequired
        ? 'Ticket Plus 單場頁要求登入；Railway 目前沒有你的會員登入 Session。'
        : tickets.length
          ? `已讀到 ${tickets.length} 個票種／票區。`
          : ticketLike
            ? '已進入疑似購票頁，但目前沒有辨識到可解析的票種。'
            : '頁面可開啟，但目前無法辨識為登入頁或票種頁。';
    const shot = await page.screenshot({ type:'jpeg', quality:70, fullPage:false }).catch(() => null);
    return {
      status, finalUrl, title, classification, message,
      tickets,
      textPreview: body.slice(0, 5000),
      screenshotDataUrl: shot ? `data:image/jpeg;base64,${shot.toString('base64')}` : ''
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function isAccessibleTicketText(text) {
  return /身障|身心障礙|輪椅|愛心席|陪同席|accessible|wheelchair/i.test(String(text || ''));
}

async function ticketplusOpen(url, stage = null) {
  const b = await getBrowser();
  const page = await b.newPage({ locale: 'zh-TW', viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  try {
    let response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1800);
    let status = response?.status() || 200;
    let body = cleanText(await page.locator('body').innerText().catch(() => ''));
    if (blockedText(body, status)) throw monitorError('restricted', `網站回應 ${status} 或出現驗證/排隊/限制頁`);

    if (stage) {
      if (stage.href) {
        response = await page.goto(stage.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
      } else if (Number.isInteger(Number(stage.index))) {
        const buy = page.locator('a,button').filter({ hasText: /立即購票|立即購買|購票|Buy/i });
        const n = await buy.count();
        if (Number(stage.index) >= n) throw new Error('找不到原本選取的 Ticket Plus 場次，活動頁可能已改版。');
        await Promise.allSettled([
          page.waitForLoadState('domcontentloaded', { timeout: 12000 }),
          buy.nth(Number(stage.index)).click({ timeout: 8000 })
        ]);
      }
      await page.waitForTimeout(1800);
      status = response?.status() || status;
      body = cleanText(await page.locator('body').innerText().catch(() => ''));
      if (blockedText(body, status)) throw monitorError('restricted', `網站回應 ${status} 或出現驗證/排隊/限制頁`);
    }
    return { page, status };
  } catch (e) {
    await page.close().catch(() => {});
    throw e;
  }
}

async function discoverTicketplusStages(url) {
  const { page, status } = await ticketplusOpen(url);
  try {
    const stages = await page.evaluate(() => {
      const norm = v => String(v || '').replace(/\s+/g, ' ').trim();
      const visible = el => { const s=getComputedStyle(el), r=el.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
      const controls = [...document.querySelectorAll('a,button')].filter(el => visible(el) && /立即購票|立即購買|購票|Buy/i.test(norm(el.innerText || el.getAttribute('aria-label'))));
      return controls.slice(0,80).map((el,index) => {
        const box = el.closest('tr,li,[class*="session"],[class*="show"],[class*="event"],[class*="activity"],.row,.item') || el.parentElement;
        const text = norm(box?.innerText || el.innerText).slice(0,400);
        const anchor = el.tagName === 'A' ? el : el.closest('a');
        const href = anchor?.href && /^https?:/i.test(anchor.href) ? anchor.href : '';
        return { index, label: text || norm(el.innerText) || `場次 ${index+1}`, href };
      });
    });
    const seen = new Set();
    const unique = stages.filter(x => { const k=`${x.href}|${x.label}`; if(seen.has(k))return false; seen.add(k); return true; });
    return { status, title: await page.title(), finalUrl: page.url(), stages: unique };
  } finally { await page.close(); }
}

async function collectTicketplusTickets(page) {
  return page.evaluate(() => {
    const norm = v => String(v || '').replace(/\s+/g, ' ').trim();
    const visible = el => { if(!el)return false; const s=getComputedStyle(el),r=el.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
    const enabled = el => visible(el) && !el.disabled && !el.matches(':disabled') && el.getAttribute('aria-disabled')!=='true' && !el.closest('.disabled,[aria-disabled="true"]');
    const sold = /已售完|售完|售罄|完售|sold\s*out|無票|暫無票/i;
    const future = /尚未開賣|尚未開始|未開賣|停止售票|已結束/i;
    const roots = [...document.querySelectorAll('tr,li,[class*="ticket"],[class*="price"],[class*="zone"],[class*="area"],.row,.item')]
      .filter(visible)
      .filter(el => /(?:NT\$|TWD|NTD|\$)\s*[\d,]+|\b\d{3,6}\b\s*元|免費/.test(norm(el.innerText)))
      .filter(el => !el.closest('header,footer,nav'));
    const smallest = roots.filter(el => !roots.some(ch => ch!==el && el.contains(ch) && norm(ch.innerText).length>0));
    return smallest.slice(0,150).map((el,idx) => {
      const text=norm(el.innerText).slice(0,600);
      const price=(text.match(/(?:NT\$|TWD|NTD|\$)\s*[\d,]+|\b\d{3,6}\b\s*元|免費/i)||[''])[0];
      const selects=[...el.querySelectorAll('select')].filter(visible);
      const inputs=[...el.querySelectorAll('input[type="number"],input[name*="qty" i],input[name*="quantity" i]')].filter(visible);
      const buttons=[...el.querySelectorAll('button,a')].filter(enabled);
      const quantity = selects.some(x => enabled(x) && [...x.options].some(o => !o.disabled && /^([1-9]\d*)$/.test(String(o.value).trim()))) ||
        inputs.some(x => enabled(x) && (x.max==='' || Number(x.max)>0)) ||
        buttons.some(x => /\+|選擇|購買|加入|下一步/i.test(norm(x.innerText || x.getAttribute('aria-label'))));
      const isSold=sold.test(text), isFuture=future.test(text);
      const accessible=/身障|身心障礙|輪椅|愛心席|陪同席|accessible|wheelchair/i.test(text);
      const stableText=text.replace(/已售完|售完|售罄|完售|sold\s*out|無票|暫無票|尚未開賣|尚未開始|未開賣|停止售票|已結束/gi,'').replace(/\s+/g,' ').trim();
      return { index:idx, key:`${price}|${accessible?'A':'N'}|${stableText.slice(0,140)}`, name:text.slice(0,180), price, accessible, available:!isSold&&!isFuture&&quantity, state:isSold?'sold_out':isFuture?'not_started':quantity?'available':'unknown', text };
    });
  });
}

async function discoverTicketplusTickets(url, stage) {
  const { page, status } = await ticketplusOpen(url, stage);
  try {
    const tickets = await collectTicketplusTickets(page);
    return { status, title: await page.title(), finalUrl: page.url(), tickets };
  } finally { await page.close(); }
}

async function ticketplusSnapshot(m) {
  if (isTicketplusOrderUrl(m.url) && !m.ticketplusStage) {
    const d = await diagnoseTicketplusOrder(m.url);
    if (d.classification === 'restricted') throw monitorError('restricted', d.message);
    if (d.classification === 'login_required') throw monitorError('login_required', d.message);
    if (d.classification !== 'ticket_page') throw monitorError('unrecognized', d.message, false);
    let tickets = d.tickets || [];
    const wantedKeys = new Set(Array.isArray(m.ticketplusTicketKeys) ? m.ticketplusTicketKeys : []);
    let monitored = wantedKeys.size ? tickets.filter(t => wantedKeys.has(t.key)) : tickets;
    if (m.excludeAccessible !== false) monitored = monitored.filter(t => !t.accessible);
    const available = monitored.filter(t => t.available);
    const summary = available.length
      ? `發現可購買票種：${available.slice(0,6).map(t=>t.name).join('、')}`
      : monitored.length ? `已檢查 ${monitored.length} 個票種，目前未發現可購買票種` : '單場頁目前沒有可辨識的票種。';
    return { site:'ticketplus', available:available.length>0, summary, fingerprint: JSON.stringify(monitored.map(t=>[t.key,t.state])).slice(0,12000), finalUrl:d.finalUrl };
  }
  if (!m.ticketplusStage) throw new Error('請先按「讀取場次」，選擇 Ticket Plus 場次後再開始監控；若貼的是 /order/ 單場頁，可直接使用「診斷／讀取單場頁」。');
  const { page } = await ticketplusOpen(m.url, m.ticketplusStage);
  try {
    const tickets = await collectTicketplusTickets(page);
    const wantedKeys = new Set(Array.isArray(m.ticketplusTicketKeys) ? m.ticketplusTicketKeys : []);
    let monitored = wantedKeys.size ? tickets.filter(t => wantedKeys.has(t.key)) : tickets;
    if (m.excludeAccessible !== false) monitored = monitored.filter(t => !t.accessible);
    const available = monitored.filter(t => t.available);
    const summary = available.length
      ? `發現可購買票種：${available.slice(0,6).map(t=>t.name).join('、')}`
      : monitored.length ? `已檢查 ${monitored.length} 個票種，目前未發現可購買票種` : '未找到符合設定的票種，請重新讀取場次/票種。';
    return { site:'ticketplus', available:available.length>0, summary, fingerprint: JSON.stringify(monitored.map(t=>[t.key,t.state])).slice(0,12000), finalUrl:page.url() };
  } finally { await page.close(); }
}



function tixcraftGameUrl(url) {
  try {
    const u = new URL(url);
    if (/\/activity\/detail\//.test(u.pathname)) u.pathname = u.pathname.replace('/activity/detail/', '/activity/game/');
    return u.toString();
  } catch { return url; }
}

async function tixcraftOpen(url, stage = null) {
  const b = await getBrowser();
  const page = await b.newPage({ locale: 'zh-TW', viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(9000);
  try {
    const gameUrl = tixcraftGameUrl(url);
    let response = await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1500);
    let status = response?.status() || 200;
    let body = cleanText(await page.locator('body').innerText().catch(() => ''));
    if (blockedText(body, status)) throw monitorError('restricted', `網站回應 ${status} 或出現驗證/排隊/限制頁`);

    if (stage) {
      if (stage.href) {
        response = await page.goto(stage.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
      } else {
        const rows = page.locator('tr').filter({ has: page.locator('button,a') });
        const matching = rows.filter({ hasText: /Find tickets|立即訂購|立即購票|購票/i });
        const n = await matching.count();
        const idx = Number(stage.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= n) throw new Error('找不到原本選取的拓元場次，活動頁可能已改版。');
        const row = matching.nth(idx);
        const control = row.locator('a,button,input[type="submit"],input[type="button"]').filter({ hasText: /Find tickets|立即訂購|立即購票|購票/i }).first();
        await Promise.allSettled([
          page.waitForLoadState('domcontentloaded', { timeout: 12000 }),
          control.click({ timeout: 9000 })
        ]);
      }
      await page.waitForTimeout(1600);
      status = response?.status() || status;
      body = cleanText(await page.locator('body').innerText().catch(() => ''));
      if (blockedText(body, status)) throw monitorError('restricted', `網站回應 ${status} 或出現驗證/排隊/限制頁`);
    }
    return { page, status };
  } catch (e) {
    await page.close().catch(() => {});
    throw e;
  }
}

async function discoverTixcraftStages(url) {
  const { page, status } = await tixcraftOpen(url);
  try {
    const stages = await page.evaluate(() => {
      const norm = v => String(v || '').replace(/\s+/g, ' ').trim();
      const visible = el => { const s=getComputedStyle(el), r=el.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
      const rows = [...document.querySelectorAll('tr')].filter(visible).filter(tr => /Find tickets|立即訂購|立即購票|購票/i.test(norm(tr.innerText)));
      return rows.slice(0,100).map((row,index) => {
        const text = norm(row.innerText).slice(0,500);
        const control = [...row.querySelectorAll('a,button,input[type="submit"],input[type="button"]')].find(el => /Find tickets|立即訂購|立即購票|購票/i.test(norm(el.innerText || el.value || el.getAttribute('aria-label'))));
        const anchor = control?.tagName === 'A' ? control : control?.closest('a');
        let href = anchor?.href && /^https?:/i.test(anchor.href) ? anchor.href : '';
        if (!href && control) {
          const dataHref = control.getAttribute('data-href') || control.getAttribute('data-url') || control.getAttribute('formaction') || '';
          if (dataHref) { try { href = new URL(dataHref, location.href).href; } catch {} }
        }
        const cells = [...row.querySelectorAll('td')].map(td => norm(td.innerText)).filter(Boolean);
        const label = cells.length ? cells.slice(0,4).join(' | ') : text;
        return { index, label: label || `場次 ${index+1}`, href };
      });
    });
    return { status, title: await page.title(), finalUrl: page.url(), stages };
  } finally { await page.close(); }
}

async function collectTixcraftTickets(page) {
  return page.evaluate(() => {
    const norm = v => String(v || '').replace(/\s+/g, ' ').trim();
    const visible = el => { if(!el)return false; const s=getComputedStyle(el),r=el.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
    const enabled = el => visible(el) && !el.disabled && !el.matches(':disabled') && el.getAttribute('aria-disabled')!=='true' && !el.closest('.disabled,[aria-disabled="true"]');
    const sold = /已售完|售完|售罄|完售|sold\s*out|無票|暫無票/i;
    const future = /尚未開賣|尚未開始|未開賣|停止售票|已結束|sale not started/i;
    const roots = [...document.querySelectorAll('tr,li,[class*="area"],[class*="zone"],[class*="ticket"],[class*="price"],.row,.item')]
      .filter(visible).filter(el => !el.closest('header,footer,nav'))
      .filter(el => /(?:NT\$|TWD|NTD|\$)\s*[\d,]+|\b\d{3,6}\b\s*元|免費|售完|sold\s*out/i.test(norm(el.innerText)));
    const smallest = roots.filter(el => !roots.some(ch => ch!==el && el.contains(ch) && norm(ch.innerText).length>0));
    return smallest.slice(0,220).map((el,idx) => {
      const text = norm(el.innerText).slice(0,700);
      const price = (text.match(/(?:NT\$|TWD|NTD|\$)\s*[\d,]+|\b\d{3,6}\b\s*元/i)||[''])[0];
      const controls = [...el.querySelectorAll('a,button,input[type="radio"],input[type="checkbox"],select')].filter(visible);
      const selectable = controls.some(x => enabled(x) && !/disabled|sold/i.test(String(x.className||'')));
      const isSold = sold.test(text), isFuture = future.test(text);
      const accessible = /身障|身心障礙|輪椅|愛心席|陪同席|accessible|wheelchair/i.test(text);
      const name = text.slice(0,220);
      const stableText = text.replace(/已售完|售完|售罄|完售|sold\s*out|無票|暫無票|尚未開賣|尚未開始|未開賣|停止售票|已結束/gi,'').replace(/\s+/g,' ').trim();
      const key = `${price}|${accessible?'A':'N'}|${stableText.slice(0,150)}`;
      return { index:idx, key, name, price, accessible, available:!isSold&&!isFuture&&selectable,
        state:isSold?'sold_out':isFuture?'not_started':selectable?'available':'unknown', text };
    }).filter(t => t.name && (t.price || /售完|sold\s*out/i.test(t.text)));
  });
}

async function discoverTixcraftTickets(url, stage) {
  const { page, status } = await tixcraftOpen(url, stage);
  try {
    const tickets = await collectTixcraftTickets(page);
    return { status, title: await page.title(), finalUrl: page.url(), tickets };
  } finally { await page.close(); }
}

async function tixcraftSnapshot(m) {
  if (!m.tixcraftStage) throw new Error('請先按「讀取場次」，選擇拓元場次後再開始監控。');
  const { page } = await tixcraftOpen(m.url, m.tixcraftStage);
  try {
    const tickets = await collectTixcraftTickets(page);
    const wantedKeys = new Set(Array.isArray(m.tixcraftTicketKeys) ? m.tixcraftTicketKeys : []);
    let monitored = wantedKeys.size ? tickets.filter(t => wantedKeys.has(t.key)) : tickets;
    if (m.excludeAccessible !== false) monitored = monitored.filter(t => !t.accessible);
    const available = monitored.filter(t => t.available);
    const summary = available.length
      ? `發現可購買票區：${available.slice(0,8).map(t=>t.name).join('、')}`
      : monitored.length ? `已檢查 ${monitored.length} 個票區，目前未發現可購買票區` : '未找到符合設定的票區，請重新讀取場次/票種。';
    return { site:'tixcraft', available:available.length>0, summary,
      fingerprint:JSON.stringify(monitored.map(t=>[t.key,t.state])).slice(0,16000), finalUrl:page.url() };
  } finally { await page.close(); }
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
      return { text: document.body.innerText, controls, hasPassword: !!document.querySelector('input[type="password"]') };
    });

    const text = cleanText(snapshot.text);
    if (looksLikeLoginPage(text, snapshot.hasPassword)) {
      const e = monitorError('login_required', '雲端讀到登入頁，需要本機已登入的瀏覽器接手。');
      e.pause = true; throw e;
    }
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
  return { site: 'generic', ...d, fingerprint: d.fingerprint || stablePageFingerprint(text, controls) };
}

async function inspectUnchecked(m, options = {}) {
  const type = siteType(m.url);
  const mode = m.detectionMode || 'page';

  // Universal modes deliberately ignore ticket-site-specific assumptions. This lets
  // the same monitor work for stock, product pages, reservation pages, news pages,
  // and future sites we have never seen before.
  if (mode !== 'auto') {
    try {
      return parseGenericHtml(await httpHtml(m.url), m);
    } catch (e) {
      if (e.pause) throw e;
      return browserSnapshot(m.url, m, 'generic');
    }
  }

  // "auto" is the optional site-enhanced mode. Known sites keep their dedicated
  // parsers; unknown sites still use the generic stock / sold-out / buy-button rules.
  if (type === 'kham') return parseKham(await httpHtml(m.url));
  if (type === 'avex') return parseAvex(await httpHtml(m.url));
  if (type === 'kktix') return kktixSnapshot(m, options);
  if (type === 'ticketplus') return ticketplusSnapshot(m);
  if (type === 'tixcraft') return tixcraftSnapshot(m);
  if (type === 'ibon') return browserSnapshot(m.url, m, type);
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
  const title = `🔔 ${m.name || '網頁監控'} 有變化`;
  const body = `${result.summary}\n${m.url}`;
  const r = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      'Title': encodeURIComponent(title),
      'Priority': 'urgent',
      'Tags': 'bell,rotating_light',
      'Click': siteType(m.url) === 'ticketplus' && m.ticketplusStage?.href ? m.ticketplusStage.href :
        siteType(m.url) === 'tixcraft' && m.tixcraftStage?.href ? m.tixcraftStage.href : m.url,
      'Content-Type': 'text/plain; charset=utf-8'
    },
    body
  });
  if (!r.ok) throw new Error(`ntfy ${r.status}`);
}

function publicMonitor(m) {
  const r = runtime.get(m.id) || {};
  const { localKeyHash, ...safe } = m;
  if (m.execution === 'browser' || (m.execution === 'auto' && m.fallbackToLocal)) return localPublic(m, safe);
  return { ...safe, state: r.state || (m.pauseReason ? 'paused' : m.running ? 'running' : 'stopped'),
    activeExecution: m.execution === 'auto' ? 'cloud' : m.execution,
    nextAt: r.nextAt || null, lastError: r.lastError ?? m.lastError ?? '', siteType: siteType(m.url) };
}

function scheduleNext(m, delaySec) {
  if (shuttingDown || m.execution === 'browser' || (m.execution === 'auto' && m.fallbackToLocal) || !m.running || !store.monitors.includes(m)) return;
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
  if (!m || m.execution === 'browser' || (m.execution === 'auto' && m.fallbackToLocal) || !m.running || shuttingDown || activeRuns.has(id)) return;
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
    m.lastCheck = `${t.date} ${t.time}`;
    const pageMode = m.detectionMode === 'page';
    const previousFingerprint = m.lastFingerprint || '';
    const currentFingerprint = result.fingerprint || '';
    const pageChanged = pageMode && !!previousFingerprint && !!currentFingerprint && previousFingerprint !== currentFingerprint;
    const shouldNotify = pageMode ? pageChanged : !!result.available;
    if (pageMode) {
      m.lastResult = !previousFingerprint
        ? '智慧整頁監控：已建立第一份基準，之後重要內容改變才通知。'
        : pageChanged ? `智慧整頁監控：偵測到頁面內容變化。${result.summary ? ` ${result.summary}` : ''}`
          : '智慧整頁監控：目前沒有偵測到重要內容變化。';
    } else m.lastResult = result.summary;
    m.lastFingerprint = currentFingerprint; m.detected = shouldNotify;
    m.lastError = ''; m.pauseReason = ''; m.retryAfterAt = 0;
    m.cloudFailCount = 0; m.fallbackToLocal = false; m.fallbackReason = '';
    if (shouldNotify) {
      m.running = false; m.detectedAt = m.lastCheck;
      runtime.set(id, { ...runtime.get(id), state: 'detected', nextAt: null, lastError: '' });
      await saveStore();
      await closeKktixSession(id);
      const notifyResult = pageMode ? { ...result, summary: m.lastResult } : result;
      await notify(m, notifyResult).catch(error => {
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
    m.cloudFailCount = Number(m.cloudFailCount || 0) + 1;
    const fallbackReason = error.diagnosticCode || error.code || (error.pause ? 'restricted' : 'cloud_error');
    const shouldFallback = m.execution === 'auto' && (error.pause || m.cloudFailCount >= 3);
    if (shouldFallback) {
      m.fallbackToLocal = true; m.fallbackReason = fallbackReason; m.pauseReason = fallbackReason;
      m.localState = 'waiting_device'; m.localLeaseUntil = 0; m.localRunId = crypto.randomUUID();
      runtime.set(id, { ...runtime.get(id), state: 'waiting_device', lastError: error.message, nextAt: null });
      await saveStore(); await closeKktixSession(id); return;
    }
    if (error.pause) {
      m.running = false; m.pauseReason = fallbackReason;
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
  const execution = input.execution ?? existing.execution ?? 'auto';
  if (!['auto', 'cloud', 'browser'].includes(execution)) throw new Error('Invalid execution mode');
  const localTixcraftStage = input.tixcraftStage || existing.tixcraftStage || null;
  if ((execution === 'auto' || execution === 'browser') && !supportsLocalBrowser(url, localTixcraftStage))
    throw new Error('本機執行需要有效的 HTTP(S) 網址。');
  return {
    ...existing,
    execution,
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
    detectionMode: ['page','auto','stock','soldout','custom'].includes(input.detectionMode)
      ? input.detectionMode
      : (existing.detectionMode || (existing.id && existing.watchText ? 'custom' : 'page')),
    watchText: String(input.watchText || existing.watchText || '已售完'),
    watchCondition: input.watchCondition === 'appears' ? 'appears' : (input.watchCondition === 'disappears' ? 'disappears' : (existing.watchCondition || 'disappears')),
    ntfyTopic: String(input.ntfyTopic || existing.ntfyTopic || '').trim(),
    ticketplusStage: input.ticketplusStage || existing.ticketplusStage || null,
    ticketplusTicketKeys: Array.isArray(input.ticketplusTicketKeys) ? input.ticketplusTicketKeys.map(String) : (existing.ticketplusTicketKeys || []),
    tixcraftStage: input.tixcraftStage || existing.tixcraftStage || null,
    tixcraftTicketKeys: Array.isArray(input.tixcraftTicketKeys) ? input.tixcraftTicketKeys.map(String) : (existing.tixcraftTicketKeys || []),
    excludeAccessible: input.excludeAccessible === undefined ? (existing.excludeAccessible ?? true) : !!input.excludeAccessible,
    fallbackToLocal: !!existing.fallbackToLocal,
    fallbackReason: existing.fallbackReason || '',
    cloudFailCount: Number(existing.cloudFailCount || 0),
    running: !!existing.running,
    checks: Number(existing.checks || 0),
    lastCheck: existing.lastCheck || '',
    lastResult: existing.lastResult || '',
    lastError: existing.lastError || '',
    detectedAt: existing.detectedAt || ''
  };
}



app.post('/api/tixcraft/stages', async (req, res) => {
  const url = cleanText(req.body?.url);
  if (!url) return res.status(400).json({ error: '請貼拓元活動網址。' });
  if (siteType(url) !== 'tixcraft') return res.status(400).json({ error: '請貼 tixcraft.com 的活動網址。' });
  try { res.json(await discoverTixcraftStages(url)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/tixcraft/tickets', async (req, res) => {
  const url = cleanText(req.body?.url), stage = req.body?.stage;
  if (!url || !stage) return res.status(400).json({ error: '請先選擇拓元場次。' });
  if (siteType(url) !== 'tixcraft') return res.status(400).json({ error: '請貼 tixcraft.com 的活動網址。' });
  try { res.json(await discoverTixcraftTickets(url, stage)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});


app.post('/api/ticketplus/diagnose-order', async (req, res) => {
  try {
    const url = cleanText(req.body?.url);
    if (!url || siteType(url) !== 'ticketplus') return res.status(400).json({ error: '請貼 Ticket Plus 網址。' });
    if (!isTicketplusOrderUrl(url)) return res.status(400).json({ error: '這個按鈕是給 Ticket Plus /order/ 單場網址使用。' });
    res.json(await diagnoseTicketplusOrder(url));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ticketplus/stages', async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (siteType(url) !== 'ticketplus') return res.status(400).json({ error: '請貼 Ticket Plus 活動網址。' });
    const result = await discoverTicketplusStages(url);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/ticketplus/tickets', async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (siteType(url) !== 'ticketplus') return res.status(400).json({ error: '請貼 Ticket Plus 活動網址。' });
    if (!req.body?.stage) return res.status(400).json({ error: '請先選擇場次。' });
    const result = await discoverTicketplusTickets(url, req.body.stage);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});


// Universal local relay. It accepts only explicitly paired, read-only page observations
// from a foreground browser. No cookies or passwords are accepted.
const LOCAL_LEASE_MS = 60000;
const localOps = new Map();
function localPublic(m, safe) {
  let state = 'stopped';
  if (m.detectedAt) state = 'detected';
  else if (m.running) state = m.localLeaseUntil > Date.now() ? (m.localState === 'waiting' ? 'waiting' : 'local_active') : 'waiting_device';
  else if (m.pauseReason) state = 'paused';
  return { ...safe, localPaired: !!m.localKeyHash, state,
    activeExecution: m.execution === 'auto' ? (m.fallbackToLocal ? 'browser' : 'cloud') : m.execution,
    localRequested: m.execution === 'browser' || (m.execution === 'auto' && m.fallbackToLocal),
    fallbackReason: m.fallbackReason || '',
    localOnline: !!(m.running && m.localLeaseUntil > Date.now()),
    nextAt: m.localLeaseUntil > Date.now() ? (m.localNextAt || null) : null,
    siteType: siteType(m.url) };
}
function localUrl(url, tixcraftStage = null) {
  let target = url;
  if (siteType(url) === 'tixcraft' && !isTixcraftAreaUrl(url) && tixcraftStage?.href) target = tixcraftStage.href;
  const u = new URL(target);
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password) throw new Error('Expected HTTP(S) URL');
  u.hash = '';
  return u.toString();
}
function localConfig(m) {
  return { id:m.id, url:localUrl(m.url, m.tixcraftStage), name:m.name, topic:m.ntfyTopic,
    min:m.minSeconds, max:m.maxSeconds, fixed:m.fixedSeconds, mode:m.intervalMode,
    detectionMode:m.detectionMode || 'page', watchText:m.watchText || '', watchCondition:m.watchCondition || 'disappears',
    exclude:m.excludeAccessible !== false, selected:m.localSelection || [],
    limitedTime:!!m.limitedTime, startTime:m.startTime, endTime:m.endTime,
    timezone:TZ, inSchedule:inSchedule(m), running:!!m.running, runId:m.localRunId || '',
    execution:m.execution, localRequested:m.execution === 'browser' || (m.execution === 'auto' && m.fallbackToLocal),
    fallbackReason:m.fallbackReason || '', state:m.localState || 'stopped', version:m.localConfigVersion || 0 };
}
function localOwner(m, clientId) {
  return m.localClientId === clientId && m.localLeaseUntil > Date.now();
}
function localAcquire(m, clientId, name) {
  if (m.localLeaseUntil > Date.now() && m.localClientId !== clientId)
    throw monitorError('another_device', '\u53e6\u4e00\u53f0\u88dd\u7f6e\u6b63\u5728\u57f7\u884c\uff0c\u8acb\u5148\u5728\u90a3\u53f0\u6309\u505c\u6b62\uff0c\u6216\u7b49\u5f85 60 \u79d2\u96e2\u7dda\u5224\u5b9a\u3002');
  m.localClientId = clientId; m.localDeviceName = String(name || 'Browser').slice(0,40);
  m.localLeaseUntil = Date.now() + LOCAL_LEASE_MS; m.localSeenAt = new Date().toISOString();
}
async function notifyLocal(m, summary) {
  if (!m.ntfyTopic) return;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(m.ntfyTopic)) throw Error('Invalid ntfy topic');
  let clickUrl=m.url; try { clickUrl=localUrl(m.url,m.tixcraftStage); } catch {}
  const r = await fetch('https://ntfy.sh/', { method:'POST',
    headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(10000),
    body:JSON.stringify({topic:m.ntfyTopic, title:`${m.name} - 網頁監控通知`,
      message:summary, click:clickUrl, priority:5, tags:['bell'],
      actions:[{action:'view',label:'開啟監控頁面',url:clickUrl}]}) });
  if (!r.ok) throw Error(`ntfy HTTP ${r.status}`);
}
app.post('/api/monitors/:id/pair-local', async (req,res) => {
  if (!ADMIN_PASSWORD) return res.status(400).json({error:'Please set ADMIN_PASSWORD before pairing.'});
  const m=store.monitors.find(x=>x.id===req.params.id);
  if (!m) return res.status(404).json({error:'not found'});
  if (!supportsLocalBrowser(m.url, m.tixcraftStage)) return res.status(400).json({error:'本機配對需要有效的 HTTP(S) 網址。'});
  const waitingForLocal = m.running && m.execution === 'auto' && m.fallbackToLocal && m.localLeaseUntil <= Date.now();
  if ((m.running && !waitingForLocal) || activeRuns.has(m.id) || activeInspections.has(m.id) || localOps.has(m.id))
    return res.status(409).json({error:'目前正在檢查；請等這輪完成。若已顯示「等待本機」，可直接配對，不必先停止。'});
  const token=crypto.randomBytes(32).toString('base64url');
  m.localKeyHash=diagnosticKey(token);m.localLeaseUntil=0;
  m.localRunId=crypto.randomUUID();m.lastError='';
  if (waitingForLocal) {
    m.localState='waiting_device';
    runtime.set(m.id,{...runtime.get(m.id),state:'waiting_device',nextAt:null});
  } else {
    m.localState='stopped';m.pauseReason='';
    clearTimeout(runtime.get(m.id)?.timer); runtime.set(m.id,{state:'stopped',nextAt:null});
  }
  await saveStore();
  res.json({token,monitorId:m.id,url:localUrl(m.url,m.tixcraftStage)});
});
app.post('/api/local', async (req,res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({error:'Local pairing unavailable without admin authentication.'});
  const b=req.body || {}, token=(req.headers.authorization || '').replace(/^Bearer /,'');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return res.status(401).json({error:'Invalid pairing token'});
  const hash=diagnosticKey(token);
  const m=store.monitors.find(x=>x.id===b.monitorId);
  if (!m || !m.localKeyHash || !['auto','browser'].includes(m.execution) ||
      !crypto.timingSafeEqual(Buffer.from(hash),Buffer.from(m.localKeyHash)))
    return res.status(401).json({error:'\u914d\u5c0d\u5df2\u5931\u6548\uff0c\u8acb\u91cd\u65b0\u914d\u5c0d\u3002'});
  if (localOps.has(m.id)) return res.status(409).json({error:'\u6b63\u5728\u8655\u7406\u4e0a\u4e00\u500b\u56de\u5831\uff0c\u8acb\u7a0d\u5f8c\u3002'});
  localOps.set(m.id,true);
  try {
    if (localUrl(b.url)!==localUrl(m.url,m.tixcraftStage)) return res.status(400).json({error:'\u914d\u5c0d\u7684\u5834\u6b21\u8207\u76ee\u524d\u9801\u9762\u4e0d\u540c\u3002'});
    const action=b.action, clientId=String(b.clientId || '');
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(clientId)) return res.status(400).json({error:'Invalid client ID'});
    if (!['sync','configure','begin','heartbeat','report','release','suspend'].includes(action)) return res.status(400).json({error:'Invalid action'});
    if (action==='sync') return res.json(localConfig(m));
    if (action==='configure') {
      if (m.running && m.localLeaseUntil > Date.now()) return res.status(409).json({error:'先停止監控，再更改本機監控目標。'});
      if (!Array.isArray(b.selected) || b.selected.length<1 || b.selected.length>100 || b.verified!==true)
        return res.status(400).json({error:'請先選擇至少一個監控目標並確認設定。'});
      const allowedConditions=new Set(['auto','changes','appears','disappears','contains','not_contains','number_gt','enabled','visible','page_auto','stock_gt_zero','soldout_cleared']);
      const selected=b.selected.map(t=>({
        key:String(t.key||'').slice(0,220), label:String(t.label||'').slice(0,180),
        kind:String(t.kind||'ticket').slice(0,24), price:Number.isFinite(Number(t.price))?Number(t.price):0,
        accessible:!!t.accessible, selector:String(t.selector||'').slice(0,1000), frameUrl:String(t.frameUrl||'').slice(0,1500),
        condition:allowedConditions.has(String(t.condition||''))?String(t.condition):'auto',
        value:String(t.value||'').slice(0,500), threshold:Number.isFinite(Number(t.threshold))?Number(t.threshold):0,
        baseline:String(t.baseline||'').slice(0,3000)
      }));
      if (selected.some(t=>!t.key || !t.label)) return res.status(400).json({error:'Invalid local selection'});
      if (new Set(selected.map(t=>t.key)).size!==selected.length) return res.status(400).json({error:'Duplicate monitor keys'});
      if (m.excludeAccessible!==false && selected.some(t=>t.kind==='ticket' && (t.accessible || isAccessibleTicketText(t.label)))) return res.status(400).json({error:'已啟用排除特殊席，請取消這些票種。'});
      m.localSelection=selected;m.localConfigVersion=(m.localConfigVersion || 0)+1;
    } else if (action==='begin') {
      if (!m.localSelection?.length) return res.status(400).json({error:'尚未儲存本機監控目標。'});
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(m.ntfyTopic || '')) return res.status(400).json({error:'\u8acb\u5148\u5728\u7ba1\u7406\u9801\u586b\u6b63\u78ba ntfy Topic\u3002'});
      if (m.execution === 'auto') { m.fallbackToLocal = true; m.fallbackReason = m.fallbackReason || 'manual_local_takeover'; }
      localAcquire(m,clientId,b.deviceName);
      if (!m.running) { m.localRunId=crypto.randomUUID();m.localNonces=[]; }
      m.running=true;m.detectedAt='';m.detected=false;m.pauseReason='';m.lastError='';
      m.localState='running';
    } else if (action==='heartbeat') {
      if (!m.running) return res.json(localConfig(m));
      if (b.runId!==m.localRunId) return res.status(409).json({error:'\u76e3\u63a7\u5df2\u91cd\u8a2d\uff0c\u8acb\u91cd\u65b0\u6309\u958b\u59cb\u3002'});
      localAcquire(m,clientId,b.deviceName);
      m.localState=inSchedule(m)?'running':'waiting';
      m.localNextAt=Number.isFinite(b.nextAt)?Math.min(b.nextAt,Date.now()+3600000):null;
    } else if (action==='report') {
      if (!/^[a-zA-Z0-9_-]{16,80}$/.test(String(b.nonce || ''))) return res.status(400).json({error:'Invalid report ID'});
      if ((m.localNonces || []).includes(b.nonce)) return res.json({...localConfig(m),duplicate:true});
      if (!m.running || b.runId!==m.localRunId || !localOwner(m,clientId)) return res.status(409).json({error:'\u672c\u6b21\u56de\u5831\u5df2\u904e\u671f\u6216\u5df2\u505c\u6b62\uff0c\u4e0d\u767c\u9001\u901a\u77e5\u3002'});
      if (!inSchedule(m)) return res.json({...localConfig(m),ignored:true});
      if (!Array.isArray(b.rows) || b.rows.length>100) return res.status(400).json({error:'Invalid rows'});
      const byKey=new Map(b.rows.map(t=>[String(t.key),t]));
      const watched=(m.localSelection || []).map(t=>({
        ...t,
        state:String(byKey.get(t.key)?.state||''), matched:byKey.get(t.key)?.matched===true,
        current:String(byKey.get(t.key)?.current||'').slice(0,500),
        reason:String(byKey.get(t.key)?.reason||'').slice(0,240)
      }));
      const genericMode=watched.some(t=>t.kind!=='ticket');
      const incomplete = genericMode
        ? (!watched.length || watched.some(t=>!byKey.has(t.key) || !['ok','missing'].includes(t.state)))
        : (!watched.length || watched.some(t=>!['available','sold','not_started'].includes(t.state)));
      if (incomplete) {
        m.running=false;m.localLeaseUntil=0;m.pauseReason='local_unknown';m.lastError=genericMode
          ? '本機未能完整確認所有監控目標，已停止；不代表條件成立。'
          : '本機未讀到完整票種，已停止；不代表售完。';
      } else {
        m.checks=Number(m.checks||0)+1;const t=nowParts();m.lastCheck=`${t.date} ${t.time}`;
        m.localSeenAt=new Date().toISOString();m.localLeaseUntil=Date.now()+LOCAL_LEASE_MS;
        const hits=genericMode
          ? watched.filter(t=>t.matched)
          : watched.filter(t=>t.state==='available' && !(m.excludeAccessible!==false && (t.accessible || isAccessibleTicketText(t.label))));
        m.lastResult=hits.length
          ? hits.map(t=>genericMode?`${t.label}：${t.reason||t.current||'條件成立'}`:`${t.label}${t.price?` $${t.price}`:''}: ${t.reason}`).join('
')
          : genericMode?`已檢查 ${watched.length} 個監控目標，目前條件未成立。`:`已檢查 ${watched.length} 個指定票種，目前無可選購證據。`;
        m.lastError='';m.pauseReason='';
        m.localRows=watched.map(({key,label,price,state,matched,current})=>({key,label,price,state,matched,current}));
        if (hits.length) {m.running=false;m.detected=true;m.detectedAt=m.lastCheck;m.localState='detected';m.localLeaseUntil=0;}
      }
      m.localNonces=[...(m.localNonces || []).slice(-9),b.nonce];
      await saveStore();
      if (m.detectedAt) { try { await notifyLocal(m,m.lastResult+'\n請以原網頁實際狀態為準。'); } catch(e) {m.lastError=`\u901a\u77e5\u5931\u6557: ${e.message}`;} }
    } else if (action==='release' || action==='suspend') {
      if (m.localClientId===clientId && (!b.runId || b.runId===m.localRunId)) {
        m.localLeaseUntil=0;m.localNextAt=null;m.localState=action==='suspend'?'foreground_paused':'stopped';
        if (action==='release') {m.running=false;if(b.error){m.lastError=String(b.error).slice(0,300);m.pauseReason='local_paused';}}
      }
    }
    await saveStore();res.json(localConfig(m));
  } catch(e) { res.status(409).json({error:e.message}); }
  finally { localOps.delete(m.id); }
});

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
    if (activeInspections.has(old.id) || activeRuns.has(old.id) || localOps.has(old.id)) return res.status(409).json({ error: '請先停止監控並等待檢查結束，再儲存編輯。' });
    const m = normalizeMonitor(req.body, old);
    if (m.url !== old.url || m.detectionMode !== old.detectionMode || m.watchText !== old.watchText || m.watchCondition !== old.watchCondition) m.lastFingerprint = '';
    m.localLeaseUntil = 0; m.localState = 'stopped'; m.localRunId = crypto.randomUUID();
    if (m.url !== old.url) { delete m.localKeyHash; m.localSelection = []; }
    if (m.execution !== 'auto') { m.fallbackToLocal = false; m.fallbackReason = ''; }
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
  if (localOps.has(req.params.id)) return res.status(409).json({error:'Local report is being saved; retry shortly.'});
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
  m.cloudFailCount = 0;
  if (m.execution === 'auto') { m.fallbackToLocal = false; m.fallbackReason = ''; m.localState = 'standby'; m.localLeaseUntil = 0; m.localRunId = crypto.randomUUID(); }
  if (m.execution === 'browser') { m.localState = 'waiting'; m.localLeaseUntil = 0; m.localRunId = crypto.randomUUID(); }
  runtime.set(m.id, { ...runtime.get(m.id), state: m.execution === 'browser' ? 'waiting_device' : 'running', lastError: '' });
  await saveStore(); scheduleNext(m, 0.05);
  res.json(publicMonitor(m));
});

app.post('/api/monitors/:id/stop', async (req, res) => {
  const m = store.monitors.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  m.running = false; m.pauseReason = ''; m.fallbackToLocal = false; m.fallbackReason = '';
  if (m.execution === 'browser' || m.execution === 'auto') { m.localState = 'stopped'; m.localLeaseUntil = 0; m.localRunId = crypto.randomUUID(); }
  clearTimeout(runtime.get(m.id)?.timer);
  runtime.set(m.id, { ...runtime.get(m.id), state: 'stopped', nextAt: null });
  if (!activeInspections.has(m.id)) await closeKktixSession(m.id);
  await saveStore(); res.json(publicMonitor(m));
});

app.post('/api/monitors/:id/test', async (req, res) => {
  const m = store.monitors.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (m.execution === 'browser') return res.status(409).json({ error: '這筆設定為僅本機，請在已配對的瀏覽器頁面測試。' });
  if (m.running || activeInspections.has(m.id) || activeRuns.has(m.id)) return res.status(409).json({ error: '請先停止這筆監控，等目前檢查結束後再測試抓取。' });
  runtime.set(m.id, { ...runtime.get(m.id), state: 'checking', nextAt: null, lastError: '' });
  try {
    const result = await inspect(m, { diagnostic: true });
    const t = nowParts(); m.lastCheck = `${t.date} ${t.time}`;
    m.lastResult = m.detectionMode === 'page' ? '智慧整頁測試成功：可讀取目前頁面；正式開始後第一輪會建立基準。' : result.summary; m.lastError = ''; m.pauseReason = '';
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
  if (m.running && m.execution !== 'browser' && !(m.execution === 'auto' && m.fallbackToLocal)) setTimeout(() => dispatchMonitor(m.id), 500 + Math.random() * 1500);
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
