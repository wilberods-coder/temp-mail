// Cloudflare Worker — бэкенд для версии сайта на GitHub Pages.
//  - проксирует /api/* на api.mail.tm (браузер не может ходить туда напрямую — CORS разрешён только для mail.tm)
//  - /svc/* — создание ящиков со сроком жизни (или навсегда) и вход в ящик
//  - /auth/* — аккаунты: имя пользователя и пароль или Google; ящики привязываются к аккаунту
//  - по cron раз в минуту удаляет просроченные ящики (сроки хранятся в D1)
const UPSTREAM = 'https://api.mail.tm';
const MIN = 60 * 1000;
const LIFETIMES = {
  '15m': 15 * MIN,
  '1h': 60 * MIN,
  '12h': 12 * 60 * MIN,
  '24h': 24 * 60 * MIN,
  '7d': 7 * 24 * 60 * MIN,
  forever: null, // только для аккаунтов
};
const SESSION_TTL = 30 * 24 * 60 * MIN;
// Больше 100 000 итераций PBKDF2 Workers не поддерживают
const PBKDF2_ITERATIONS = 100000;
// На бесплатном тарифе у одного запуска Worker'а не больше 50 исходящих запросов
const SWEEP_BATCH = 20;
const IMPORT_LIMIT = 10;

const REQ_HEADERS = ['accept', 'authorization', 'content-type'];
const RES_HEADERS = ['content-type', 'content-disposition', 'ratelimit-policy', 'retry-after'];

// ---------- helpers ----------
const httpError = (status, message) => Object.assign(new Error(message), { status });
const enc = new TextEncoder();

const json = (status, data) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function readJson(req) {
  try { return await req.json(); }
  catch { throw httpError(400, 'Некорректный JSON'); }
}

const toHex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const fromHex = hex => new Uint8Array((hex.match(/../g) || []).map(h => parseInt(h, 16)));
const randomHex = bytes => toHex(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256 = async str => toHex(await crypto.subtle.digest('SHA-256', enc.encode(str)));

function b64urlBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - s.length % 4) % 4);
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

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
    'access-control-allow-headers': 'Accept, Authorization, Content-Type, X-Session',
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

// ---------- аккаунты ----------
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${await pbkdf2(password, salt, PBKDF2_ITERATIONS)}`;
}

async function verifyPassword(password, stored) {
  const [alg, iterations, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2' || !hash) return false;
  const got = await pbkdf2(password, fromHex(salt), Number(iterations));
  let diff = got.length ^ hash.length;
  for (let i = 0; i < Math.min(got.length, hash.length); i++) diff |= got.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

const publicUser = u => ({
  id: u.id,
  username: u.username,
  name: u.name || u.username,
  email: u.email,
  picture: u.picture,
  provider: u.google_sub ? 'google' : 'password',
});

async function createSession(env, userId) {
  const token = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, Date.now() + SESSION_TTL).run();
  return token;
}

async function currentUser(req, env) {
  const token = req.headers.get('x-session');
  if (!token) return null;
  return env.DB.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
  ).bind(await sha256(token), Date.now()).first();
}

function validateCredentials(body) {
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw httpError(400, 'Имя пользователя: 3–32 символа, латиница, цифры, . _ -');
  if (password.length < 6 || password.length > 128) throw httpError(400, 'Пароль: от 6 до 128 символов');
  return { username, password };
}

async function attachBox(env, userId, box) {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO user_boxes (user_id, box_id, address, password, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(userId, box.id, box.address, box.password, box.expiresAt, Date.now()).run();
}

async function userBoxes(env, userId) {
  const { results } = await env.DB.prepare(
    'SELECT box_id AS id, address, password, expires_at AS expiresAt FROM user_boxes WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC',
  ).bind(userId, Date.now()).all();
  return results;
}

// ---------- Google ----------
let googleKeys = { keys: [], at: 0 };

async function googleKey(kid) {
  let key = googleKeys.keys.find(k => k.kid === kid);
  if (!key || Date.now() - googleKeys.at > 60 * MIN) {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    if (!res.ok) throw httpError(502, 'Google недоступен');
    googleKeys = { keys: (await res.json()).keys || [], at: Date.now() };
    key = googleKeys.keys.find(k => k.kid === kid);
  }
  return key;
}

// Проверка ID-токена Google Identity Services: подпись RS256, аудитория, издатель, срок
async function verifyGoogleToken(credential, clientId) {
  const parts = String(credential || '').split('.');
  if (parts.length !== 3) throw httpError(400, 'Некорректный токен Google');
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); }
  catch { throw httpError(400, 'Некорректный токен Google'); }
  if (header.alg !== 'RS256') throw httpError(401, 'Некорректный токен Google');
  const jwk = await googleKey(header.kid);
  if (!jwk) throw httpError(401, 'Некорректный токен Google');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!valid) throw httpError(401, 'Некорректный токен Google');
  if (payload.aud !== clientId) throw httpError(401, 'Токен выдан другому приложению');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) throw httpError(401, 'Некорректный токен Google');
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw httpError(401, 'Токен Google истёк, войдите ещё раз');
  return payload;
}

// ---------- ящики ----------
async function createBox(env, user, { lifetime, login, domain }) {
  if (!(lifetime in LIFETIMES)) throw httpError(400, 'Неизвестный срок жизни');
  if (lifetime === 'forever' && !user) throw httpError(401, 'Почта навсегда доступна только с аккаунтом');
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

  const ttl = LIFETIMES[lifetime];
  const box = { id: acc.data.id, address: acc.data.address, password, expiresAt: ttl ? Date.now() + ttl : null };
  if (ttl) {
    await env.DB.prepare('INSERT OR REPLACE INTO boxes (id, address, password, expires_at) VALUES (?, ?, ?, ?)')
      .bind(box.id, box.address, box.password, box.expiresAt).run();
  }
  if (user) await attachBox(env, user.id, box);
  return { ...box, token: tok.data.token };
}

async function loginBox(env, user, { address, password }) {
  address = String(address || '').trim().toLowerCase();
  if (!address || !password) throw httpError(400, 'Введите адрес и пароль');
  const tok = await mailtm('/token', { method: 'POST', body: { address, password: String(password) } });
  if (tok.status === 401) throw httpError(401, 'Неверный адрес или пароль');
  if (!tok.ok) throw httpError(502, 'mail.tm: ошибка ' + tok.status);
  const rec = await env.DB.prepare('SELECT expires_at FROM boxes WHERE id = ?').bind(tok.data.id).first();
  if (rec && rec.expires_at <= Date.now()) throw httpError(410, 'Срок жизни ящика истёк');
  // Ящики без записи в boxes — вечные или созданные не через этот сервис
  const box = { id: tok.data.id, address, password: String(password), expiresAt: rec ? rec.expires_at : null };
  if (user) await attachBox(env, user.id, box);
  return { ...box, token: tok.data.token };
}

async function sweep(env) {
  const now = Date.now();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
  const { results } = await env.DB.prepare('SELECT id, address, password FROM boxes WHERE expires_at <= ? ORDER BY expires_at LIMIT ?')
    .bind(now, SWEEP_BATCH).all();
  for (const rec of results) {
    try {
      const tok = await mailtm('/token', { method: 'POST', body: { address: rec.address, password: rec.password }, retry: false });
      if (tok.ok) {
        const del = await mailtm('/accounts/' + rec.id, { method: 'DELETE', token: tok.data.token, retry: false });
        if (!del.ok && del.status !== 404) continue; // попробуем в следующий раз
      } else if (tok.status !== 401) {
        continue;
      }
      await env.DB.batch([
        env.DB.prepare('DELETE FROM boxes WHERE id = ?').bind(rec.id),
        env.DB.prepare('DELETE FROM user_boxes WHERE box_id = ?').bind(rec.id),
      ]);
      console.log('Удалён просроченный ящик', rec.address);
    } catch (e) {
      console.error('sweep', rec.address, e.message);
      if (e.status === 429) break;
    }
  }
}

// ---------- routes ----------
const boxParams = body => ({
  lifetime: body.lifetime,
  login: body.login ? String(body.login).trim().toLowerCase() : '',
  domain: body.domain ? String(body.domain) : '',
});

async function requireUser(req, env) {
  const user = await currentUser(req, env);
  if (!user) throw httpError(401, 'Войдите в аккаунт');
  return user;
}

const ROUTES = {
  'GET /svc/info': (req, env) => json(200, {
    accounts: true,
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    lifetimes: Object.keys(LIFETIMES),
  }),

  'POST /svc/boxes': async (req, env, body) => json(201, await createBox(env, await currentUser(req, env), boxParams(body))),

  'POST /svc/login': async (req, env, body) => json(200, await loginBox(env, await currentUser(req, env), body)),

  'POST /svc/forget': async (req, env, body) => {
    // Ящик удалён пользователем вручную — больше не отслеживаем
    const id = String(body.id), password = String(body.password);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM boxes WHERE id = ? AND password = ?').bind(id, password),
      env.DB.prepare('DELETE FROM user_boxes WHERE box_id = ? AND password = ?').bind(id, password),
    ]);
    return json(200, { ok: true });
  },

  'POST /auth/register': async (req, env, body) => {
    const { username, password } = validateCredentials(body);
    const id = randomHex(16);
    try {
      await env.DB.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .bind(id, username, await hashPassword(password), Date.now()).run();
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) throw httpError(409, 'Это имя пользователя уже занято');
      throw e;
    }
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    return json(201, { token: await createSession(env, id), user: publicUser(user) });
  },

  'POST /auth/login': async (req, env, body) => {
    const username = String(body.username || '').trim().toLowerCase();
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    if (!user || !(await verifyPassword(String(body.password || ''), user.password_hash))) {
      throw httpError(401, 'Неверное имя пользователя или пароль');
    }
    return json(200, { token: await createSession(env, user.id), user: publicUser(user) });
  },

  'POST /auth/google': async (req, env, body) => {
    if (!env.GOOGLE_CLIENT_ID) throw httpError(404, 'Вход через Google не настроен');
    const g = await verifyGoogleToken(body.credential, env.GOOGLE_CLIENT_ID);
    let user = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(g.sub).first();
    if (user) {
      await env.DB.prepare('UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?')
        .bind(g.email || null, g.name || null, g.picture || null, user.id).run();
    } else {
      await env.DB.prepare('INSERT INTO users (id, google_sub, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(randomHex(16), g.sub, g.email || null, g.name || null, g.picture || null, Date.now()).run();
    }
    user = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(g.sub).first();
    return json(200, { token: await createSession(env, user.id), user: publicUser(user) });
  },

  'POST /auth/logout': async (req, env) => {
    const token = req.headers.get('x-session');
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return json(200, { ok: true });
  },

  'GET /auth/me': async (req, env) => {
    const user = await requireUser(req, env);
    return json(200, { user: publicUser(user), boxes: await userBoxes(env, user.id) });
  },

  'POST /auth/boxes/remove': async (req, env, body) => {
    const user = await requireUser(req, env);
    await env.DB.prepare('DELETE FROM user_boxes WHERE user_id = ? AND box_id = ?').bind(user.id, String(body.id)).run();
    return json(200, { ok: true });
  },

  // Ящики, созданные на устройстве до входа, переносятся в аккаунт (пароль проверяется через mail.tm)
  'POST /auth/boxes/import': async (req, env, body) => {
    const user = await requireUser(req, env);
    const list = Array.isArray(body.boxes) ? body.boxes.slice(0, IMPORT_LIMIT) : [];
    for (const b of list) {
      try { await loginBox(env, user, b); } catch {}
    }
    return json(200, { boxes: await userBoxes(env, user.id) });
  },
};

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
      const route = ROUTES[`${req.method} ${url.pathname}`];
      if (route) res = await route(req, env, req.method === 'POST' ? await readJson(req) : null);
      else if (url.pathname === '/api' || url.pathname.startsWith('/api/')) res = await proxy(req, url);
      else res = json(404, { detail: 'Not found' });
    } catch (e) {
      if (!e.status) console.error(req.method, url.pathname, e.message);
      res = json(e.status || 502, { detail: e.status ? e.message : 'Ошибка сервера' });
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env));
  },
};
