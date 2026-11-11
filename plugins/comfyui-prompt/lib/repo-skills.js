/** 向 dsh 技能注册表贡献本仓库 skills/，不扫描用户或其他项目目录。 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function createRepoSkillProvider(ctx, root) {
  const skillsRoot = path.resolve(root, 'skills');

  async function readEntry(dirName, signal) {
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

  return {
    name: 'comfyui-repo',
    async list({ signal } = {}) {
      let entries;
      try {
        entries = await readdir(skillsRoot, { withFileTypes: true, signal });
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        ctx.logger.warn('comfyui-prompt skills unavailable: %s', error.code ?? error.message);
        return [];
      }

      const skills = (await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readEntry(entry.name, signal))))
        .filter(Boolean)
        .map(toCandidate);
      return skills;
    },
    async get(candidate, { signal } = {}) {
      if (!candidate?.path || !isPathInside(skillsRoot, candidate.path)) return undefined;
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
