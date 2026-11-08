/** 服务端消息组装：系统契约 -> 技能规范 -> 用户内容。 */

import { TaskError } from './errors.js';

export function buildMessages({ mode, text, image, skill, systemPrompt }) {
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    throw new TaskError('PROMPT_CONFIG_INVALID', {
      message: '插件未配置系统提示词，已阻止本次生成',
    });
  }
  if (!skill?.name || !skill.content?.trim()) {
    throw new TaskError('SKILL_NOT_FOUND', { message: '尚未选择可用的技能' });
  }

  const messages = [
    { role: 'system', content: systemPrompt.trim() },
    {
      role: 'system',
      content: [
        `## 技能规范：${skill.name}`,
        '按以下原生技能规范撰写 prompt_en；最终仍须按系统层规定的三段 JSON 输出，技能自带的分块 / 正负面 / 自检等额外产物并入 notes。',
        '',
        skill.content.trim(),
      ].join('\n'),
    },
  ];

  if (mode === 'image') {
    if (!image?.dataUrl || !image?.mimeType) {
      throw new TaskError('INPUT_EMPTY', { message: '图片任务缺少图片数据' });
    }
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            '请按上述技能规范反推这张图片，并只输出规定的三段 JSON。',
            '只描述画面中可观察的内容；对含义/风格/模糊细节的判断写进 notes，不要写成确定事实。',
            text?.trim() ? `用户补充说明：${text.trim()}` : '',
          ].filter(Boolean).join('\n'),
        },
        { type: 'image', mimeType: image.mimeType, dataUrl: image.dataUrl },
      ],
    });
  } else {
    messages.push({
      role: 'user',
      content: `需要整理成提示词的内容：\n"""\n${String(text ?? '').trim()}\n"""`,
    });
  }

  return messages;
}
