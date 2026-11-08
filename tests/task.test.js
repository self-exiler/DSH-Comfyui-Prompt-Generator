import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMessages } from '../src/core/prompt.js';
import { extractResult, parseStructuredOutput } from '../src/core/task.js';
import { VALID_OUTPUT } from './helpers.js';

const skill = { name: 'sd-prompt', content: '使用逗号分隔标签。' };

test('消息分层：系统契约在前、技能独立成消息、用户内容在最后', () => {
  const messages = buildMessages({
    mode: 'text',
    text: '一个女孩',
    skill,
    systemPrompt: '你是提示词改写器，只输出三段 JSON。',
  });

  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /只输出三段 JSON/);
  assert.equal(messages[1].role, 'system');
  assert.match(messages[1].content, /sd-prompt/);
  assert.match(messages[1].content, /使用逗号分隔标签/);
  assert.equal(messages[2].role, 'user');
  assert.match(messages[2].content, /一个女孩/);
});

test('图片模式：用户消息带图片部件', () => {
  const messages = buildMessages({
    mode: 'image',
    text: '重点看服装',
    image: { dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png' },
    skill,
    systemPrompt: '系统提示词',
  });
  const user = messages.at(-1);
  assert.ok(Array.isArray(user.content));
  assert.ok(user.content.some((part) => part.type === 'image'));
  assert.ok(user.content.some((part) => part.type === 'text' && /重点看服装/.test(part.text)));
});

test('parseStructuredOutput 容忍 json 代码块与前后缀文本', () => {
  const wrapped = `说明：\n\`\`\`json\n${JSON.stringify(VALID_OUTPUT)}\n\`\`\`\n以上。`;
  assert.deepEqual(parseStructuredOutput(wrapped), VALID_OUTPUT);
});

test('extractResult 归一化三段并去空白', () => {
  assert.deepEqual(
    extractResult({ prompt_en: '  A cat.  ', translation_zh: '  一只猫。 ', notes: '   ' }),
    { prompt_en: 'A cat.', translation_zh: '一只猫。', notes: '' },
  );
});
