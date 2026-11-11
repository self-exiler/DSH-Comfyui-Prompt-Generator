/**
 * 服务端提示词组装：系统契约 + 技能规范合成 system，用户内容合成 user 文本。
 * 图片由调用方（plugin.js）经宿主附件服务转成内容块后追加，这里不接触图片数据。
 */

import { TaskError } from './errors.js';

/** 浏览器与服务端共用的图片格式白名单。 */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export function buildPrompt({ mode, text, skill, systemPrompt }) {
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    throw new TaskError('PROMPT_CONFIG_INVALID', { message: '插件未配置系统提示词，已阻止本次生成' });
  }
  if (!skill?.name || !skill.content?.trim()) {
    throw new TaskError('SKILL_NOT_FOUND', { message: '尚未选择可用的技能' });
  }

  const system = [
    systemPrompt.trim(),
    [
      `## 技能规范：${skill.name}`,
      '按以下原生技能规范撰写 prompt_en；最终仍须按系统层规定的三段 JSON 输出，技能自带的分块 / 正负面 / 自检等额外产物并入 notes。',
      '',
      skill.content.trim(),
    ].join('\n'),
  ].join('\n\n---\n\n');

  const note = String(text ?? '').trim();
  const user = mode === 'image'
    ? [
      '请按上述技能规范反推这张图片，并只输出规定的三段 JSON。',
      '只描述画面中可观察的内容；对含义/风格/模糊细节的判断写进 notes，不要写成确定事实。',
      note && `用户补充说明：${note}`,
    ].filter(Boolean).join('\n')
    : `需要整理成提示词的内容：\n"""\n${note}\n"""`;

  return { system, user };
}
