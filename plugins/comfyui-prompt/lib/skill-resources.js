/**
 * 技能目录内的只读资源访问。
 *
 * 这些工具只在后台受限 Agent 中注册；路径先做词法检查，再用 realpath
 * 检查符号链接逃逸。脚本类工具不注册、不执行。
 */

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const READ_TOOL = 'read_file';
export const LIST_TOOL = 'list_files';

const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 500;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_RETURN_CHARS = 128 * 1024;
const MAX_RESOURCE_ENTRIES = 200;

/** 列出技能目录下的文件（最多 MAX_RESOURCE_ENTRIES 个），供系统提示词展示与 list_files 使用。 */
export async function listSkillResources(skillDir, { signal } = {}) {
  const base = await realpath(path.resolve(skillDir));
  const files = [];

  async function walk(directory, depth) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true, signal });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= MAX_RESOURCE_ENTRIES) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = relativePath(base, full);
      if (/^skill\.md$/i.test(relative)) continue;
      try {
        files.push({ path: relative, bytes: (await stat(full)).size });
      } catch (error) {
        if (error.name === 'AbortError') throw error;
      }
    }
  }

  await walk(base, 0);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** 按行窗口读取技能目录内的 UTF-8 文本；拒绝二进制、超大文件和目录外路径。 */
export async function readSkillFile(skillDir, { path: requested, offset, limit, signal } = {}) {
  const { base, file } = await resolveInsideSkill(skillDir, requested, signal);
  const info = await stat(file);
  if (signal?.aborted) throw abortError();
  if (!info.isFile()) throw new Error(`${requested} 不是文件`);
  if (info.size > MAX_READ_BYTES) {
    throw new Error(`${requested} 过大（${info.size} 字节），请改用更小的文本文件或分段读取`);
  }

  const buffer = await readFile(file, { signal });
  if (buffer.includes(0)) throw new Error(`${requested} 是二进制文件，不能按文本读取`);

  const start = normalizeOffset(offset);
  const count = normalizeLimit(limit);
  const lines = buffer.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const selected = lines.slice(start - 1, start - 1 + count);
  let truncated = start - 1 + selected.length < lines.length;
  let content = selected.map((line, index) => `${String(start + index).padStart(5)} | ${line}`).join('\n');
  if (content.length > MAX_RETURN_CHARS) {
    content = `${content.slice(0, MAX_RETURN_CHARS)}\n…（已截断）`;
    truncated = true;
  }

  return {
    path: relativePath(base, file),
    offset: start,
    content,
    totalLines: lines.length,
    truncated,
  };
}

/** 构造后台 Agent 使用的只读工具。 */
export function createSkillTools({ skillDir }) {
  const base = path.resolve(skillDir);
  return [createReadTool(base), createListTool(base)];
}

function createReadTool(skillDir) {
  return {
    name: READ_TOOL,
    description:
      'Read a UTF-8 text file bundled with the selected skill. Paths are relative to the skill base directory. '
      + 'Use offset (1-based line) and limit to page through large files.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Path relative to the skill base directory.' },
        offset: { type: 'number', description: '1-based first line; defaults to 1.' },
        limit: { type: 'number', description: `Maximum lines; defaults to ${DEFAULT_READ_LIMIT}, max ${MAX_READ_LIMIT}.` },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          offset: { type: 'number' },
          content: { type: 'string' },
          totalLines: { type: 'number' },
          truncated: { type: 'boolean' },
        },
        required: ['path', 'offset', 'content', 'totalLines', 'truncated'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `File: ${value.path} (starting at line ${value.offset} of ${value.totalLines}${value.truncated ? ', truncated' : ''})\n${value.content}`,
      }],
    },
    async execute(args, exec) {
      return readSkillFile(skillDir, { ...(args ?? {}), signal: exec.signal });
    },
  };
}

function createListTool(skillDir) {
  return {
    name: LIST_TOOL,
    description:
      'List files bundled with the selected skill, with relative paths and byte sizes. '
      + 'Omit path to list the whole skill directory; pass a relative path to inspect one subdirectory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Optional directory relative to the skill base directory.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                bytes: { type: 'number' },
                kind: { type: 'string' },
              },
              required: ['path', 'bytes', 'kind'],
            },
          },
        },
        required: ['path', 'files'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.files.length
          ? value.files.map((file) => `${file.kind === 'dir' ? '[dir]' : '[file]'} ${file.path} (${file.bytes} bytes)`).join('\n')
          : `(${value.path} 下没有可列出的文件)`,
      }],
    },
    async execute(args, exec) {
      const requested = args?.path;
      if (typeof requested === 'string' && requested.trim()) {
        const { base, directory } = await resolveInsideSkill(skillDir, requested, exec.signal);
        const info = await stat(directory);
        if (!info.isDirectory()) throw new Error(`${requested} 不是目录`);
        const entries = await readdir(directory, { withFileTypes: true, signal: exec.signal });
        const files = [];
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          const full = path.join(directory, entry.name);
          let bytes = 0;
          if (entry.isFile()) bytes = (await stat(full)).size;
          else if (!entry.isDirectory()) continue;
          files.push({ path: relativePath(base, full), bytes, kind: entry.isDirectory() ? 'dir' : 'file' });
        }
        return { path: relativePath(base, directory), files };
      }
      const resources = await listSkillResources(skillDir, { signal: exec.signal });
      return {
        path: '.',
        files: resources.map((file) => ({ ...file, kind: 'file' })),
      };
    },
  };
}

async function resolveInsideSkill(skillDir, requested, signal) {
  if (typeof requested !== 'string' || !requested.trim()) throw new Error('必须提供相对技能目录的路径');
  const base = await realpath(path.resolve(skillDir));
  if (signal?.aborted) throw abortError();
  const candidate = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(base, requested);
  if (!isPathInside(base, candidate)) throw new Error('路径越出技能目录');
  let real;
  try {
    real = await realpath(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`文件不存在：${requested}`);
    throw error;
  }
  if (signal?.aborted) throw abortError();
  if (!isPathInside(base, real)) throw new Error('路径通过符号链接越出技能目录');
  return { base, file: real };
}

function isPathInside(base, candidate) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function relativePath(base, file) {
  return path.relative(path.resolve(base), path.resolve(file)).split(path.sep).join('/');
}

function normalizeOffset(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 1;
}

function normalizeLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_READ_LIMIT;
  return Math.min(MAX_READ_LIMIT, Math.trunc(number));
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}
