// Cloudflare Worker — бэкенд для версии сайта на GitHub Pages.
// Делает то же, что server.js:
//  - проксирует /api/* на api.mail.tm (браузер не может ходить туда напрямую — CORS разрешён только для mail.tm)
//  - /svc/* — создание ящиков со сроком жизни и вход
//  - по cron раз в минуту удаляет просроченные ящики (сроки хранятся в D1)
const UPSTREAM = 'https://api.mail.tm';
const MIN = 60 * 1000;
const LIFETIMES = {
  '15m': 15 * MIN,
  '1h': 60 * MIN,
  '12h': 12 * 60 * MIN,
  '24h': 24 * 60 * MIN,
  '7d': 7 * 24 * 60 * MIN,
};
// На бесплатном тарифе у одного запуска Worker'а не больше 50 исходящих запросов
const SWEEP_BATCH = 20;

const REQ_HEADERS = ['accept', 'authorization', 'content-type'];
const RES_HEADERS = ['content-type', 'content-disposition', 'ratelimit-policy', 'retry-after'];

// ---------- helpers ----------
const httpError = (status, message) => Object.assign(new Error(message), { status });

const json = (status, data) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function readJson(req) {
  try { return await req.json(); }
  catch { throw httpError(400, 'Некорректный JSON'); }
}

function randomString(len, alphabet) {
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), b => alphabet[b % alphabet.length]).join('');
}

function randomLogin() {
  const syll = ['ka', 'lo', 'mi', 'ra', 'ne', 'to', 'vi', 'sa', 'du', 'pe', 'zo', 'ri', 'ma', 'ko', 'li'];
  return Array.from(crypto.getRandomValues(new Uint8Array(3)), b => syll[b % syll.length]).join('') + randomString(4, '0123456789');
}

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return { vary: 'Origin' };
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'Accept, Authorization, Content-Type',
    'access-control-expose-headers': 'Content-Disposition',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

// ---------- mail.tm ----------
async function mailtm(pathname, { method = 'GET', body, token, retry = true } = {}) {
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(UPSTREAM + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 429) {
    if (retry) { await new Promise(r => setTimeout(r, 1500)); return mailtm(pathname, { method, body, token, retry: false }); }
    throw httpError(429, 'Слишком много запросов к mail.tm, попробуйте через минуту');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, ok: res.ok, data };
}

async function getDomains() {
  const r = await mailtm('/domains');
  if (!r.ok) throw httpError(502, 'mail.tm недоступен');
  const items = Array.isArray(r.data) ? r.data : (r.data?.['hydra:member'] || []);
  return items.filter(d => d.isActive && !d.isPrivate).map(d => d.domain);
}

async function createBox(env, { lifetime, login, domain }) {
  const ttl = LIFETIMES[lifetime];
  if (!ttl) throw httpError(400, 'Неизвестный срок жизни');
  const domains = await getDomains();
  if (!domains.length) throw httpError(502, 'Нет доступных доменов');
  if (domain && !domains.includes(domain)) throw httpError(400, 'Домен недоступен');
  if (login && !/^[a-z0-9._-]{3,32}$/.test(login)) throw httpError(400, 'Логин: 3–32 символа, латиница, цифры, . _ -');

  const pick = crypto.getRandomValues(new Uint32Array(1))[0] % domains.length;
  const address = (login || randomLogin()) + '@' + (domain || domains[pick]);
  const password = randomString(14, 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789');
  const acc = await mailtm('/accounts', { method: 'POST', body: { address, password } });
  if (acc.status === 422) throw httpError(422, 'Этот адрес уже занят');
  if (!acc.ok) throw httpError(502, 'mail.tm: ошибка ' + acc.status);
  const tok = await mailtm('/token', { method: 'POST', body: { address, password } });
  if (!tok.ok) throw httpError(502, 'mail.tm: не удалось войти');

  const rec = { id: acc.data.id, address: acc.data.address, password, expiresAt: Date.now() + ttl };
  await env.DB.prepare('INSERT OR REPLACE INTO boxes (id, address, password, expires_at) VALUES (?, ?, ?, ?)')
    .bind(rec.id, rec.address, rec.password, rec.expiresAt).run();
  return { ...rec, token: tok.data.token };
}

async function loginBox(env, { address, password }) {
  address = String(address || '').trim().toLowerCase();
  if (!address || !password) throw httpError(400, 'Введите адрес и пароль');
  const tok = await mailtm('/token', { method: 'POST', body: { address, password: String(password) } });
  if (tok.status === 401) throw httpError(401, 'Неверный адрес или пароль');
  if (!tok.ok) throw httpError(502, 'mail.tm: ошибка ' + tok.status);
  const rec = await env.DB.prepare('SELECT expires_at FROM boxes WHERE id = ?').bind(tok.data.id).first();
  if (rec && rec.expires_at <= Date.now()) throw httpError(410, 'Срок жизни ящика истёк');
  // Ящики, созданные не через этот сервис, срока не имеют
  return { id: tok.data.id, address, password, token: tok.data.token, expiresAt: rec ? rec.expires_at : null };
}

async function sweep(env) {
  const { results } = await env.DB.prepare('SELECT id, address, password FROM boxes WHERE expires_at <= ? ORDER BY expires_at LIMIT ?')
    .bind(Date.now(), SWEEP_BATCH).all();
  for (const rec of results) {
    try {
      const tok = await mailtm('/token', { method: 'POST', body: { address: rec.address, password: rec.password }, retry: false });
      if (tok.ok) {
        const del = await mailtm('/accounts/' + rec.id, { method: 'DELETE', token: tok.data.token, retry: false });
        if (!del.ok && del.status !== 404) continue; // попробуем в следующий раз
      } else if (tok.status !== 401) {
        continue;
      }
      await env.DB.prepare('DELETE FROM boxes WHERE id = ?').bind(rec.id).run();
      console.log('Удалён просроченный ящик', rec.address);
    } catch (e) {
      console.error('sweep', rec.address, e.message);
      if (e.status === 429) break;
    }
  }
}

// ---------- routes ----------
async function handleSvc(req, url, env) {
  if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
  const body = await readJson(req);
  if (url.pathname === '/svc/boxes') {
    return json(201, await createBox(env, {
      lifetime: body.lifetime,
      login: body.login ? String(body.login).trim().toLowerCase() : '',
      domain: body.domain ? String(body.domain) : '',
    }));
  }
  if (url.pathname === '/svc/login') return json(200, await loginBox(env, body));
  if (url.pathname === '/svc/forget') {
    // Ящик удалён пользователем вручную — больше не отслеживаем
    await env.DB.prepare('DELETE FROM boxes WHERE id = ? AND password = ?').bind(String(body.id), String(body.password)).run();
    return json(200, { ok: true });
  }
  throw httpError(404, 'Not found');
}

async function proxy(req, url) {
  const headers = {};
  for (const h of REQ_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
  if (req.method === 'PATCH') headers['content-type'] = 'application/merge-patch+json';
  const upstream = await fetch(UPSTREAM + url.pathname.slice('/api'.length) + url.search, {
    method: req.method,
    headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
    redirect: 'manual',
  });
  const out = new Headers({ 'cache-control': 'no-store' });
  for (const h of RES_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req.headers.get('origin'), env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let res;
    try {
      if (url.pathname.startsWith('/svc/')) res = await handleSvc(req, url, env);
      else if (url.pathname === '/api' || url.pathname.startsWith('/api/')) res = await proxy(req, url);
      else if (url.pathname === '/') res = json(200, { service: 'temp-mail', ok: true });
      else res = json(404, { detail: 'Not found' });
    } catch (e) {
      if (!e.status) console.error(req.method, url.pathname, e.message);
      res = json(e.status || 502, { detail: e.status ? e.message : 'Ошибка связи с mail.tm' });
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env));
  },
};
