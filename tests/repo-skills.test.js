import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createRepoSkillProvider, isPathInside } from '../plugins/comfyui-prompt/lib/repo-skills.js';
import { ROOT } from './helpers.js';

const ctx = { logger: { warn() {} } };
const SKILLS_ROOT = path.join(ROOT, 'skills');

test('仓库技能 provider 只列出本仓库 skills/ 下带有效 SKILL.md 的目录', async () => {
  const skills = await createRepoSkillProvider(ctx, ROOT).list();
  const names = skills.map((skill) => skill.name);
  assert.ok(names.includes('sd-prompt'));
  assert.ok(names.includes('moss-image-prompt-enhancer'));
  assert.ok(skills.every((skill) => isPathInside(SKILLS_ROOT, skill.path)));
});

test('仓库技能 provider 按候选定位加载正文，拒绝仓库外路径', async () => {
  const provider = createRepoSkillProvider(ctx, ROOT);
  const candidate = (await provider.list()).find((skill) => skill.name === 'sd-prompt');
  const skill = await provider.get(candidate);
  assert.equal(skill.name, 'sd-prompt');
  assert.match(skill.content, /Stable Diffusion/);
  assert.equal(skill.resourceBase.kind, 'directory');
  assert.equal(await provider.get({ ...candidate, path: path.join(ROOT, 'package.json') }), undefined);
});

test('isPathInside 不含 base 自身，也不放行 .. 逃逸', () => {
  assert.equal(isPathInside(SKILLS_ROOT, SKILLS_ROOT), false);
  assert.equal(isPathInside(SKILLS_ROOT, path.join(SKILLS_ROOT, 'a', 'SKILL.md')), true);
  assert.equal(isPathInside(SKILLS_ROOT, path.join(SKILLS_ROOT, '..', 'x')), false);
  assert.equal(isPathInside(SKILLS_ROOT, ''), false);
});
