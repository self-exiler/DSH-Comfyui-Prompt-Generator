import test from 'node:test';
import assert from 'node:assert/strict';

import { createRepoSkillProvider } from '../plugins/comfyui-prompt/lib/repo-skills.js';
import { ROOT } from './helpers.js';

const ctx = { logger: { warn() {} } };

test('仓库技能 provider 只列出本仓库 skills/ 下的目录', async () => {
  const provider = createRepoSkillProvider(ctx, ROOT);
  const skills = await provider.list();
  assert.deepEqual(skills.map((skill) => skill.name), [
    'anima-prompt-mixed',
    'moss-image-prompt-enhancer',
    'sd-prompt',
  ]);
  assert.ok(skills.every((skill) => skill.path.startsWith(`${ROOT}\\skills\\`)));
});

test('仓库技能 provider 按候选定位加载正文', async () => {
  const provider = createRepoSkillProvider(ctx, ROOT);
  const candidate = (await provider.list()).find((skill) => skill.name === 'sd-prompt');
  const skill = await provider.get(candidate);
  assert.equal(skill.name, 'sd-prompt');
  assert.match(skill.content, /Stable Diffusion/);
  assert.equal(skill.resourceBase.kind, 'directory');
  assert.equal(await provider.get({ ...candidate, path: `${ROOT}\\AGENTS.md` }), undefined);
});
