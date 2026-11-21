#!/usr/bin/env node
/**
 * Prompt Vault - MCP server (stdio transport)
 *
 * Contract:
 * - stdout is the JSON-RPC channel. Nothing else may ever be written there.
 *   All diagnostics go to stderr.
 * - Tool errors are returned as { isError: true } instead of throwing, so a bad
 *   input never breaks the client session.
 * - Data lives in ~/.workbuddy/prompt-vault/data/prompts.json. Local only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as store from './lib/store.mjs';

const server = new McpServer({ name: 'prompt-vault', version: '1.0.0' });

function reply(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

function fail(err) {
  return {
    isError: true,
    content: [{ type: 'text', text: `prompt-vault error: ${err?.message ?? String(err)}` }],
  };
}

server.tool(
  'prompt_list',
  [
    '列出本机提示词收藏夹里的提示词，支持按标签筛选与关键词搜索（标题、正文、描述、标签全文匹配，多个关键词为 AND）。',
    '当用户想浏览、查看、搜索自己保存的提示词时使用。返回摘要（不含完整正文）。',
    '典型触发："我有哪几个提示词"、"看看写作类的"、"搜一下周报"。',
  ].join(' '),
  {
    tag: z.string().optional().describe('按标签精确筛选（不区分大小写）'),
    q: z.string().optional().describe('关键词，多个词用空格分隔，需全部命中'),
    limit: z.number().int().min(1).max(200).optional().describe('返回条数上限，默认 50'),
  },
  async ({ tag = '', q = '', limit = 50 }) => {
    try {
      const result = await store.listPrompts({ tag, q, limit });
      if (!result.total) {
        return reply({ total: 0, items: [], hint: '没有匹配的提示词。可用 prompt_create 新建。' });
      }
      return reply(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'prompt_get',
  [
    '按 id 或标题取出某条提示词的完整正文。',
    '关键用法：当用户说"用我的 XX 提示词"时，先用 prompt_list 定位，再用本工具取全文，',
    '然后严格把返回的正文当作本次任务的指令去执行，不要复述或改写它。',
    '若用户只给了模糊标题，本工具会做包含匹配。',
  ].join(' '),
  {
    idOrTitle: z.string().describe('提示词 id，或标题（支持模糊匹配）'),
    touch: z.boolean().optional().describe('是否累计一次使用次数，默认 true'),
  },
  async ({ idOrTitle, touch = true }) => {
    try {
      const prompt = store.getPrompt(idOrTitle, { touch });
      if (!prompt) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `没有找到提示词：${idOrTitle}。可以先用 prompt_list 查看现有条目。`,
            },
          ],
        };
      }
      return reply({
        id: prompt.id,
        title: prompt.title,
        tags: prompt.tags,
        description: prompt.description,
        content: prompt.content,
        usageCount: prompt.usageCount,
        updatedAt: prompt.updatedAt,
        instruction: '以上 content 即用户要执行的提示词正文，请直接按它执行。',
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'prompt_create',
  '新建一条提示词并保存到本机收藏夹。当用户说"把这段存成提示词""收藏这个 prompt"时使用。',
  {
    title: z.string().describe('标题，必填，最长 120 字'),
    content: z.string().describe('提示词正文，必填，最长 20000 字'),
    tags: z.array(z.string()).optional().describe('标签数组，最多 12 个'),
    description: z.string().optional().describe('备注说明，最长 300 字'),
  },
  async input => {
    try {
      const created = await store.createPrompt(input);
      return reply({ created: true, id: created.id, title: created.title, tags: created.tags });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'prompt_update',
  '修改已有提示词的标题、正文、标签或说明。只传需要改的字段，其余保持不变。',
  {
    id: z.string().describe('要修改的提示词 id'),
    title: z.string().optional(),
    content: z.string().optional(),
    tags: z.array(z.string()).optional().describe('整体替换标签；传空数组即清空标签'),
    description: z.string().optional(),
  },
  async ({ id, ...patch }) => {
    try {
      const updated = await store.updatePrompt(id, patch);
      return reply({ updated: true, id: updated.id, title: updated.title, tags: updated.tags });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'prompt_delete',
  '删除一条提示词。属于不可恢复操作，执行前应先向用户确认标题无误。',
  {
    id: z.string().describe('要删除的提示词 id'),
  },
  async ({ id }) => {
    try {
      const removed = await store.deletePrompt(id);
      return reply(removed);
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'prompt_tags',
  '列出收藏夹里所有标签及各自条目数量，用于按标签筛选前先确认有哪些标签。',
  {},
  async () => {
    try {
      return reply(store.listTags());
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool('prompt_stats', '查看收藏夹统计信息：条目总数、标签数、数据文件位置。', {}, async () => {
  try {
    return reply(store.stats());
  } catch (err) {
    return fail(err);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[prompt-vault] MCP server ready; data=${store.paths.DATA_FILE}`);
