/**
 * 模型输出解析与三段结果校验。
 * 这些函数由插件服务端在唯一一次 LLM 调用后使用，浏览器不参与编排。
 */

import { TaskError } from './errors.js';

const OUTPUT_KEYS = ['prompt_en', 'translation_zh', 'notes'];

/** 宽容解析：去掉 ```json 包裹，截取第一个平衡的 { … } 片段。 */
export function parseStructuredOutput(raw) {
  let text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new TaskError('JSON_INVALID', { message: '模型返回内容为空' });

  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(text);
  if (fence) text = fence[1].trim();

  const start = text.indexOf('{');
  if (start === -1) {
    throw new TaskError('JSON_INVALID', { message: '模型返回内容中找不到 JSON 对象', details: [previewOf(text)] });
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < text.length && end === -1; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}' && --depth === 0) {
      end = index;
    }
  }
  if (end === -1) {
    throw new TaskError('JSON_INVALID', { message: '模型返回的 JSON 不完整（大括号未闭合）', details: [previewOf(text)] });
  }

  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (error) {
    throw new TaskError('JSON_INVALID', {
      message: `模型返回内容不是合法 JSON：${error.message}`,
      details: [previewOf(slice)],
    });
  }
}

/** 校验并归一化三段结果。 */
export function extractResult(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TaskError('MODEL_OUTPUT_INVALID', { message: '模型返回的不是 JSON 对象' });
  }
  const invalid = OUTPUT_KEYS.filter((key) => typeof parsed[key] !== 'string');
  if (invalid.length) {
    throw new TaskError('MODEL_OUTPUT_INVALID', {
      message: '模型返回的三段 JSON 字段不符合契约',
      details: invalid.map((key) => `${key} 缺失或不是字符串`),
    });
  }
  const [prompt_en, translation_zh, notes] = OUTPUT_KEYS.map((key) => parsed[key].trim());
  if (!prompt_en) {
    throw new TaskError('MODEL_OUTPUT_INVALID', { message: 'prompt_en 为空，没有可交付的提示词' });
  }
  return { prompt_en, translation_zh, notes };
}

function previewOf(text, limit = 160) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
