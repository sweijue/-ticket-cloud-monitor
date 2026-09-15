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
const MIN_SECONDS = Math.max(1, Number(process.env.MIN_SECONDS || 1));
const TZ = process.env.TZ || 'Asia/Taipei';

await fs.mkdir(DATA_DIR, { recursive: true });

const app = express();
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

app.use(express.static(path.join(process.cwd(), 'public')));

let browser;
async function getBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}

let store = { monitors: [] };
try {
  store = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  if (!Array.isArray(store.monitors)) store.monitors = [];
} catch {}

const runtime = new Map();

async function saveStore() {
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2));
  await fs.rename(tmp, DATA_FILE);
}

function siteType(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('kham.com.tw')) return 'kham';
    if (host.includes('kktix.com')) return 'kktix';
    if (host.includes('shopping.avex.com.tw')) return 'avex';
    if (host.includes('tixcraft.com')) return 'tixcraft';
    if (host.includes('ibon.com.tw') || host.includes('ticket.ibon.com.tw')) return 'ibon';
    return 'generic';
  } catch { return 'generic'; }
}

function secondsFor(m) {
  if (m.intervalMode === 'fixed') return Math.max(MIN_SECONDS, Number(m.fixedSeconds || 5));
  const min = Math.max(MIN_SECONDS, Number(m.minSeconds || 1));
  const max = Math.max(min, Number(m.maxSeconds || 5));
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
    if (type === 'kktix') {
      available = enabled.length > 0 && !/尚未開賣|活動尚未開始/.test(text);
      summary = available ? `發現可操作票券/報名控制項：${enabled.slice(0, 5).map(x => x.text || x.tag).join('、')}` : `目前未發現可購買票券（售完提示 ${soldCount} 處）`;
    } else if (type === 'tixcraft' || type === 'ibon') {
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

async function inspect(m) {
  const type = siteType(m.url);
  if (type === 'kham') return parseKham(await httpHtml(m.url));
  if (type === 'avex') return parseAvex(await httpHtml(m.url));
  if (['kktix', 'tixcraft', 'ibon'].includes(type)) return browserSnapshot(m.url, m, type);
  try {
    return parseGenericHtml(await httpHtml(m.url), m);
  } catch (e) {
    if (e.pause) throw e;
    return browserSnapshot(m.url, m, 'generic');
  }
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
  // Never expose the Node.js Timeout object stored in runtime.timer.
  // Timeout contains circular references and makes res.json() fail with HTTP 500.
  const r = runtime.get(m.id) || {};
  const { timer, ...safeRuntime } = r;
  return { ...m, ...safeRuntime, siteType: siteType(m.url) };
}

function scheduleNext(m, delaySec) {
  clearTimeout(runtime.get(m.id)?.timer);
  const nextAt = Date.now() + delaySec * 1000;
  const timer = setTimeout(() => runMonitor(m.id), delaySec * 1000);
  runtime.set(m.id, { ...runtime.get(m.id), timer, nextAt });
}

async function runMonitor(id) {
  const m = store.monitors.find(x => x.id === id);
  if (!m || !m.running) return;

  if (!inSchedule(m)) {
    runtime.set(id, { ...runtime.get(id), state: 'waiting', lastError: '', nextAt: Date.now() + 30000 });
    return scheduleNext(m, 30);
  }

  runtime.set(id, { ...runtime.get(id), state: 'checking', lastError: '' });
  try {
    const result = await inspect(m);
    const t = nowParts();
    m.checks = Number(m.checks || 0) + 1;
    m.lastCheck = `${t.date} ${t.time}`;
    m.lastResult = result.summary;
    m.lastFingerprint = result.fingerprint;
    m.detected = !!result.available;

    if (result.available) {
      m.running = false;
      m.detectedAt = m.lastCheck;
      await saveStore();
      runtime.set(id, { ...runtime.get(id), state: 'detected', nextAt: null });
      await notify(m, result).catch(err => {
        runtime.set(id, { ...runtime.get(id), lastError: `通知失敗：${err.message}` });
      });
      return;
    }

    await saveStore();
    runtime.set(id, { ...runtime.get(id), state: 'running' });
    scheduleNext(m, secondsFor(m));
  } catch (e) {
    m.lastCheck = `${nowParts().date} ${nowParts().time}`;
    m.lastError = e.message;
    if (e.pause) {
      m.running = false;
      await saveStore();
      runtime.set(id, { ...runtime.get(id), state: 'paused', lastError: e.message, nextAt: null });
      return;
    }
    await saveStore();
    runtime.set(id, { ...runtime.get(id), state: 'error', lastError: e.message });
    scheduleNext(m, Math.max(30, secondsFor(m)));
  }
}

function normalizeMonitor(input, existing = {}) {
  const url = String(input.url || existing.url || '').trim();
  new URL(url);
  return {
    ...existing,
    id: existing.id || crypto.randomUUID(),
    name: String(input.name || existing.name || '').trim() || new URL(url).hostname,
    url,
    intervalMode: input.intervalMode === 'fixed' ? 'fixed' : 'random',
    fixedSeconds: Math.max(MIN_SECONDS, Number(input.fixedSeconds || 5)),
    minSeconds: Math.max(MIN_SECONDS, Number(input.minSeconds || 1)),
    maxSeconds: Math.max(MIN_SECONDS, Number(input.maxSeconds || 5)),
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
    const m = normalizeMonitor(req.body, old);
    m.running = old.running;
    store.monitors[idx] = m;
    await saveStore();
    res.json(publicMonitor(m));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/monitors/:id', async (req, res) => {
  const idx = store.monitors.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  clearTimeout(runtime.get(req.params.id)?.timer);
  runtime.delete(req.params.id);
  store.monitors.splice(idx, 1);
  await saveStore();
  res.json({ ok: true });
});

app.post('/api/monitors/:id/start', async (req, res) => {
  const m = store.monitors.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  m.running = true; m.lastError = ''; m.detectedAt = '';
  await saveStore();
  setTimeout(() => runMonitor(m.id), 50);
  res.json(publicMonitor(m));
});

app.post('/api/monitors/:id/stop', async (req, res) => {
  const m = store.monitors.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  m.running = false;
  clearTimeout(runtime.get(m.id)?.timer);
  runtime.set(m.id, { ...runtime.get(m.id), state: 'stopped', nextAt: null });
  await saveStore();
  res.json(publicMonitor(m));
});

app.post('/api/monitors/:id/test', async (req, res) => {
  const m = store.monitors.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  try {
    const result = await inspect(m);
    res.json({ ok: true, siteType: siteType(m.url), result });
  } catch (e) { res.status(400).json({ error: e.message, pause: !!e.pause }); }
});

app.post('/api/monitors/:id/test-notification', async (req, res) => {
  const m = store.monitors.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  try {
    await notify(m, { summary: '這是測試通知，收到代表 iPhone 推播設定正常。' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Ticket Cloud Monitor listening on :${PORT}`));

for (const m of store.monitors) {
  if (m.running) setTimeout(() => runMonitor(m.id), 500 + Math.random() * 1500);
}

process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
