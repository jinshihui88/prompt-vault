/**
 * Storage layer tests. Runs against a throwaway directory so real user data is
 * never touched. Run: node test.mjs
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sandbox = mkdtempSync(path.join(tmpdir(), 'prompt-vault-test-'));
process.env.PROMPT_VAULT_DIR = sandbox;

const store = await import('./lib/store.mjs');

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

async function expectThrow(name, fn) {
  try {
    await fn();
    ok(name, false, 'expected a throw, got success');
  } catch {
    ok(name, true);
  }
}

console.log(`sandbox: ${sandbox}\n`);

console.log('[1] create / list / get');
const a = await store.createPrompt({
  title: '周报生成',
  content: '请根据本周提交记录生成周报，包含：完成事项、风险、下周计划。语气简洁。',
  tags: ['周报', '汇报'],
  description: '每周五用',
});
ok('create returns uuid', /^[0-9a-f-]{36}$/.test(a.id));
ok('tags normalized', a.tags.length === 2 && a.tags[0] === '周报');

const b = await store.createPrompt({
  title: 'Code Review 清单',
  content: 'Review 时依次检查：异常处理、边界条件、并发安全、SQL 注入、日志脱敏。',
  tags: ['代码', 'review'],
});

let listed = await store.listPrompts();
ok('list returns 2', listed.total === 2, `got ${listed.total}`);
ok('summary has preview, no full content', 'preview' in listed.items[0] && !('content' in listed.items[0]));

ok('get by id', store.getPrompt(a.id)?.title === '周报生成');
ok('get by exact title', store.getPrompt('周报生成')?.id === a.id);
ok('get by fuzzy title', store.getPrompt('code review')?.id === b.id);
ok('get missing returns null', store.getPrompt('不存在的提示词xyz') === null);

console.log('\n[2] search / tags / filter');
ok('search CJK term', (await store.listPrompts({ q: '周报' })).total === 1);
ok('search case-insensitive', (await store.listPrompts({ q: 'REVIEW' })).total === 1);
ok('search covers content', (await store.listPrompts({ q: 'SQL 注入' })).total === 1);
ok('search AND semantics', (await store.listPrompts({ q: '周报 汇报' })).total === 1);
ok('search AND rejects partial', (await store.listPrompts({ q: '周报 注入' })).total === 0);
ok('tag filter', (await store.listPrompts({ tag: '代码' })).total === 1);
ok('tag filter case-insensitive', (await store.listPrompts({ tag: 'REVIEW' })).total === 1);

const tags = store.listTags();
ok('listTags counts', tags.total === 4, `got ${tags.total}`);
ok('listTags sorted by count desc', tags.items[0].count >= tags.items[tags.items.length - 1].count);

console.log('\n[3] update / delete');
const upd = await store.updatePrompt(b.id, { tags: ['代码'], title: 'CR 清单' });
ok('update title', upd.title === 'CR 清单');
ok('update tags replaces', upd.tags.length === 1 && upd.tags[0] === '代码');
ok('update keeps content', upd.content.includes('SQL 注入'));
ok('update bumps updatedAt', upd.updatedAt >= upd.createdAt);
await expectThrow('update missing id throws', () => store.updatePrompt('nope', { title: 'x' }));

const del = await store.deletePrompt(a.id);
ok('delete returns title', del.deleted === true && del.title === '周报生成');
ok('list after delete', (await store.listPrompts()).total === 1);
await expectThrow('delete twice throws', () => store.deletePrompt(a.id));

console.log('\n[4] validation');
await expectThrow('empty title throws', () => store.createPrompt({ title: '  ', content: 'x' }));
await expectThrow('empty content throws', () => store.createPrompt({ title: 'x', content: '   ' }));
await expectThrow(
  'duplicate title+content throws',
  () => store.createPrompt({ title: 'CR 清单', content: upd.content }),
);
const longTitle = await store.createPrompt({ title: 'T'.repeat(300), content: 'c' });
ok('title clamped to 120', longTitle.title.length === 120, `got ${longTitle.title.length}`);
const manyTags = await store.createPrompt({
  title: '多标签',
  content: 'x',
  tags: Array.from({ length: 30 }, (_, i) => `tag${i}`),
});
ok('tags capped at 12', manyTags.tags.length === 12);
const dedup = await store.createPrompt({ title: '去重标签', content: 'y', tags: ['A', 'a', ' B '] });
ok('tags dedup case-insensitive', dedup.tags.length === 2, JSON.stringify(dedup.tags));

console.log('\n[5] concurrency (10 parallel writes must not lose data)');
const before = (await store.listPrompts()).total;
await Promise.all(
  Array.from({ length: 10 }, (_, i) =>
    store.createPrompt({ title: `并发${i}`, content: `内容${i}`, tags: ['并发'] }),
  ),
);
const after = (await store.listPrompts()).total;
ok('all 10 concurrent writes persisted', after === before + 10, `before=${before} after=${after}`);

console.log('\n[6] file integrity');
const rawFile = path.join(sandbox, 'prompts.json');
ok('data file exists', existsSync(rawFile));
ok('data file is valid JSON', (() => {
  try {
    JSON.parse(readFileSync(rawFile, 'utf8'));
    return true;
  } catch {
    return false;
  }
})());
ok('no lock file left behind', !existsSync(`${rawFile}.lock`));

console.log(`\n${'='.repeat(52)}`);
console.log(`PASS ${pass}   FAIL ${fails.length}`);
if (fails.length) {
  console.log('\nFailures:');
  for (const f of fails) console.log(`  - ${f}`);
}
console.log(`data file: ${rawFile}`);
rmSync(sandbox, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
