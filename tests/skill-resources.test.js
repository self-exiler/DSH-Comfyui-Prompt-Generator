import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createSkillTools,
  LIST_TOOL,
  listSkillResources,
  READ_TOOL,
  readSkillFile,
} from '../plugins/comfyui-prompt/lib/skill-resources.js';

async function makeSkill() {
  const dir = await mkdtemp(path.join(tmpdir(), 'comfyui-prompt-test-'));
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await mkdir(path.join(dir, 'references'), { recursive: true });
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\n');
  await writeFile(path.join(dir, 'assets', '模板.txt'), Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join('\n'));
  await writeFile(path.join(dir, 'references', 'layout.md'), '# Layout\n');
  await writeFile(path.join(dir, '.hidden'), 'secret');
  await writeFile(path.join(dir, 'scripts', 'compile.mjs'), [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    'const [input, output] = process.argv.slice(2);',
    "writeFileSync(output, `compiled:${readFileSync(input, 'utf8')}`);",
    "console.log('ok');",
  ].join('\n'));
  return dir;
}

test('资源清单包含技能文件并跳过 SKILL.md、隐藏文件和符号链接', async (t) => {
  const dir = await makeSkill();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const files = await listSkillResources(dir);
  const paths = files.map((file) => file.path);
  assert.ok(paths.includes('assets/模板.txt'));
  assert.ok(paths.includes('references/layout.md'));
  assert.ok(paths.includes('scripts/compile.mjs'));
  assert.ok(!paths.includes('SKILL.md'), 'SKILL.md 已内联，不再重复列出');
  assert.ok(!paths.some((item) => item.includes('.hidden')));
});

test('read_file 按 1 基行号窗口读取并标记截断', async (t) => {
  const dir = await makeSkill();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const page = await readSkillFile(dir, { path: 'assets/模板.txt', offset: 3, limit: 2 });
  assert.equal(page.offset, 3);
  assert.equal(page.totalLines, 10);
  assert.equal(page.truncated, true);
  assert.match(page.content, /3 \| line3/);
  assert.match(page.content, /4 \| line4/);
  assert.doesNotMatch(page.content, /line5/);

  const all = await readSkillFile(dir, { path: 'assets/模板.txt' });
  assert.equal(all.truncated, false);
  assert.match(all.content, /10 \| line10/);
});

test('read_file 拒绝目录外路径、二进制文件和目录', async (t) => {
  const dir = await makeSkill();
  const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside.txt`);
  await writeFile(outside, 'outside');
  await writeFile(path.join(dir, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { force: true });
  });

  await assert.rejects(readSkillFile(dir, { path: '../outside.txt' }), /越出技能目录/);
  await assert.rejects(readSkillFile(dir, { path: outside }), /越出技能目录/);
  await assert.rejects(readSkillFile(dir, { path: 'binary.bin' }), /二进制/);
  await assert.rejects(readSkillFile(dir, { path: 'assets' }), /不是文件/);
});

test('read_file 通过 realpath 拒绝符号链接逃逸', async (t) => {
  const dir = await makeSkill();
  const outside = path.join(path.dirname(dir), `${path.basename(dir)}-target.txt`);
  await writeFile(outside, 'outside');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { force: true });
  });

  try {
    await symlink(outside, path.join(dir, 'link.txt'), 'file');
  } catch {
    t.skip('当前环境不允许创建文件符号链接');
    return;
  }
  await assert.rejects(readSkillFile(dir, { path: 'link.txt' }), /符号链接/);
});

test('scoped 工具只注册读取与列目录，不注册脚本执行', async (t) => {
  const dir = await makeSkill();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const tools = new Map(createSkillTools({ skillDir: dir }).map((tool) => [tool.name, tool]));
  assert.deepEqual([...tools.keys()], [READ_TOOL, LIST_TOOL]);

  const signal = new AbortController().signal;
  const read = await tools.get(READ_TOOL).execute({ path: 'references/layout.md' }, { signal });
  assert.match(read.content, /Layout/);

  const listed = await tools.get(LIST_TOOL).execute({}, { signal });
  assert.ok(listed.files.some((file) => file.path === 'assets/模板.txt' && file.kind === 'file'));
});

