import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt } from '../src/core/prompt.js';
import { TaskError, redactSecrets } from '../src/core/errors.js';
import { extractResult, parseStructuredOutput } from '../src/core/task.js';
import { VALID_OUTPUT } from './helpers.js';

const skill = { name: 'sd-prompt', content: '使用逗号分隔标签。' };

test('提示词分层：系统契约在前，技能规范随后，用户内容单独成文', () => {
  const { system, user } = buildPrompt({
    mode: 'text',
    text: '一个女孩',
    skill,
    systemPrompt: '你是提示词改写器，只输出三段 JSON。',
  });
  assert.ok(system.startsWith('你是提示词改写器'));
  assert.match(system, /sd-prompt/);
  assert.ok(system.indexOf('只输出三段 JSON') < system.indexOf('使用逗号分隔标签'));
  assert.match(user, /一个女孩/);
  assert.doesNotMatch(system, /一个女孩/);
});

test('图片模式：补充说明进入 user 文本，空补充说明不产生空行', () => {
  const withNote = buildPrompt({ mode: 'image', text: '重点看服装', skill, systemPrompt: 'S' });
  assert.match(withNote.user, /用户补充说明：重点看服装/);
  const without = buildPrompt({ mode: 'image', text: '  ', skill, systemPrompt: 'S' });
  assert.doesNotMatch(without.user, /补充说明/);
  assert.ok(!without.user.endsWith('\n'));
});

test('缺少系统提示词或技能时拒绝组装', () => {
  assert.throws(() => buildPrompt({ mode: 'text', text: 'x', skill, systemPrompt: '  ' }),
    (error) => error.code === 'PROMPT_CONFIG_INVALID');
  assert.throws(() => buildPrompt({ mode: 'text', text: 'x', skill: { name: 's', content: ' ' }, systemPrompt: 'S' }),
    (error) => error.code === 'SKILL_NOT_FOUND');
});

test('parseStructuredOutput 容忍 json 代码块与前后缀文本', () => {
  const wrapped = `说明：\n\`\`\`json\n${JSON.stringify(VALID_OUTPUT)}\n\`\`\`\n以上。`;
  assert.deepEqual(parseStructuredOutput(wrapped), VALID_OUTPUT);
});

test('parseStructuredOutput 处理字符串内的大括号与尾随文本', () => {
  const raw = '{"prompt_en":"a {curly} brace \\" quote","translation_zh":"","notes":""} 之后还有 {别的}';
  assert.equal(parseStructuredOutput(raw).prompt_en, 'a {curly} brace " quote');
});

test('parseStructuredOutput 对空内容、无对象、未闭合分别报 JSON_INVALID', () => {
  for (const raw of ['', '   ', undefined, 'no json here', '{"prompt_en": "x"']) {
    assert.throws(() => parseStructuredOutput(raw), (error) => error.code === 'JSON_INVALID', String(raw));
  }
});

test('extractResult 归一化三段并去空白', () => {
  assert.deepEqual(
    extractResult({ prompt_en: '  A cat.  ', translation_zh: '  一只猫。 ', notes: '   ' }),
    { prompt_en: 'A cat.', translation_zh: '一只猫。', notes: '' },
  );
});

test('extractResult 拒绝缺字段、非字符串与空 prompt_en', () => {
  for (const bad of [null, [], { prompt_en: 'A' }, { prompt_en: 'A', translation_zh: 1, notes: '' }, { ...VALID_OUTPUT, prompt_en: ' ' }]) {
    assert.throws(() => extractResult(bad), (error) => error instanceof TaskError && error.code === 'MODEL_OUTPUT_INVALID');
  }
});

test('redactSecrets 脱敏常见密钥形态', () => {
  const redacted = redactSecrets('key sk-abcdefgh1234 Bearer abcdefgh12345678 api_key=hunter2hunter2');
  assert.doesNotMatch(redacted, /abcdefgh|hunter2/);
});
