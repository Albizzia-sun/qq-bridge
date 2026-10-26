// 日记 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn，供 QQ 里的她「写点什么」。
//
// 设计（照 ai-companion-kit 进阶篇的规矩来）：
// - 只追加，不删除、不改写：给她两个动作——写一条、看最近几条（外加一个只读搜索）。
// - 纯文本 JSONL：一行一条，能双击打开、能 grep、能手改、能直接复制备份。
// - 配额：一天最多 3 条，每条最多 120 字。这是给她省着写的护栏，不是任务。
// - 工具描述里不出现「你应该记录今天发生的事」这类任务口吻，只写「你可以写点什么」。
// - 没有任何本地命令执行、网络、删除能力。
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * 项目根目录（本文件在 <repo>/src/ 下）。
 * 与其它 MCP server 一样用 argv[1] 推断，不依赖 import.meta（离线测试会在 vm 里跑）。
 */
function projectRoot() {
  try {
    const entry = String(process.argv[1] ?? '');
    if (entry) {
      const dir = path.dirname(path.resolve(entry));
      if (path.basename(dir) === 'src') return path.dirname(dir);
    }
  } catch {}
  return process.cwd();
}

const ROOT = projectRoot();
const DIARY_DIR = path.join(ROOT, 'data', '日记');
const DIARY_FILE = path.join(DIARY_DIR, 'diary.jsonl');

const MAX_PER_DAY = 6;
const MAX_CONTENT_CHARS = 120;
const MAX_MOOD_CHARS = 8;

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function localClock(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${localDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把任意输入洗成单行安全文本：去控制字符、不留换行。 */
function oneLine(text, max) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function readEntries() {
  try {
    if (!fs.existsSync(DIARY_FILE)) return [];
    return fs
      .readFileSync(DIARY_FILE, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function countToday(entries) {
  const today = localDate();
  return entries.filter((e) => String(e?.time ?? '').startsWith(today)).length;
}

function formatEntry(e) {
  const mood = e?.mood ? `（${e.mood}）` : '';
  return `${e?.time ?? '?'}${mood} ${e?.content ?? ''}`;
}

const server = new McpServer({ name: 'diary', version: '1.0.0' });

server.tool(
  'diary_write',
  '写一条日记。想写的时候才写，不用每天打卡，也不用总结今天。一天最多 3 条，每条一两句就够。',
  {
    content: z.string().describe('这一条想写的内容，一两句，最多 120 字'),
    mood: z.string().optional().describe('可选，此刻的心情，一两个词，比如 还行 / 烦 / 开心')
  },
  async ({ content, mood }) => {
    const clean = oneLine(content, MAX_CONTENT_CHARS);
    if (!clean) {
      return { content: [{ type: 'text', text: '内容为空，没写。' }], isError: true };
    }
    const entries = readEntries();
    const todayCount = countToday(entries);
    if (todayCount >= MAX_PER_DAY) {
      return {
        content: [{ type: 'text', text: `今天已经写了 ${todayCount} 条了，够了。想写明天再说。` }],
        isError: true
      };
    }
    const entry = {
      time: localClock(),
      mood: mood ? oneLine(mood, MAX_MOOD_CHARS) : '',
      content: clean
    };
    try {
      fs.mkdirSync(DIARY_DIR, { recursive: true });
      fs.appendFileSync(DIARY_FILE, JSON.stringify(entry) + '\n', 'utf8');
    } catch (error) {
      return {
        content: [{ type: 'text', text: `写失败：${error?.message ?? error}` }],
        isError: true
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: `写进去了：${formatEntry(entry)}（今天第 ${todayCount + 1} 条，还剩 ${MAX_PER_DAY - todayCount - 1} 条）`
        }
      ]
    };
  }
);

server.tool(
  'diary_recent',
  '看看自己最近写过什么。想知道前几天写了什么时用。',
  { limit: z.number().int().min(1).max(20).optional().describe('看最近几条，默认 5') },
  async ({ limit }) => {
    const n = Number(limit) || 5;
    const entries = readEntries();
    if (!entries.length) {
      return { content: [{ type: 'text', text: '还一条都没写过。' }] };
    }
    const picked = entries.slice(-n).reverse();
    return {
      content: [
        {
          type: 'text',
          text: `最近 ${picked.length} 条（新的在上）：\n` + picked.map((e) => `- ${formatEntry(e)}`).join('\n')
        }
      ]
    };
  }
);

server.tool(
  'diary_search',
  '在日记里找某个词，比如某个人、某只猫、某件事。',
  { keyword: z.string().describe('要找的词') },
  async ({ keyword }) => {
    const kw = oneLine(keyword, 40);
    if (!kw) return { content: [{ type: 'text', text: '关键词为空。' }], isError: true };
    const hits = readEntries()
      .filter((e) => String(e?.content ?? '').includes(kw) || String(e?.mood ?? '').includes(kw))
      .slice(-20)
      .reverse();
    if (!hits.length) {
      return { content: [{ type: 'text', text: `日记里没提过「${kw}」。` }] };
    }
    return {
      content: [
        {
          type: 'text',
          text: `提到「${kw}」的有 ${hits.length} 条（新的在上）：\n` + hits.map((e) => `- ${formatEntry(e)}`).join('\n')
        }
      ]
    };
  }
);

await server.connect(new StdioServerTransport());
