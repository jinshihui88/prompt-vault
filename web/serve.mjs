/**
 * Prompt Vault - local web manager
 *
 * Binds to 127.0.0.1 only: the vault is never reachable from the network.
 * Writes require JSON content-type and a same-origin Origin when present,
 * which keeps a random website from mutating your prompts via the browser.
 */

import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../lib/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_PORT = Number(process.env.PORT || 7788);
const MAX_BODY = 1024 * 1024;
const OPEN_BROWSER = process.argv.includes('--open');
const MAX_PORT_TRIES = 12;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

function originAllowed(req, port) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (curl / scripts)
  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` ||
    origin === `http://[::1]:${port}`
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const port = server.address()?.port ?? BASE_PORT;
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  const { pathname, searchParams } = url;
  const method = req.method || 'GET';

  try {
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = await readFile(path.join(HERE, 'index.html'), 'utf8');
      return sendText(res, 200, html, 'text/html; charset=utf-8');
    }

    if (pathname.startsWith('/api/')) {
      if (method !== 'GET') {
        if (!originAllowed(req, port)) return sendJson(res, 403, { error: 'origin not allowed' });
        const type = String(req.headers['content-type'] || '');
        if (!type.includes('application/json')) {
          return sendJson(res, 415, { error: 'content-type must be application/json' });
        }
      }

      if (method === 'GET' && pathname === '/api/prompts') {
        const result = await store.listPrompts({
          tag: searchParams.get('tag') || '',
          q: searchParams.get('q') || '',
          limit: Number(searchParams.get('limit') || 200),
        });
        return sendJson(res, 200, result);
      }

      if (method === 'GET' && pathname === '/api/tags') {
        return sendJson(res, 200, store.listTags());
      }

      if (method === 'GET' && pathname === '/api/stats') {
        return sendJson(res, 200, store.stats());
      }

      if (method === 'GET' && pathname === '/api/config') {
        return sendJson(res, 200, { port });
      }

      const byId = pathname.match(/^\/api\/prompts\/([^/]+)$/);

      if (method === 'POST' && pathname === '/api/prompts') {
        const body = await readBody(req);
        const created = await store.createPrompt(body);
        return sendJson(res, 201, created);
      }

      if (method === 'GET' && byId) {
        const prompt = store.getPrompt(decodeURIComponent(byId[1]), { touch: false });
        if (!prompt) return sendJson(res, 404, { error: 'prompt not found' });
        return sendJson(res, 200, prompt);
      }

      if (method === 'PUT' && byId) {
        const body = await readBody(req);
        const updated = await store.updatePrompt(decodeURIComponent(byId[1]), body);
        return sendJson(res, 200, updated);
      }

      if (method === 'DELETE' && byId) {
        const removed = await store.deletePrompt(decodeURIComponent(byId[1]));
        return sendJson(res, 200, removed);
      }

      return sendJson(res, 404, { error: 'unknown endpoint' });
    }

    return sendText(res, 404, 'not found');
  } catch (err) {
    const message = err?.message || 'internal error';
    const status = /not found/i.test(message) ? 404 : /required|invalid|exists/i.test(message) ? 400 : 500;
    if (status === 500) console.error('[prompt-vault web]', err);
    return sendJson(res, status, { error: message });
  }
});

function openBrowser(port) {
  const target = `http://127.0.0.1:${port}`;
  if (!OPEN_BROWSER) {
    console.log(`页面地址: ${target}`);
    return;
  }
  // The empty argument after `start` stops cmd from treating the URL as a window title.
  execFile('cmd', ['/c', 'start', '', target], { windowsHide: true }, err => {
    if (err) console.error(`[prompt-vault web] 打开浏览器失败: ${err.message}`);
  });
}

/** Uses net, not HTTP, so proxy env vars (HTTP_PROXY) can never make this lie. */
function isPortFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/** True when whatever already listens on this port is a prompt-vault instance of ours. */
async function isExistingVault(port) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    const res = await fetch(`http://127.0.0.1:${port}/api/stats`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json();
    return typeof data?.dataFile === 'string' && data.dataFile.includes('prompt-vault');
  } catch {
    return false;
  }
}

async function main() {
  let port = BASE_PORT;
  for (let attempt = 0; attempt < MAX_PORT_TRIES; attempt += 1, port += 1) {
    if (await isPortFree(port)) {
      server.once('error', err => {
        console.error('[prompt-vault web] 启动失败:', err.message);
        process.exit(1);
      });
      server.listen(port, '127.0.0.1', () => {
        const actual = server.address().port;
        console.log(`Prompt Vault 已启动: http://127.0.0.1:${actual}`);
        console.log(`数据文件: ${store.paths.DATA_FILE}`);
        console.log('按 Ctrl+C 停止');
        if (OPEN_BROWSER) openBrowser(actual);
      });
      return;
    }

    if (await isExistingVault(port)) {
      console.log(`Prompt Vault 已在运行: http://127.0.0.1:${port}（未重复启动）`);
      openBrowser(port);
      return;
    }

    console.error(`[prompt-vault web] 端口 ${port} 被其他程序占用，尝试 ${port + 1}`);
  }
  console.error(`[prompt-vault web] ${BASE_PORT} 起连续 ${MAX_PORT_TRIES} 个端口都被占用，启动失败`);
  process.exit(1);
}

main();
