/**
 * 错误码表与带阶段信息的 TaskError。
 * 每个错误码同时给出 HTTP 状态、所属阶段、面向用户的 message 和下一步 hint，
 * 服务端与浏览器共用这一张表。
 */

export const STAGE_LABELS = Object.freeze({
  input: '输入检查',
  model: '模型与技能选择',
  request: '宿主模型调用',
  parse: '输出解析',
  validate: '三段输出校验',
});

export const ERROR_CODES = Object.freeze({
  INPUT_EMPTY: {
    status: 400,
    stage: 'input',
    message: '输入为空，未执行生成',
    hint: '请先输入描述文本，或在图片反推模式下选择一张图片。',
  },
  INPUT_IMAGE_FORMAT: {
    status: 400,
    stage: 'input',
    message: '图片格式不受支持',
    hint: '仅支持 PNG、JPEG、WebP 图片，请转换后重新选择。',
  },
  BODY_INVALID: {
    status: 400,
    stage: 'input',
    message: '请求体不是合法的 JSON 对象',
    hint: '',
  },
  CONTENT_TYPE_UNSUPPORTED: {
    status: 415,
    stage: 'input',
    message: '请求必须使用 application/json',
    hint: '',
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    stage: 'input',
    message: '请求体过大',
    hint: '请压缩图片后重试。',
  },
  PROMPT_CONFIG_INVALID: {
    status: 500,
    stage: 'input',
    message: '系统提示词配置不可用',
    hint: '请检查插件 config.systemPrompt 或仓库 prompts/system.md 是否可读且非空。',
  },
  NO_SKILL: {
    status: 400,
    stage: 'model',
    message: '没有可用的提示词写法技能',
    hint: '请选择一个内置技能后再生成。',
  },
  SKILL_NOT_FOUND: {
    status: 404,
    stage: 'model',
    message: '所选技能不可用',
    hint: '该技能可能校验失败或已被移除，请重新选择技能。',
  },
  SKILLS_UNAVAILABLE: {
    status: 501,
    stage: 'model',
    message: '当前 dsh 宿主未提供技能注册表',
    hint: '',
  },
  MODEL_REQUIRED: {
    status: 400,
    stage: 'model',
    message: '尚未选择模型',
    hint: '请先在模型下拉列表中选择一个由 Harness 提供的模型。',
  },
  VISION_UNSUPPORTED: {
    status: 400,
    stage: 'model',
    message: '所选模型不支持图片输入',
    hint: '图片反推只能使用 Harness 声明支持视觉输入的模型，请改选视觉模型。',
  },
  HOST_ERROR: {
    status: 502,
    stage: 'request',
    message: '宿主调用失败',
    hint: '请检查 Harness 的 Provider 配置是否可用，然后重试；原始输入已保留。',
  },
  MODEL_ERROR: {
    status: 502,
    stage: 'request',
    message: '模型返回错误',
    hint: '可稍后重试或更换模型；插件不会自动改用其他 Provider。',
  },
  CANCELLED: {
    status: 499,
    stage: 'request',
    message: '任务已取消',
    hint: '输入与上一次有效结果均已保留，需要时请重新触发生成。',
  },
  JSON_INVALID: {
    status: 422,
    stage: 'parse',
    message: '模型返回内容不是合法 JSON',
    hint: '返回文本不会被当作提示词展示；请重试或更换模型。',
  },
  MODEL_OUTPUT_INVALID: {
    status: 422,
    stage: 'validate',
    message: '模型返回的三段 JSON 不完整或字段非法',
    hint: '输出必须包含 prompt_en / translation_zh / notes 三个字符串字段，且 prompt_en 非空；请重试或更换模型。',
  },
});

export class TaskError extends Error {
  constructor(code, options = {}) {
    const spec = ERROR_CODES[code] ?? { status: 500, stage: 'request', message: code, hint: '' };
    super(redactSecrets(options.message ?? spec.message));
    this.name = 'TaskError';
    this.code = code;
    this.status = options.status ?? spec.status;
    this.stage = options.stage ?? spec.stage;
    this.stageLabel = STAGE_LABELS[this.stage] ?? this.stage;
    this.hint = redactSecrets(options.hint ?? spec.hint);
    /** 参与定位的细节：非法字段名、宿主错误码等 */
    this.details = (options.details ?? []).map((detail) => redactSecrets(String(detail)));
  }

  toJSON() {
    const { code, stage, stageLabel, message, hint, details } = this;
    return { code, stage, stageLabel, message, hint, details };
  }
}

export function toTaskError(error) {
  if (error instanceof TaskError) return error;
  if (error?.name === 'AbortError') return new TaskError('CANCELLED');
  return new TaskError('HOST_ERROR', {
    message: `宿主调用失败：${error?.message ?? String(error)}`,
  });
}

const SECRET_PATTERNS = [
  /\b(?:sk|pk|ak|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*["']?[^\s"',;}]{4,}/gi,
];

/** 日志与界面脱敏（不得记录或展示完整密钥）。 */
export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  return SECRET_PATTERNS.reduce((output, pattern) => output.replace(pattern, 'credential=***'), text);
}
