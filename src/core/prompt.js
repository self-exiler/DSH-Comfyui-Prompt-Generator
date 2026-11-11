/**
 * 服务端提示词组装：系统契约 + 技能规范合成 system，用户内容合成 user 文本。
 * buildPrompt 供无工具的一次直出回退；buildAgentPrompt 额外注入内核形状的
 * <skill_content>、资源清单和读取工具说明。图片由调用方（plugin.js）经宿主
 * 附件服务转成内容块后追加，这里不接触图片数据。
 */

import { TaskError } from './errors.js';

/** 浏览器与服务端共用的图片格式白名单。 */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export function buildPrompt({ mode, text, skill, systemPrompt }) {
  assertPromptInputs({ skill, systemPrompt });

  const system = [
    systemPrompt.trim(),
    [
      `## 技能规范：${skill.name}`,
      '按以下原生技能规范撰写 prompt_en；最终仍须按系统层规定的三段 JSON 输出，技能自带的分块 / 正负面 / 自检等额外产物并入 notes。',
      '',
      skill.content.trim(),
    ].join('\n'),
  ].join('\n\n---\n\n');

  const user = buildUserText(mode, text);
  return { system, user };
}

/**
 * 后台 Agent 的系统提示词：系统契约 + 内核形状的 <skill_content> + 资源清单 + 工具说明。
 * 技能正文与资源清单都只在服务端使用，不下发浏览器。
 */
export function buildAgentPrompt({
  mode,
  text,
  skill,
  systemPrompt,
  skillDir,
  resources,
}) {
  assertPromptInputs({ skill, systemPrompt });

  const system = [
    systemPrompt.trim(),
    renderSkillBlock({ skill, skillDir, resources }),
    [
      '## 资源读取',
      skillDir ? `技能目录：${skillDir}` : '技能目录：未提供',
      `- list_files：列出技能目录内的文件（相对路径与字节数）。`,
      `- read_file：按行读取技能目录内的文本文件；大文件用 offset/limit 分段读取。`,
      '路径一律相对技能目录；只读取完成当前任务所需的章节，不要臆测文件内容。',
      '如果技能要求在写提示词前读取模板或参考文件，请先调用工具读取，再输出结果。',
      '如果技能要求额外产物（负面提示词、caption/layout 等），把不进入 prompt_en 的部分完整保留在 notes 中。',
      '完成读取后只输出系统层规定的三段 JSON，不再调用工具。',
    ].filter(Boolean).join('\n'),
  ].join('\n\n');

  return { system, user: buildUserText(mode, text) };
}

/** 按 dsh 技能加载器的形状渲染技能正文与资源清单，模型据此解析相对路径。 */
function renderSkillBlock({ skill, skillDir, resources }) {
  const fileList = Array.isArray(resources) && resources.length
    ? resources.map((file) => `- ${file.path} (${file.bytes} bytes)`).join('\n')
    : '(未发现额外资源文件)';

  return [
    `<skill_content name="${escapeAttribute(skill.name)}">`,
    '<skill_resources>',
    skillDir
      ? `Base directory for this skill: ${escapeMarkup(skillDir)}`
      : 'Resources for this skill are managed by the host.',
    'Files (relative paths):',
    fileList,
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content.trim(),
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n');
}

function assertPromptInputs({ skill, systemPrompt }) {
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    throw new TaskError('PROMPT_CONFIG_INVALID', { message: '插件未配置系统提示词，已阻止本次生成' });
  }
  if (!skill?.name || !skill.content?.trim()) {
    throw new TaskError('SKILL_NOT_FOUND', { message: '尚未选择可用的技能' });
  }
}

function buildUserText(mode, text) {
  const note = String(text ?? '').trim();
  return mode === 'image'
    ? [
      '请按上述技能规范反推这张图片，并只输出规定的三段 JSON。',
      '只描述画面中可观察的内容；对含义/风格/模糊细节的判断写进 notes，不要写成确定事实。',
      note && `用户补充说明：${note}`,
    ].filter(Boolean).join('\n')
    : `需要整理成提示词的内容：\n"""\n${note}\n"""`;
}

function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function escapeMarkup(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
