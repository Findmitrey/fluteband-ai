// FluteBand AI — dev-сервер без зависимостей: отдаёт app/ и подсказывает адрес для телефона.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(here, '..', 'app');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.xml': 'application/xml; charset=utf-8',
  '.musicxml': 'application/vnd.recordare.musicxml+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const args = process.argv.slice(2);
const wantHttps = args.includes('--https');
const portArg = args.find((a) => a.startsWith('--port='));
const PORT = Number(portArg ? portArg.split('=')[1] : process.env.PORT || 3030);
// Куда проксировать /api/*: заглушка или боевой OMR-сервис. OMR_URL=off отключает прокси.
const OMR_URL = (process.env.OMR_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '');

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

async function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const target = normalize(join(ROOT, clean === '/' ? '/index.html' : clean));
  if (!target.startsWith(ROOT)) return null;
  try {
    const info = await stat(target);
    if (info.isDirectory()) return resolveFile(join(clean, 'index.html'));
    return target;
  } catch {
    return null;
  }
}

/** Прокси к OMR-сервису: браузер всегда обращается к своему origin (/api/*) */
async function proxyApi(req, res, path) {
  if (!OMR_URL || OMR_URL === 'off') {
    res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: 'OMR-сервис не подключён',
      hint: 'Запустите: python server/standalone.py, затем перезапустите dev-сервер (переменная OMR_URL)',
    }));
    return;
  }
  const target = `${OMR_URL}${path.replace(/^\/api/, '')}`;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream' },
      body,
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'content-length': buffer.length,
    });
    res.end(buffer);
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: 'OMR-сервис недоступен',
      hint: `Запустите сервис распознавания (${OMR_URL}) или задайте OMR_URL`,
      detail: error.message,
    }));
  }
}

const handler = async (req, res) => {
  const path = req.url || '/';
  if (path.startsWith('/api/')) {
    await proxyApi(req, res, path);
    return;
  }
  const file = await resolveFile(path);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 — не найдено');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`500 — ${error.message}`);
  }
};

if (wantHttps) {
  const certDir = join(here, 'certs');
  const keyPath = join(certDir, 'key.pem');
  const certPath = join(certDir, 'cert.pem');
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    console.log('\nHTTPS недоступен: нет сертификатов.');
    console.log('Камера на телефоне требует защищённый контекст. Варианты без оплаты:');
    console.log('  1) Откройте приложение на компьютере (localhost — уже защищённый контекст).');
    console.log('  2) Сгенерируйте самоподписанный сертификат в tools/certs/ (key.pem, cert.pem).');
    console.log('  3) Используйте бесплатный туннель (например, cloudflared) и откройте HTTPS-ссылку на телефоне.\n');
    process.exit(1);
  }
  const { createServer: createHttps } = await import('node:https');
  const server = createHttps({ key: await readFile(keyPath), cert: await readFile(certPath) }, handler);
  server.listen(PORT, '0.0.0.0', () => printUrls('https'));
} else {
  createServer(handler).listen(PORT, '0.0.0.0', () => printUrls('http'));
}

function printUrls(scheme) {
  console.log(`\nFluteBand AI — dev-сервер запущен (${scheme})`);
  console.log(`  Компьютер:   ${scheme}://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Телефон:     ${scheme}://${ip}:${PORT}   (та же Wi-Fi сеть)`);
  if (scheme === 'http') {
    console.log('  Внимание: камера работает только в защищённом контексте (localhost или https).');
    console.log('  На компьютере доступ к камере будет, по LAN-адресу на телефоне — нужен HTTPS.');
  }
  console.log('  Остановить: Ctrl+C\n');
}