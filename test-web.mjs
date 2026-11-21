/**
 * Web manager tests: spawns the real HTTP server against a throwaway data dir
 * and exercises every endpoint plus the write-protection rules.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sandbox = mkdtempSync(path.join(tmpdir(), 'prompt-vault-web-'));
const PORT = 7811;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fails.push(`${name}${detail ? ` -> ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const child = spawn(process.execPath, ['web/serve.mjs'], {
  cwd: path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'),
  env: { ...process.env, PROMPT_VAULT_DIR: sandbox, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not start in time')), 12000);
  child.stdout.on('data', d => {
    out += String(d);
    if (out.includes('已启动')) { clearTimeout(timer); resolve(); }
  });
  child.stderr.on('data', d => { out += String(d); });
  child.on('exit', code => reject(new Error(`server exited early (${code}): ${out}`)));
});

const J = { 'content-type': 'application/json' };

try {
  await ready;
  console.log(`server up on ${PORT}\nsandbox: ${sandbox}\n`);

  console.log('[1] static page');
  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  ok('GET / returns 200', page.status === 200);
  ok('serves html content-type', String(page.headers.get('content-type')).includes('text/html'));
  ok('page has search input', html.includes('id="search"'));
  ok('page has modal', html.includes('id="modal"'));
  ok('page has copy logic', html.includes('navigator.clipboard'));
  ok('page has tag filter container', html.includes('id="tags"'));

  console.log('\n[2] create / read');
  const cr = await fetch(`${BASE}/api/prompts`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ title: 'Web 测试', content: '第一段正文', tags: ['a', 'b'], description: '备注' }),
  });
  const created = await cr.json();
  ok('POST returns 201', cr.status === 201, String(cr.status));
  ok('created has id', !!created.id);

  const list1 = await (await fetch(`${BASE}/api/prompts`)).json();
  ok('list shows 1', list1.total === 1, JSON.stringify(list1.total));

  const one = await (await fetch(`${BASE}/api/prompts/${created.id}`)).json();
  ok('get by id returns full content', one.content === '第一段正文');

  console.log('\n[3] search / tag / tags endpoint');
  const qHit = await (await fetch(`${BASE}/api/prompts?q=${encodeURIComponent('正文')}`)).json();
  ok('search param works', qHit.total === 1);
  const qMiss = await (await fetch(`${BASE}/api/prompts?q=${encodeURIComponent('zzz无')}`)).json();
  ok('search miss returns 0', qMiss.total === 0);
  const tagHit = await (await fetch(`${BASE}/api/prompts?tag=a`)).json();
  ok('tag param works', tagHit.total === 1);
  const tags = await (await fetch(`${BASE}/api/tags`)).json();
  ok('tags endpoint counts 2', tags.total === 2, JSON.stringify(tags));
  const stats = await (await fetch(`${BASE}/api/stats`)).json();
  ok('stats count 1', stats.count === 1);

  console.log('\n[4] update / delete');
  const up = await fetch(`${BASE}/api/prompts/${created.id}`, {
    method: 'PUT', headers: J,
    body: JSON.stringify({ title: 'Web 测试改', tags: ['c'] }),
  });
  const updated = await up.json();
  ok('PUT returns 200', up.status === 200);
  ok('title updated', updated.title === 'Web 测试改');
  ok('tags replaced', updated.tags.length === 1 && updated.tags[0] === 'c');
  ok('content preserved', updated.content === '第一段正文');

  const del = await fetch(`${BASE}/api/prompts/${created.id}`, { method: 'DELETE', headers: J });
  ok('DELETE returns 200', del.status === 200);
  const list2 = await (await fetch(`${BASE}/api/prompts`)).json();
  ok('list empty after delete', list2.total === 0);

  console.log('\n[5] error handling');
  const notFound = await fetch(`${BASE}/api/prompts/does-not-exist`);
  ok('unknown id returns 404', notFound.status === 404);
  const badCreate = await fetch(`${BASE}/api/prompts`, {
    method: 'POST', headers: J, body: JSON.stringify({ title: '', content: 'x' }),
  });
  ok('validation failure returns 400', badCreate.status === 400, String(badCreate.status));
  const badJson = await fetch(`${BASE}/api/prompts`, {
    method: 'POST', headers: J, body: '{not json',
  });
  ok('malformed JSON returns 400', badJson.status === 400, String(badJson.status));

  console.log('\n[6] write protection');
  const wrongType = await fetch(`${BASE}/api/prompts`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'title=x',
  });
  ok('non-JSON content-type rejected (415)', wrongType.status === 415, String(wrongType.status));

  const crossOrigin = await fetch(`${BASE}/api/prompts`, {
    method: 'POST',
    headers: { ...J, origin: 'https://evil.example.com' },
    body: JSON.stringify({ title: 'csrf', content: 'x' }),
  });
  ok('foreign Origin rejected (403)', crossOrigin.status === 403, String(crossOrigin.status));

  const sameOrigin = await fetch(`${BASE}/api/prompts`, {
    method: 'POST',
    headers: { ...J, origin: BASE },
    body: JSON.stringify({ title: '同源可写', content: 'x' }),
  });
  ok('same-origin write allowed (201)', sameOrigin.status === 201, String(sameOrigin.status));

  console.log('\n[7] bound to loopback only');
  ok('server log mentions 127.0.0.1', out.includes('127.0.0.1'), out.slice(0, 120));
} catch (err) {
  fails.push(`unexpected: ${err.message}`);
  console.log(`  FAIL  unexpected: ${err.message}`);
} finally {
  child.kill();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(52)}`);
console.log(`PASS ${pass}   FAIL ${fails.length}`);
if (fails.length) { console.log('\nFailures:'); for (const f of fails) console.log(`  - ${f}`); }
process.exit(fails.length ? 1 : 0);
