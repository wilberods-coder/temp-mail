// Мини-сервер без зависимостей:
//  - отдаёт public/
//  - проксирует /api/* на api.mail.tm (браузер не может ходить туда напрямую — CORS разрешён только для mail.tm)
//  - /svc/* — создание ящиков со сроком жизни и вход; просроченные ящики сервер удаляет сам
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 5190;
const HOST = process.env.HOST || '127.0.0.1';
const UPSTREAM = 'https://api.mail.tm';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'boxes.json');
const MAX_BODY = 64 * 1024;
const SWEEP_MS = 30 * 1000;

const MIN = 60 * 1000;
const LIFETIMES = {
  '15m': 15 * MIN,
  '1h': 60 * MIN,
  '12h': 12 * 60 * MIN,
  '24h': 24 * 60 * MIN,
  '7d': 7 * 24 * 60 * MIN,
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Заголовки, которые передаём в обе стороны
const REQ_HEADERS = ['accept', 'authorization', 'content-type'];
const RES_HEADERS = ['content-type', 'content-disposition', 'ratelimit-policy', 'retry-after'];

// ---------- хранилище ящиков: { [id]: { id, address, password, expiresAt } } ----------
let records = {};
try { records = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch {}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(records, null, 1));
  fs.renameSync(tmp, STORE_FILE);
}

// ---------- helpers ----------
const httpError = (status, message) => Object.assign(new Error(message), { status });

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(httpError(413, 'Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  try { return JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
  catch (e) { throw e.status ? e : httpError(400, 'Некорректный JSON'); }
}

function randomString(len, alphabet) {
  return Array.from(crypto.randomBytes(len), b => alphabet[b % alphabet.length]).join('');
}

function randomLogin() {
  const syll = ['ka', 'lo', 'mi', 'ra', 'ne', 'to', 'vi', 'sa', 'du', 'pe', 'zo', 'ri', 'ma', 'ko', 'li'];
  return Array.from(crypto.randomBytes(3), b => syll[b % syll.length]).join('') + randomString(4, '0123456789');
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

let domainCache = { list: [], at: 0 };
async function getDomains() {
  if (Date.now() - domainCache.at < 10 * MIN && domainCache.list.length) return domainCache.list;
  const r = await mailtm('/domains');
  if (!r.ok) throw httpError(502, 'mail.tm недоступен');
  const items = Array.isArray(r.data) ? r.data : (r.data?.['hydra:member'] || []);
  domainCache = { list: items.filter(d => d.isActive && !d.isPrivate).map(d => d.domain), at: Date.now() };
  return domainCache.list;
}

async function createBox({ lifetime, login, domain }) {
  const ttl = LIFETIMES[lifetime];
  if (!ttl) throw httpError(400, 'Неизвестный срок жизни');
  const domains = await getDomains();
  if (!domains.length) throw httpError(502, 'Нет доступных доменов');
  if (domain && !domains.includes(domain)) throw httpError(400, 'Домен недоступен');
  if (login && !/^[a-z0-9._-]{3,32}$/.test(login)) throw httpError(400, 'Логин: 3–32 символа, латиница, цифры, . _ -');

  const address = (login || randomLogin()) + '@' + (domain || domains[crypto.randomInt(domains.length)]);
  const password = randomString(14, 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789');
  const acc = await mailtm('/accounts', { method: 'POST', body: { address, password } });
  if (acc.status === 422) throw httpError(422, 'Этот адрес уже занят');
  if (!acc.ok) throw httpError(502, 'mail.tm: ошибка ' + acc.status);
  const tok = await mailtm('/token', { method: 'POST', body: { address, password } });
  if (!tok.ok) throw httpError(502, 'mail.tm: не удалось войти');

  const rec = { id: acc.data.id, address: acc.data.address, password, expiresAt: Date.now() + ttl };
  records[rec.id] = rec;
  persist();
  return { ...rec, token: tok.data.token };
}

async function loginBox({ address, password }) {
  address = String(address || '').trim().toLowerCase();
  if (!address || !password) throw httpError(400, 'Введите адрес и пароль');
  const tok = await mailtm('/token', { method: 'POST', body: { address, password: String(password) } });
  if (tok.status === 401) throw httpError(401, 'Неверный адрес или пароль');
  if (!tok.ok) throw httpError(502, 'mail.tm: ошибка ' + tok.status);
  const rec = records[tok.data.id];
  if (rec && rec.expiresAt <= Date.now()) throw httpError(410, 'Срок жизни ящика истёк');
  // Ящики, созданные не через этот сервис, срока не имеют
  return { id: tok.data.id, address, password, token: tok.data.token, expiresAt: rec ? rec.expiresAt : null };
}

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  let changed = false;
  try {
    for (const rec of Object.values(records)) {
      if (rec.expiresAt > Date.now()) continue;
      try {
        const tok = await mailtm('/token', { method: 'POST', body: { address: rec.address, password: rec.password } });
        if (tok.ok) {
          const del = await mailtm('/accounts/' + rec.id, { method: 'DELETE', token: tok.data.token });
          if (!del.ok && del.status !== 404) continue; // попробуем в следующий раз
        } else if (tok.status !== 401) {
          continue;
        }
        delete records[rec.id];
        changed = true;
        console.log('Удалён просроченный ящик', rec.address);
      } catch (e) {
        console.error('sweep', rec.address, e.message);
      }
    }
  } finally {
    if (changed) persist();
    sweeping = false;
  }
}

// ---------- routes ----------
async function handleSvc(req, res) {
  if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
  const body = await readJson(req);
  if (req.url === '/svc/boxes') {
    return sendJson(res, 201, await createBox({
      lifetime: body.lifetime,
      login: body.login ? String(body.login).trim().toLowerCase() : '',
      domain: body.domain ? String(body.domain) : '',
    }));
  }
  if (req.url === '/svc/login') return sendJson(res, 200, await loginBox(body));
  if (req.url === '/svc/forget') {
    // Ящик удалён пользователем вручную — больше не отслеживаем
    const rec = records[body.id];
    if (rec && rec.password === body.password) { delete records[body.id]; persist(); }
    return sendJson(res, 200, { ok: true });
  }
  throw httpError(404, 'Not found');
}

async function proxy(req, res) {
  const target = UPSTREAM + req.url.slice('/api'.length);
  const headers = {};
  for (const h of REQ_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];

  const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
  const body = hasBody ? await readBody(req) : undefined;
  if (req.method === 'PATCH') headers['content-type'] = 'application/merge-patch+json';

  const upstream = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
  const out = { 'cache-control': 'no-store' };
  for (const h of RES_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(upstream.status, out);
  if (upstream.body) {
    for await (const chunk of upstream.body) res.write(chunk);
  }
  res.end();
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/svc/')) await handleSvc(req, res);
    else if (req.url === '/api' || req.url.startsWith('/api/')) await proxy(req, res);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res);
    else res.writeHead(405).end();
  } catch (e) {
    if (!e.status) console.error(req.method, req.url, e.message);
    if (!res.headersSent) sendJson(res, e.status || 502, { detail: e.status ? e.message : 'Ошибка связи с mail.tm' });
    else res.end();
  }
}).listen(PORT, HOST, () => {
  console.log(`Временная почта: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

sweep();
setInterval(sweep, SWEEP_MS);
