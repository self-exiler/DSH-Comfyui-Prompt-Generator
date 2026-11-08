/**
 * 错误分类与阶段标记。
 *
 * 设计约束：
 * - 每一种失败都必须能定位到「阶段」，UI 不能只显示“生成失败”。
 * - 取消、宿主错误、模型错误、图片能力不匹配、三段输出校验失败必须互相区分。
 */

export const STAGES = Object.freeze({
  INPUT: 'input',
  MODEL: 'model',
  REQUEST: 'request',
  PARSE: 'parse',
  VALIDATE: 'validate',
});

export const STAGE_LABELS = Object.freeze({
  input: '输入检查',
  model: '模型与技能选择',
  request: '宿主模型调用',
  parse: '输出解析',
  validate: '三段输出校验',
});

/**
 * 错误码表。message 面向用户，hint 面向“下一步怎么做”。
 */
export const ERROR_CODES = Object.freeze({
  INPUT_EMPTY: {
    stage: STAGES.INPUT,
    message: '输入为空，未执行生成',
    hint: '请先输入描述文本，或在图片反推模式下选择一张图片。',
  },
  INPUT_IMAGE_FORMAT: {
    stage: STAGES.INPUT,
    message: '图片格式不受支持',
    hint: '仅支持 PNG、JPEG、WebP 图片，请转换后重新选择。',
  },
  NO_SKILL: {
    stage: STAGES.MODEL,
    message: '没有可用的提示词写法技能',
    hint: '请选择一个内置技能，或加载符合协议的技能后再生成。',
  },
  SKILL_NOT_FOUND: {
    stage: STAGES.MODEL,
    message: '所选技能不可用',
    hint: '该技能可能校验失败或已被移除，请重新选择技能。',
  },
  MODEL_REQUIRED: {
    stage: STAGES.MODEL,
    message: '尚未选择模型',
    hint: '请先在模型下拉列表中选择一个由 Harness 提供的模型。',
  },
  VISION_UNSUPPORTED: {
    stage: STAGES.MODEL,
    message: '所选模型不支持图片输入',
    hint: '图片反推只能使用 Harness 声明支持视觉输入的模型，请改选视觉模型。',
  },
  PROMPT_CONFIG_INVALID: {
    stage: STAGES.INPUT,
    message: '系统提示词配置不可用',
    hint: '请检查插件 config.systemPrompt 或仓库 prompts/system.md 是否可读且非空。',
  },
  HOST_ERROR: {
    stage: STAGES.REQUEST,
    message: '宿主调用失败',
    hint: '请检查 Harness 的 Provider 配置是否可用，然后显式点击重试；原始输入已保留。',
  },
  MODEL_ERROR: {
    stage: STAGES.REQUEST,
    message: '模型返回错误',
    hint: '可稍后重试或更换模型；插件不会自动改用其他 Provider 或追加修复调用。',
  },
  CANCELLED: {
    stage: STAGES.REQUEST,
    message: '任务已取消',
    hint: '输入与上一次有效结果均已保留，需要时请重新触发生成。',
  },
  JSON_INVALID: {
    stage: STAGES.PARSE,
    message: '模型返回内容不是合法 JSON',
    hint: '属于结构化输出失败，返回文本不会被当作提示词展示；请重试或更换模型。',
  },
  MODEL_OUTPUT_INVALID: {
    stage: STAGES.VALIDATE,
    message: '模型返回的三段 JSON 不完整或字段非法',
    hint: '输出必须包含 prompt_en / translation_zh / notes 三个字符串字段，且 prompt_en 非空；请重试或更换模型。',
  },
});

/**
 * 带阶段信息的任务错误。
 */
export class TaskError extends Error {
  constructor(code, options = {}) {
    const spec = ERROR_CODES[code] ?? { stage: STAGES.REQUEST, message: code, hint: '' };
    super(redactSecrets(options.message ?? spec.message));
    this.name = 'TaskError';
    this.code = code;
    this.stage = options.stage ?? spec.stage;
    this.stageLabel = STAGE_LABELS[this.stage] ?? this.stage;
    this.hint = redactSecrets(options.hint ?? spec.hint);
    /** 参与定位的细节：非法字段名、技能文件名等 */
    this.details = (options.details ?? []).map((detail) => redactSecrets(String(detail)));
    this.cause = options.cause;
  }

  toJSON() {
    return {
      code: this.code,
      stage: this.stage,
      stageLabel: this.stageLabel,
      message: this.message,
      hint: this.hint,
      details: this.details,
    };
  }
}

export function isTaskError(value) {
  return value instanceof TaskError;
}

export function toTaskError(error) {
  if (isTaskError(error)) return error;
  if (error && error.name === 'AbortError') {
    return new TaskError('CANCELLED', { cause: error });
  }
  return new TaskError('HOST_ERROR', {
    message: `宿主调用失败：${error?.message ?? String(error)}`,
    cause: error,
  });
}

const SECRET_PATTERNS = [
  /\b(sk|pk|ak|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /\b(api[_-]?key|token|secret|password)\s*[=:]\s*["']?[^\s"',;}]{4,}/gi,
];

/**
 * 日志与界面脱敏（不得记录或展示完整密钥）。
 */
export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, ...groups) => {
      const label = /^(api[_-]?key|token|secret|password)/i.test(match)
        ? match.split(/[=:]/)[0]
        : 'credential';
      return `${label}=***`;
    });
  }
  return output;
}
