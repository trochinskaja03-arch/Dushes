/**
 * Дюшес · сервер оплати для сайту на GitHub Pages (Cloudflare Worker).
 *
 * Що робить:
 *   POST /pay-mono        — надсилає замовлення в Telegram і створює рахунок monopay
 *   POST /pay-liqpay      — надсилає замовлення в Telegram і готує платіж LiqPay
 *   POST /mono-webhook    — monobank повідомляє статус оплати (підпис перевіряється)
 *   POST /liqpay-callback — LiqPay повідомляє статус оплати (підпис перевіряється)
 *   POST /np              — підказки міст, відділень, поштоматів і вулиць Нової Пошти
 *   POST /up              — відділення Укрпошти за містом або за індексом
 *   POST /lead            — «Допоможіть мені обрати» з блоку акції та консультації щодо розміру → Telegram
 *
 * Змінні (Cloudflare → Workers → ваш worker → Settings → Variables and Secrets):
 *   SITE_URL            адреса сайту, напр. https://imya.github.io/dushes   (обов'язково)
 *   TELEGRAM_BOT_TOKEN  токен бота від @BotFather                         (обов'язково — сюди приходять замовлення)
 *   TELEGRAM_CHAT_ID    ваш chat id                                        (обов'язково)
 *   MONO_TOKEN          токен еквайрингу monobank                          (секрет)
 *   LIQPAY_PUBLIC_KEY   публічний ключ LiqPay
 *   LIQPAY_PRIVATE_KEY  приватний ключ LiqPay                              (секрет)
 *   LIQPAY_SANDBOX      1 — тестовий режим LiqPay (видалити перед запуском)
 *   NP_API_KEY          ключ API Нової Пошти                               (секрет)
 *   UP_TOKEN            Bearer-токен Укрпошти (адресний класифікатор)      (секрет; без нього індекс вписують вручну)
 */

/* ---------- Ціна й знижки: тримайте однаковими з CONFIG в index.html ---------- */
// Ціни задаються в SIZES нижче (окремо для кожного розміру).
const DISCOUNTS = [];       // знижки за кількістю, напр. [{ min: 2, rate: 0.05 }] (зараз немає)
const PROMO_UNTIL = '2026-12-31T23:59:59+02:00'; // безкоштовна доставка на честь запуску
const COLORS = { violet: 'Фіолетова', white: 'Біла', grey: 'Сіра', rose: 'Темно-рожева' };
// Розміри й ціни: мають збігатися з CONFIG.sizes в index.html. Сервер рахує суму сам і не довіряє цінам із браузера.
const SIZES = {
  p: { name: 'Полуторна',  dims: '140×205 / 150×210', price: 2699 },
  d: { name: 'Двоспальна', dims: '175×205 / 180×210', price: 2699 },
  e: { name: 'Євро',       dims: '200×220', price: 2699 }
};

/* ---------- helpers ---------- */
const enc = new TextEncoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64ToBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const utf8ToB64 = str => b64(enc.encode(str));
const b64ToUtf8 = s => new TextDecoder().decode(b64ToBytes(s));

function cors(env, request) {
  const origin = request.headers.get('Origin') || '';
  let allowed = '*';
  try { if (env.SITE_URL) allowed = new URL(env.SITE_URL).origin; } catch (e) {}
  return {
    'Access-Control-Allow-Origin': allowed === '*' || origin === allowed ? (origin || allowed) : allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
});

function calcOrder(items, env) {
  if (!Array.isArray(items) || !items.length || items.length > 12) throw new Error('Кошик порожній');
  const lines = [];
  for (const it of items) {
    const name = COLORS[it && it.id];
    const size = SIZES[it && it.size];
    const qty = Math.floor(Number(it && it.qty));
    if (!name || !size || !(qty >= 1 && qty <= 100)) throw new Error('Невірний товар у кошику');
    lines.push({ name: `Ковдра Дюшес, ${name.toLowerCase()}, ${size.name.toLowerCase()} ${size.dims}`, short: `${name}, ${size.name} ${size.dims}`, qty, price: size.price });
  }
  const qty = lines.reduce((a, l) => a + l.qty, 0);
  const sum = lines.reduce((a, l) => a + l.qty * l.price, 0);
  const tier = DISCOUNTS.find(d => qty >= d.min);
  const discount = tier ? Math.round(sum * tier.rate) : 0;
  return { lines, qty, sum, discount, total: sum - discount, description: lines.map(l => `${l.name} × ${l.qty}`).join('; ') };
}
const validOrderId = id => typeof id === 'string' && /^DS-[A-Z0-9]{4,12}$/.test(id);
const clip = (v, n = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n);
const siteUrl = env => (env.SITE_URL || '').replace(/\/$/, '');

async function telegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) { console.log('[telegram off]', text); return false; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true })
    });
    return r.ok;
  } catch (e) { console.error('telegram', e); return false; }
}

function orderMessage(orderId, calc, o, payment) {
  const lines = [
    `🛒 Нове замовлення ${orderId}`,
    `Оплата: ${payment} · очікує оплати`,
    '',
    ...calc.lines.map(l => `• ${l.short} × ${l.qty}`),
    `Сума: ${calc.total} ₴${calc.discount ? ` (знижка ${calc.discount} ₴)` : ''}`,
    Date.now() < Date.parse(PROMO_UNTIL) ? 'Доставка: безкоштовна (акція до 31.12)' : 'Доставка: за тарифами перевізника',
    '',
    `👤 ${clip(o.name, 80)}`,
    `📞 ${clip(o.phone, 30)}`,
    o.email ? `✉️ ${clip(o.email, 80)}` : '',
    `🚚 ${clip(o.delivery, 60)}`,
    `${clip(o.city, 80)}${o.branch ? ', ' + clip(o.branch, 160) : ''}${o.address ? ', ' + clip(o.address, 160) : ''}${o.zip ? ', ' + clip(o.zip, 5) : ''}`,
    o.comment ? `💬 ${clip(o.comment, 400)}` : ''
  ];
  return lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n');
}

/* ---------- LiqPay ---------- */
async function liqpaySign(data, priv) {
  return b64(await crypto.subtle.digest('SHA-1', enc.encode(priv + data + priv)));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ---------- monobank: ECDSA P-256, підпис X-Sign у форматі DER ---------- */
let monoKey = null;
async function monoPubKey(env, force) {
  if (monoKey && !force) return monoKey;
  const r = await fetch('https://api.monobank.ua/api/merchant/pubkey', { headers: { 'X-Token': env.MONO_TOKEN } });
  const { key } = await r.json();
  const pem = b64ToUtf8(key);
  const der = b64ToBytes(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
  monoKey = await crypto.subtle.importKey('spki', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return monoKey;
}
function derToRaw(der) {
  // SEQUENCE { INTEGER r, INTEGER s } → r(32) || s(32)
  let i = 2; if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const read = () => {
    if (der[i] !== 0x02) throw new Error('bad DER'); const len = der[i + 1];
    let v = der.slice(i + 2, i + 2 + len); i += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32); out.set(v, 32 - v.length); return out;
  };
  const r = read(), s = read(); const raw = new Uint8Array(64); raw.set(r, 0); raw.set(s, 32); return raw;
}
async function monoVerify(env, body, sigB64) {
  const sig = derToRaw(b64ToBytes(sigB64));
  const algo = { name: 'ECDSA', hash: 'SHA-256' };
  if (await crypto.subtle.verify(algo, await monoPubKey(env, false), sig, enc.encode(body))) return true;
  return crypto.subtle.verify(algo, await monoPubKey(env, true), sig, enc.encode(body)); // ключ міг змінитися
}

/* ---------- routes ---------- */
async function readOrder(request, env) {
  let body; try { body = await request.json(); } catch (e) { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
  if (!validOrderId(body.orderId)) throw Object.assign(new Error('Невірний номер замовлення'), { status: 400 });
  const calc = calcOrder(body.items, env);
  const o = body.order || {};
  if (!o.name || !o.phone) throw Object.assign(new Error('Немає контактів'), { status: 400 });
  return { body, calc, o };
}

async function payMono(request, env, h) {
  if (!env.MONO_TOKEN) return json(503, { ok: false, error: 'monopay ще не налаштовано' }, h);
  const { body, calc, o } = await readOrder(request, env);
  const saved = await telegram(env, orderMessage(body.orderId, calc, o, 'monopay'));
  const self = new URL(request.url).origin;
  const payload = {
    amount: calc.total * 100, ccy: 980,
    merchantPaymInfo: { reference: body.orderId, destination: `Замовлення ${body.orderId}: ${calc.description}`.slice(0, 280) },
    redirectUrl: `${siteUrl(env)}/?order=${encodeURIComponent(body.orderId)}`,
    webHookUrl: `${self}/mono-webhook`,
    validity: 3600
  };
  if (o.email && /^\S+@\S+\.\S+$/.test(o.email)) payload.merchantPaymInfo.customerEmails = [clip(o.email, 80)];
  const r = await fetch('https://api.monobank.ua/api/merchant/invoice/create', {
    method: 'POST', headers: { 'X-Token': env.MONO_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.pageUrl) { console.error('mono create', r.status, JSON.stringify(j)); return json(502, { ok: false, saved, error: 'monopay не прийняв рахунок' }, h); }
  return json(200, { ok: true, saved, pageUrl: j.pageUrl, amount: calc.total }, h);
}

async function payLiqpay(request, env, h) {
  if (!env.LIQPAY_PUBLIC_KEY || !env.LIQPAY_PRIVATE_KEY) return json(503, { ok: false, error: 'LiqPay ще не налаштовано' }, h);
  const { body, calc, o } = await readOrder(request, env);
  const saved = await telegram(env, orderMessage(body.orderId, calc, o, 'LiqPay'));
  const self = new URL(request.url).origin;
  const params = {
    version: 3, public_key: env.LIQPAY_PUBLIC_KEY, action: 'pay',
    amount: calc.total, currency: 'UAH',
    description: `Замовлення ${body.orderId}: ${calc.description}`.slice(0, 250),
    order_id: body.orderId, language: 'uk',
    result_url: `${siteUrl(env)}/?order=${encodeURIComponent(body.orderId)}`,
    server_url: `${self}/liqpay-callback`
  };
  if (env.LIQPAY_SANDBOX === '1') params.sandbox = 1;
  const data = utf8ToB64(JSON.stringify(params));
  return json(200, { ok: true, saved, data, signature: await liqpaySign(data, env.LIQPAY_PRIVATE_KEY), amount: calc.total }, h);
}

async function liqpayCallback(request, env) {
  if (!env.LIQPAY_PRIVATE_KEY) return json(503, { ok: false });
  const form = new URLSearchParams(await request.text());
  const data = form.get('data') || '', signature = form.get('signature') || '';
  if (!data || !safeEqual(await liqpaySign(data, env.LIQPAY_PRIVATE_KEY), signature)) { console.warn('LiqPay: bad signature'); return json(403, { ok: false }); }
  let p; try { p = JSON.parse(b64ToUtf8(data)); } catch (e) { return json(400, { ok: false }); }
  console.log('LiqPay', p.order_id, p.status, p.amount);
  if (p.status === 'success' || p.status === 'sandbox') {
    await telegram(env, `✅ Оплачено LiqPay\nЗамовлення: ${p.order_id}\nСума: ${p.amount} ${p.currency}${p.status === 'sandbox' ? '\n(тестовий платіж)' : ''}`);
  } else if (['failure', 'error', 'reversed'].includes(p.status)) {
    await telegram(env, `⚠️ LiqPay: ${p.status}\nЗамовлення: ${p.order_id}\n${p.err_description || ''}`);
  }
  return json(200, { ok: true });
}

async function monoWebhook(request, env) {
  if (!env.MONO_TOKEN) return json(503, { ok: false });
  const body = await request.text();
  const sig = request.headers.get('X-Sign');
  let ok = false;
  try { ok = !!sig && await monoVerify(env, body, sig); } catch (e) { console.error('mono verify', e); }
  if (!ok) { console.warn('mono: bad signature'); return json(403, { ok: false }); }
  let p; try { p = JSON.parse(body); } catch (e) { return json(400, { ok: false }); }
  console.log('mono', p.reference, p.status, p.amount, p.modifiedDate);
  if (p.status === 'success') {
    await telegram(env, `✅ Оплачено monopay\nЗамовлення: ${p.reference}\nСума: ${(p.finalAmount || p.amount) / 100} ₴`);
  } else if (p.status === 'failure' || p.status === 'reversed') {
    await telegram(env, `⚠️ monopay: ${p.status}\nЗамовлення: ${p.reference}\n${p.failureReason || ''}`);
  }
  return json(200, { ok: true });
}

async function lead(request, env, h) {
  let b; try { b = await request.json(); } catch (e) { return json(400, { ok: false }, h); }
  const phone = String(b.phone || '').replace(/[^\d+]/g, '');
  if (!/^(\+?38)?0\d{9}$/.test(phone)) return json(400, { ok: false, error: 'Невірний номер' }, h);
  let text;
  if (b.topic === 'size') {
    const color = COLORS[b.color], size = SIZES[b.size];
    text = `📏 Консультація щодо розміру\n👤 ${clip(b.name, 60) || 'без імені'}\n📞 ${clip(b.phone, 30)}`
      + (color ? `\n🎨 Дивився: ${color}${size ? `, ${size.name} ${size.dims}` : ''}` : '')
      + (b.comment ? `\n💬 ${clip(b.comment, 500)}` : '');
  } else {
    text = `🛏 Допомогти обрати ковдру\n👤 ${clip(b.name, 60) || 'без імені'}\n📞 ${clip(b.phone, 30)}`;
  }
  const sent = await telegram(env, text);
  return sent ? json(200, { ok: true }, h) : json(502, { ok: false, error: 'Telegram недоступний' }, h);
}

const NP_ALLOWED = {
  getCities: ['FindByString', 'Limit', 'Page'],
  searchSettlements: ['CityName', 'Limit', 'Page'],
  searchSettlementStreets: ['StreetName', 'SettlementRef', 'Limit'],
  getWarehouses: ['CityRef', 'SettlementRef', 'FindByString', 'Limit', 'Page', 'TypeOfWarehouseRef'],
  getStreet: ['CityRef', 'FindByString', 'Limit', 'Page']
};

/* ---------- Укрпошта: відділення за містом або за індексом (адресний класифікатор, потрібен UP_TOKEN) ---------- */
const UP_BASE = 'https://www.ukrposhta.ua/address-classifier-ws/';
async function upGet(env, path) {
  const r = await fetch(UP_BASE + path, { headers: { Authorization: 'Bearer ' + env.UP_TOKEN, Accept: 'application/json' } });
  if (!r.ok) throw new Error('ukrposhta ' + r.status);
  const j = await r.json().catch(() => ({}));
  const e = j && j.Entries && j.Entries.Entry; return Array.isArray(e) ? e : e ? [e] : [];
}
const upOffice = o => ({ index: String(o.POSTCODE || o.POSTINDEX || ''), name: o.POSTOFFICE_UA || o.PO_LONG || '',
  address: [o.CITY_UA || o.CITY_UA_VPZ, o.STREET_UA_VPZ || o.STREET_UA, o.HOUSENUMBER].filter(Boolean).join(', ') || o.POSTOFFICE_UA || '' });
async function ukrposhta(request, env, h) {
  if (!env.UP_TOKEN) return json(503, { ok: false, error: 'Укрпошту ще не налаштовано' }, h);
  let b; try { b = await request.json(); } catch (e) { return json(400, { ok: false }, h); }
  try {
    if (b.index) {
      if (!/^\d{5}$/.test(String(b.index))) return json(400, { ok: false, error: 'Невірний індекс' }, h);
      const list = await upGet(env, 'get_postoffices_by_postindex?pi=' + b.index);
      return json(200, { ok: true, data: list.filter(o => String(o.LOCK_CODE || '0') === '0').map(upOffice) }, h);
    }
    const city = String(b.city || '').trim().slice(0, 60), area = String(b.area || '').trim().slice(0, 60);
    if (city.length < 2) return json(400, { ok: false, error: 'Місто?' }, h);
    let regionId = '';
    if (area) { const reg = await upGet(env, 'get_regions_by_region_ua?region_name=' + encodeURIComponent(area)); if (reg[0]) regionId = reg[0].REGION_ID; }
    const cities = await upGet(env, 'get_city_by_region_id_and_district_id_and_city_ua?' + (regionId ? 'region_id=' + regionId + '&' : '') + 'city_ua=' + encodeURIComponent(city));
    const c = cities.find(x => (x.CITY_UA || '').toLowerCase() === city.toLowerCase()) || cities[0];
    if (!c) return json(200, { ok: true, data: [] }, h);
    const offices = await upGet(env, 'get_postoffices_by_postcode_cityid_cityvpzid?city_id=' + c.CITY_ID);
    return json(200, { ok: true, data: offices.filter(o => String(o.LOCK_CODE || '0') === '0').map(upOffice).sort((a, b) => a.index.localeCompare(b.index)).slice(0, 80) }, h);
  } catch (err) { console.error('up', err.message); return json(502, { ok: false, error: 'Укрпошта недоступна' }, h); }
}
async function novaPoshta(request, env, h) {
  let req; try { req = await request.json(); } catch (e) { return json(400, { ok: false }, h); }
  const allowed = NP_ALLOWED[req.method];
  if (!allowed) return json(400, { ok: false, error: 'Unknown method' }, h);
  const props = {};
  for (const k of allowed) { const v = req.props && req.props[k]; if (v !== undefined && v !== '') props[k] = String(v).slice(0, 80); }
  const r = await fetch('https://api.novaposhta.ua/v2.0/json/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: env.NP_API_KEY || '', modelName: 'Address', calledMethod: req.method, methodProperties: props })
  });
  const j = await r.json().catch(() => ({}));
  if (!j.success) return json(502, { ok: false, error: (j.errors || []).join('; ') || 'NP error' }, h);
  const data = (j.data || []).map(d => req.method === 'getCities'
    ? { Ref: d.Ref, Description: d.Description, AreaDescription: d.AreaDescription }
    : { Ref: d.Ref, Description: d.Description });
  return json(200, { ok: true, data }, h);
}

export default {
  async fetch(request, env) {
    const h = cors(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/') return json(200, { ok: true, service: 'dushes-pay' }, h);
    if (request.method !== 'POST') return json(405, { ok: false }, h);
    try {
      switch (pathname) {
        case '/pay-mono': return await payMono(request, env, h);
        case '/pay-liqpay': return await payLiqpay(request, env, h);
        case '/np': return await novaPoshta(request, env, h);
        case '/up': return await ukrposhta(request, env, h);
        case '/lead': return await lead(request, env, h);
        case '/mono-webhook': return await monoWebhook(request, env);
        case '/liqpay-callback': return await liqpayCallback(request, env);
        default: return json(404, { ok: false }, h);
      }
    } catch (e) {
      console.error(pathname, e);
      return json(e.status || 400, { ok: false, error: e.message || 'Error' }, h);
    }
  }
};
