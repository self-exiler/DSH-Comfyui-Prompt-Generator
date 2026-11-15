import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createRepoSkillProvider, isPathInside } from '../lib/repo-skills.js';
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

test('customSkillsDir 下的技能纳入列表，可正常读取正文', async () => {
  const customRoot = path.join(ROOT, 'tests', 'fixtures', 'custom-skills');
  const provider = createRepoSkillProvider(ctx, ROOT, customRoot);
  const skills = await provider.list();
  assert.ok(skills.some((skill) => skill.name === 'my-custom-skill'));

  const candidate = skills.find((skill) => skill.name === 'my-custom-skill');
  const skill = await provider.get(candidate);
  assert.equal(skill.name, 'my-custom-skill');
  assert.equal(skill.description, '自定义工作区技能');
  assert.equal(await provider.get({ name: 'x', path: path.join(customRoot, 'my-custom-skill', 'other.md') }), undefined);
});

test('仓库同名技能优先于自定义工作区技能', async () => {
  const customRoot = path.join(ROOT, 'tests', 'fixtures', 'custom-skills');
  const skills = await createRepoSkillProvider(ctx, ROOT, customRoot).list();
  const sdPrompt = skills.filter((skill) => skill.name === 'sd-prompt');
  assert.equal(sdPrompt.length, 1);
  assert.ok(isPathInside(SKILLS_ROOT, sdPrompt[0].path));
});
