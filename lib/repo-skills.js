/** 向 dsh 技能注册表贡献本仓库 skills/ 与可选的自定义工作区目录。 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function createRepoSkillProvider(ctx, root, customRoot) {
  const roots = [path.resolve(root, 'skills')];
  if (typeof customRoot === 'string' && customRoot.trim()) {
    roots.push(path.resolve(customRoot.trim()));
  }

  /** 判断候选技能文件是否位于任一扫描根内，杜绝列表外的任意文件读取。 */
  function isInsideRoots(candidatePath) {
    return roots.some((skillsRoot) => isPathInside(skillsRoot, candidatePath));
  }

  async function readEntry(skillsRoot, dirName, signal) {
    for (const fileName of ['SKILL.md', 'skill.md']) {
      const filePath = path.join(skillsRoot, dirName, fileName);
      try {
        const raw = await readFile(filePath, { encoding: 'utf8', signal });
        const parsed = parseSkill(raw);
        if (parsed) return { ...parsed, path: filePath };
      } catch (error) {
        if (error.name === 'AbortError') throw error;
      }
    }
    return null;
  }

  /** 扫描单个根目录；目录不存在或不可读只告警，不拖累其它根。 */
  async function scanRoot(skillsRoot, signal) {
    let entries;
    try {
      entries = await readdir(skillsRoot, { withFileTypes: true, signal });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      ctx.logger.warn('comfyui-prompt skills unavailable (%s): %s', skillsRoot, error.code ?? error.message);
      return [];
    }
    return (await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readEntry(skillsRoot, entry.name, signal))))
      .filter(Boolean);
  }

  return {
    name: 'comfyui-repo',
    async list({ signal } = {}) {
      const scans = await Promise.all(roots.map((skillsRoot) => scanRoot(skillsRoot, signal)));
      // 按根顺序去重：仓库同名技能优先于自定义工作区
      const seen = new Set();
      const skills = [];
      for (const entry of scans.flat()) {
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        skills.push(toCandidate(entry));
      }
      return skills;
    },
    async get(candidate, { signal } = {}) {
      if (!candidate?.path || !isInsideRoots(candidate.path)) return undefined;
      try {
        const raw = await readFile(candidate.path, { encoding: 'utf8', signal });
        const parsed = parseSkill(raw);
        if (!parsed || parsed.name !== candidate.name) return undefined;
        return {
          ...toCandidate({ ...parsed, path: candidate.path }),
          content: parsed.content,
          resourceBase: { kind: 'directory', path: path.dirname(candidate.path) },
        };
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        return undefined;
      }
    },
  };
}

function toCandidate(skill) {
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    source: 'custom',
    provider: 'comfyui-repo',
    rank: 300,
    locator: skill.path,
    invocation: { modelInvocable: true, userInvocable: true },
  };
}

function parseSkill(raw) {
  const text = String(raw ?? '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return null;

  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  const name = fields.name?.trim();
  const description = fields.description?.trim();
  if (!NAME_PATTERN.test(name ?? '') || !description) return null;

  return {
    name,
    description,
    content: text.slice(match[0].length).trim(),
  };
}

/** 判断 candidate 是否位于 base 目录内（不含 base 自身），provider 与测试共用。 */
export function isPathInside(base, candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}
