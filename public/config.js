// Адрес бэкенда. Пусто — тот же сервер, что отдал страницу (server.js).
// На GitHub Pages своего сервера нет, поэтому там используется Cloudflare Worker из папки worker/.
window.TEMPMAIL_BACKEND = location.hostname.endsWith('github.io')
  ? 'https://temp-mail.wilberods.workers.dev'
  : '';
