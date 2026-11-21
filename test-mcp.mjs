/**
 * MCP protocol-level test.
 *
 * Spawns server.mjs exactly the way WorkBuddy does (stdio child process) and
 * drives a real JSON-RPC session: initialize -> tools/list -> tools/call.
 * This proves the server is protocol-correct, not just that the functions work.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sandbox = mkdtempSync(path.join(tmpdir(), 'prompt-vault-mcp-'));
let pass = 0;
const fails = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fails.push(`${name}${detail ? ` -> ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'),
  env: { ...process.env, PROMPT_VAULT_DIR: sandbox },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
let nextId = 1;
const pending = new Map();
const stderrChunks = [];

child.stderr.on('data', d => stderrChunks.push(String(d)));

child.stdout.on('data', chunk => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log(`  [non-JSON on stdout] ${line.slice(0, 200)}`);
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function rpc(method, params, timeoutMs = 15000) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method };
  if (params !== undefined) payload.params = params;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}

function notify(method, params) {
  const payload = { jsonrpc: '2.0', method };
  if (params !== undefined) payload.params = params;
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function textOf(res) {
  const content = res?.result?.content;
  if (!Array.isArray(content)) return '';
  return content.map(c => c.text ?? '').join('\n');
}

function parsePayload(res) {
  try {
    return JSON.parse(textOf(res));
  } catch {
    return null;
  }
}

console.log(`sandbox: ${sandbox}\n`);

try {
  console.log('[1] initialize handshake');
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'prompt-vault-selftest', version: '1.0.0' },
  });
  ok('initialize returns result', !!init.result, JSON.stringify(init).slice(0, 200));
  ok('server name is prompt-vault', init.result?.serverInfo?.name === 'prompt-vault', JSON.stringify(init.result?.serverInfo));
  ok('declares tools capability', !!init.result?.capabilities?.tools);
  notify('notifications/initialized');

  console.log('\n[2] tools/list');
  const list = await rpc('tools/list');
  const tools = list.result?.tools ?? [];
  const names = tools.map(t => t.name).sort();
  const expected = [
    'prompt_create',
    'prompt_delete',
    'prompt_get',
    'prompt_list',
    'prompt_stats',
    'prompt_tags',
    'prompt_update',
  ];
  ok('7 tools exposed', tools.length === 7, `got ${tools.length}: ${names.join(',')}`);
  ok('all expected tools present', expected.every(n => names.includes(n)), names.join(','));
  ok('every tool has description', tools.every(t => (t.description || '').length > 10));
  ok('every tool has inputSchema', tools.every(t => t.inputSchema?.type === 'object'));

  console.log('\n[3] tools/call - create');
  const created = await rpc('tools/call', {
    name: 'prompt_create',
    arguments: {
      title: 'MCP 冒烟测试',
      content: '这是通过 MCP 协议创建的提示词，用于验证端到端链路。',
      tags: ['测试', 'mcp'],
      description: '自动化测试写入',
    },
  });
  const createPayload = parsePayload(created);
  ok('create not an error', !created.result?.isError, textOf(created).slice(0, 200));
  ok('create returns id', !!createPayload?.id);
  const createdId = createPayload?.id;

  console.log('\n[4] tools/call - list / search / tag');
  const all = parsePayload(await rpc('tools/call', { name: 'prompt_list', arguments: {} }));
  ok('list shows 1 item', all?.total === 1, JSON.stringify(all?.total));
  const byQ = parsePayload(await rpc('tools/call', { name: 'prompt_list', arguments: { q: '端到端' } }));
  ok('search by CJK content term', byQ?.total === 1);
  const byTag = parsePayload(await rpc('tools/call', { name: 'prompt_list', arguments: { tag: '测试' } }));
  ok('filter by tag', byTag?.total === 1);
  const noHit = parsePayload(await rpc('tools/call', { name: 'prompt_list', arguments: { q: '绝不存在zzz' } }));
  ok('no-match returns empty set', noHit?.total === 0);

  console.log('\n[5] tools/call - get returns full content');
  const got = parsePayload(await rpc('tools/call', { name: 'prompt_get', arguments: { idOrTitle: createdId } }));
  ok('get returns full content', got?.content?.includes('端到端链路'), got?.content?.slice(0, 80));
  ok('get carries execution instruction', typeof got?.instruction === 'string');
  const gotByTitle = parsePayload(await rpc('tools/call', { name: 'prompt_get', arguments: { idOrTitle: 'MCP 冒烟' } }));
  ok('get by fuzzy title', gotByTitle?.id === createdId);

  console.log('\n[6] tools/call - update / tags / stats');
  const upd = parsePayload(
    await rpc('tools/call', {
      name: 'prompt_update',
      arguments: { id: createdId, tags: ['测试'], title: 'MCP 冒烟测试(改)' },
    }),
  );
  ok('update title', upd?.title === 'MCP 冒烟测试(改)', JSON.stringify(upd));
  const tags = parsePayload(await rpc('tools/call', { name: 'prompt_tags', arguments: {} }));
  ok('tags reflects single tag after update', tags?.total === 1, JSON.stringify(tags));
  const stats = parsePayload(await rpc('tools/call', { name: 'prompt_stats', arguments: {} }));
  ok('stats count is 1', stats?.count === 1, JSON.stringify(stats));
  ok('stats points into sandbox', String(stats?.dataFile).includes('prompt-vault-mcp-'));

  console.log('\n[7] error paths stay protocol-safe');
  const missing = await rpc('tools/call', { name: 'prompt_get', arguments: { idOrTitle: '不存在xyz' } });
  ok('missing prompt returns isError', missing.result?.isError === true);
  ok('missing prompt has readable message', textOf(missing).includes('没有找到'));
  const badCreate = await rpc('tools/call', {
    name: 'prompt_create',
    arguments: { title: '', content: 'x' },
  });
  ok('validation error returns isError', badCreate.result?.isError === true);
  const stillAlive = parsePayload(await rpc('tools/call', { name: 'prompt_stats', arguments: {} }));
  ok('server still responsive after errors', stillAlive?.count === 1);

  console.log('\n[8] tools/call - delete');
  const del = parsePayload(await rpc('tools/call', { name: 'prompt_delete', arguments: { id: createdId } }));
  ok('delete reports success', del?.deleted === true, JSON.stringify(del));
  const afterDel = parsePayload(await rpc('tools/call', { name: 'prompt_list', arguments: {} }));
  ok('list empty after delete', afterDel?.total === 0);

  console.log('\n[9] stdout purity');
  ok('no stray stdout writes (only JSON-RPC parsed)', !buffer.trim(), `leftover=${buffer.slice(0, 120)}`);
  ok('stderr carried diagnostics', stderrChunks.join('').includes('[prompt-vault]'));
} catch (err) {
  fails.push(`unexpected: ${err.message}`);
  console.log(`  FAIL  unexpected: ${err.message}`);
} finally {
  child.stdin.end();
  child.kill();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(52)}`);
console.log(`PASS ${pass}   FAIL ${fails.length}`);
if (fails.length) {
  console.log('\nFailures:');
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(fails.length ? 1 : 0);
