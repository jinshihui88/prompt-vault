/**
 * Prompt Vault - storage layer
 *
 * Design notes:
 * - Single JSON file + atomic write (tmp -> rename). Prompt count is in the
 *   hundreds, so JSON is sufficient and keeps the runtime dependency-free.
 * - The MCP server and the web manager run as SEPARATE processes and both
 *   write. An in-process mutex is therefore not enough: every mutation takes
 *   an exclusive lock file, re-reads from disk, applies the change, writes
 *   back atomically, then releases. This prevents lost updates.
 * - All data stays on this machine. No network calls anywhere in this file.
 */

import {
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const BASE_DIR =
  process.env.PROMPT_VAULT_DIR || path.join(os.homedir(), '.workbuddy', 'prompt-vault', 'data');
const DATA_FILE = path.join(BASE_DIR, 'prompts.json');
const LOCK_FILE = `${DATA_FILE}.lock`;

const LOCK_TIMEOUT_MS = 6000;
const LOCK_STALE_MS = 15000;

const LIMITS = {
  title: 120,
  content: 20000,
  description: 300,
  tag: 24,
  tags: 12,
};

function ensureDir() {
  if (!existsSync(BASE_DIR)) mkdirSync(BASE_DIR, { recursive: true });
}

function emptyDb() {
  return { version: 1, updatedAt: new Date().toISOString(), prompts: [] };
}

function readDb() {
  ensureDir();
  if (!existsSync(DATA_FILE)) return emptyDb();
  const raw = readFileSync(DATA_FILE, 'utf8');
  if (!raw.trim()) return emptyDb();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never destroy user data on a parse error: park the broken file and start clean.
    const parked = `${DATA_FILE}.corrupt-${Date.now()}`;
    try {
      renameSync(DATA_FILE, parked);
    } catch {
      /* ignore */
    }
    return emptyDb();
  }
  if (!parsed || !Array.isArray(parsed.prompts)) return emptyDb();
  return parsed;
}

function writeDb(db) {
  ensureDir();
  const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify({ ...db, updatedAt: new Date().toISOString() }, null, 2);
  writeFileSync(tmp, payload, 'utf8');
  renameSync(tmp, DATA_FILE);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Cross-process exclusive lock with stale-lock recovery. */
async function withLock(fn) {
  ensureDir();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = -1;

  for (;;) {
    try {
      fd = openSync(LOCK_FILE, 'wx');
      writeSync(fd, `${process.pid}`);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Reclaim a lock left behind by a crashed process.
      try {
        const st = statSync(LOCK_FILE);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) unlinkSync(LOCK_FILE);
      } catch {
        /* lock vanished between stat and unlink - just retry */
      }
      if (Date.now() > deadline) {
        throw new Error(`prompt-vault: timed out waiting for lock (${LOCK_FILE})`);
      }
      await sleep(20 + Math.floor(Math.random() * 40));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      if (fd !== -1) closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      /* ignore */
    }
  }
}

function clampText(value, max) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeTags(input) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,，\s]+/)
      : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const tag = String(item ?? '').trim().slice(0, LIMITS.tag);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}

function normalizeInput(input = {}) {
  const title = clampText(String(input.title ?? '').trim(), LIMITS.title);
  const content = clampText(String(input.content ?? ''), LIMITS.content);
  const description = clampText(String(input.description ?? '').trim(), LIMITS.description);
  const tags = normalizeTags(input.tags);
  if (!title) throw new Error('title is required');
  if (!content.trim()) throw new Error('content is required');
  return { title, content, description, tags };
}

function preview(text, len = 140) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > len ? `${flat.slice(0, len)}…` : flat;
}

function toSummary(p) {
  return {
    id: p.id,
    title: p.title,
    description: p.description || '',
    tags: p.tags || [],
    preview: preview(p.content),
    length: (p.content || '').length,
    usageCount: p.usageCount || 0,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** AND-match across whitespace-separated terms; case-insensitive; works for CJK. */
function matchesQuery(prompt, q) {
  const terms = String(q || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return true;
  const haystack = [prompt.title, prompt.content, prompt.description, (prompt.tags || []).join(' ')]
    .join(' ')
    .toLowerCase();
  return terms.every(t => haystack.includes(t));
}

function matchesTag(prompt, tag) {
  if (!tag) return true;
  const key = String(tag).trim().toLowerCase();
  return (prompt.tags || []).some(t => t.toLowerCase() === key);
}

export async function listPrompts({ tag = '', q = '', limit = 100 } = {}) {
  const db = readDb();
  const items = db.prompts
    .filter(p => matchesTag(p, tag) && matchesQuery(p, q))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)))
    .map(toSummary);
  return { total: items.length, items };
}

export function getPrompt(idOrTitle, { touch = false } = {}) {
  const db = readDb();
  const key = String(idOrTitle ?? '').trim();
  if (!key) return null;
  const lower = key.toLowerCase();
  const found =
    db.prompts.find(p => p.id === key) ||
    db.prompts.find(p => String(p.title).toLowerCase() === lower) ||
    db.prompts.find(p => String(p.title).toLowerCase().includes(lower));
  if (!found) return null;
  if (touch) {
    // Usage counting is best-effort and must not block a read.
    void bumpUsage(found.id).catch(() => {});
  }
  return { ...found };
}

async function bumpUsage(id) {
  await withLock(async () => {
    const db = readDb();
    const target = db.prompts.find(p => p.id === id);
    if (!target) return;
    target.usageCount = (target.usageCount || 0) + 1;
    target.lastUsedAt = new Date().toISOString();
    writeDb(db);
  });
}

export async function createPrompt(input) {
  const clean = normalizeInput(input);
  return withLock(async () => {
    const db = readDb();
    const now = new Date().toISOString();
    // Idempotent-ish guard: reject exact duplicate title+content instead of piling up copies.
    const dup = db.prompts.find(
      p => p.title.toLowerCase() === clean.title.toLowerCase() && p.content === clean.content,
    );
    if (dup) throw new Error(`identical prompt already exists: ${dup.id}`);

    const record = {
      id: randomUUID(),
      ...clean,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    db.prompts.push(record);
    writeDb(db);
    return { ...record };
  });
}

export async function updatePrompt(id, patch = {}) {
  const key = String(id ?? '').trim();
  if (!key) throw new Error('id is required');
  return withLock(async () => {
    const db = readDb();
    const target = db.prompts.find(p => p.id === key);
    if (!target) throw new Error(`prompt not found: ${key}`);

    const merged = {
      title: patch.title !== undefined ? patch.title : target.title,
      content: patch.content !== undefined ? patch.content : target.content,
      description: patch.description !== undefined ? patch.description : target.description,
      tags: patch.tags !== undefined ? patch.tags : target.tags,
    };
    const clean = normalizeInput(merged);
    Object.assign(target, clean, { updatedAt: new Date().toISOString() });
    writeDb(db);
    return { ...target };
  });
}

export async function deletePrompt(id) {
  const key = String(id ?? '').trim();
  if (!key) throw new Error('id is required');
  return withLock(async () => {
    const db = readDb();
    const idx = db.prompts.findIndex(p => p.id === key);
    if (idx === -1) throw new Error(`prompt not found: ${key}`);
    const [removed] = db.prompts.splice(idx, 1);
    writeDb(db);
    return { deleted: true, id: removed.id, title: removed.title };
  });
}

export function listTags() {
  const db = readDb();
  const counter = new Map();
  for (const p of db.prompts) {
    for (const tag of p.tags || []) {
      const key = tag.toLowerCase();
      const entry = counter.get(key);
      if (entry) entry.count += 1;
      else counter.set(key, { tag, count: 1 });
    }
  }
  const items = [...counter.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return { total: items.length, items };
}

export function stats() {
  const db = readDb();
  return {
    count: db.prompts.length,
    tags: listTags().total,
    updatedAt: db.updatedAt,
    dataFile: DATA_FILE,
  };
}

export const paths = { BASE_DIR, DATA_FILE, LOCK_FILE };
