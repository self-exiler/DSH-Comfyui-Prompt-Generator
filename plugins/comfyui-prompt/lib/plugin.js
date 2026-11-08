/**
 * comfyui-prompt-tool — dsh (cordis) 插件
 *
 * 职责：
 * 1. 把本仓库的 WebView（src/ui）以静态资源方式挂在 web profile 的 HTTP 服务上；
 * 2. 提供 /api/models、/api/skills 与 /api/generate：
 *    - models 来自 ctx.llm；
 *    - skills 只暴露本仓库 skills/ 下的原生技能；
 *    - generate 在服务端完成提示词、技能、消息组装、模型调用与三段解析。
 * 3. 不读取、不存储任何密钥；凭据完全由宿主的 provider 适配器复用。
 *
 * 图片部件经 dsh 附件服务（ctx.attachments.saveImage）转成 ImageAttachmentRef，
 * 再作为 image 内容块交给 ctx.llm；宿主不可用时明确返回 VISION_UNSUPPORTED，
 * 不静默改道到其他 Provider。
 */

import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskError, redactSecrets } from '../../../src/core/errors.js';
import { buildMessages } from '../../../src/core/prompt.js';
import { SUPPORTED_IMAGE_TYPES, extractResult, parseStructuredOutput } from '../../../src/core/task.js';
import { createRepoSkillProvider, isPathInside } from './repo-skills.js';

export const name = 'comfyui-prompt-tool';

export const inject = ['webServer', 'llm'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const DEFAULT_PREFIX = '/comfyui-prompt';
/** 插件位于 <仓库>/plugins/comfyui-prompt/lib，仓库根在其上三级 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const TASK_STATUS = {
  INPUT_EMPTY: 400,
  INPUT_IMAGE_FORMAT: 400,
  NO_SKILL: 400,
  SKILL_NOT_FOUND: 404,
  MODEL_REQUIRED: 400,
  VISION_UNSUPPORTED: 400,
  PROMPT_CONFIG_INVALID: 500,
  HOST_ERROR: 502,
  MODEL_ERROR: 502,
  CANCELLED: 499,
  JSON_INVALID: 422,
  MODEL_OUTPUT_INVALID: 422,
};

export function apply(ctx, config = {}) {
  const root = path.resolve(config.root ?? REPO_ROOT);
  const prefix = `/${(config.prefix ?? DEFAULT_PREFIX).replace(/^\/+|\/+$/g, '')}`;
  const systemPrompt = resolveSystemPrompt(ctx, config, root);

  // 路由必须挂在 ctx.effect 上：插件被卸载 / HMR 重载时由 cordis 自动注销。
  // 直接返回 dispose 函数不会被加载器调用，旧路由会残留并在下一次挂载时
  // 触发 webserver 的 "duplicate prefix route" 错误。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: prefix,
        handler: (req, res) => serveStatic(req, res, { root, prefix }),
      }),
    `comfyui-prompt: webview ${prefix}`,
  );

  // ---- 桥接 API：最长前缀匹配，优先于上面的整目录路由 ----
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: `${prefix}/api`,
        handler: (req, res) => serveApi(req, res, { ctx, prefix, root, systemPrompt }),
      }),
    `comfyui-prompt: api ${prefix}/api`,
  );

  const skills = ctx.get('skills');
  if (skills?.registerProvider) {
    ctx.effect(
      () => skills.registerProvider(() => createRepoSkillProvider(ctx, root)),
      'comfyui-prompt: repository skills',
    );
  } else {
    ctx.logger.warn('comfyui-prompt: skills service unavailable; /api/skills will be disabled');
  }

  ctx.logger.info('comfyui-prompt-tool ready: %s (root: %s)', `${prefix}/src/ui/index.html`, root);
}

function resolveSystemPrompt(ctx, config, root) {
  if (typeof config.systemPrompt === 'string' && config.systemPrompt.trim()) {
    return config.systemPrompt.trim();
  }
  try {
    return readFileSync(path.join(root, 'prompts', 'system.md'), 'utf8').trim();
  } catch (error) {
    ctx.logger.warn('comfyui-prompt system prompt unavailable: %s', redactSecrets(error.message));
    return '';
  }
}

/* ------------------------------------------------------------------ 静态资源 */

/**
 * 浏览器只加载 src/ui 下的页面与模块；技能正文经 /api/skills 返回，
 * 系统提示词只由服务端 fs 读取，均不作为静态资源暴露。
 */
const STATIC_ROOTS = new Set(['src']);

async function serveStatic(req, res, { root, prefix }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let relative = pathname.slice(prefix.length) || '/';
  if (relative === '/') relative = '/src/ui/index.html';

  // URL 里可能混入反斜杠或编码后的 ..，先按两种分隔符切分再判断
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  const allowed = segments.length > 0
    && STATIC_ROOTS.has(segments[0])
    && segments.every((segment) => segment !== '.' && segment !== '..' && !segment.startsWith('.'));
  if (!allowed) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let file = target;
  try {
    const info = await stat(target);
    if (info.isDirectory()) file = path.join(target, 'index.html');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 Not Found: ${relative}`);
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 Not Found: ${relative}`);
  }
}

/* ------------------------------------------------------------------ 桥接 API */

async function serveApi(req, res, { ctx, prefix, root, systemPrompt }) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname.slice(prefix.length);

  try {
    if (route === '/api/health' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true, plugin: name }));
      return;
    }
    if (route === '/api/models' && req.method === 'GET') {
      return await handleModels(ctx, res);
    }
    if (route === '/api/skills' && req.method === 'GET') {
      return await handleSkills(ctx, root, res);
    }
    if (route === '/api/generate' && req.method === 'POST') {
      return await handleGenerate(ctx, req, res, { root, systemPrompt });
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `未知端点 ${route}` } }));
  } catch (error) {
    if (res.writableEnded || res.destroyed) return;
    const apiError = error instanceof ApiError;
    const taskError = error instanceof TaskError;
    const status = apiError ? error.status : taskError ? (TASK_STATUS[error.code] ?? 500) : 500;
    const code = apiError ? error.code : taskError ? error.code : 'HOST_ERROR';
    const body = apiError
      ? {
        code,
        message: redactSecrets(error.message),
        ...(error.detail ? { detail: redactSecrets(error.detail) } : {}),
      }
      : taskError
        ? error.toJSON()
        : { code, message: '宿主内部处理失败' };
    ctx.logger.warn('comfyui-prompt api error (%s): %s', code, redactSecrets(error.message));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: body }));
  }
}

/** 模型目录来自 ctx.llm，插件不维护模型清单。 */
async function handleModels(ctx, res) {
  // 并行查询各 provider：某个 provider 慢（例如模型列表端点超时）不拖累整体。
  const listed = await Promise.all(
    ctx.llm.listProviders().map(async (info) => {
      try {
        const list = await ctx.llm.listModels(info.id);
        return { info, list, failure: null };
      } catch (error) {
        ctx.logger.warn('comfyui-prompt model list failed (%s): %s', info.id, redactSecrets(error.message));
        return { info, list: [], failure: `${info.id}: 模型目录查询失败` };
      }
    }),
  );

  const models = [];
  const failures = [];
  for (const { info, list, failure } of listed) {
    if (failure) failures.push(failure);
    for (const model of list) {
      models.push({
        id: `${info.id}::${model.id}`,
        label: `${model.name} · ${info.name ?? info.id}`,
        provider: info.id,
        capabilities: {
          // inputModalities 缺失表示未知：按不支持处理，宁可拦住也不误发图片
          vision: Array.isArray(model.inputModalities) && model.inputModalities.includes('image'),
          json: true,
        },
      });
    }
  }

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  const attachments = ctx.get('attachments');
  const imageLimits = attachments?.imageLimits;
  res.end(JSON.stringify({
    models,
    failures,
    // 图片大小/格式上限以宿主能力为准，由 UI 显示并在选图时校验
    ...(imageLimits ? { imageLimits } : {}),
  }));
}

/**
 * 原生技能目录，只允许本仓库 skills/ 下的条目。
 * ctx.skills 可能同时包含项目、用户和自定义根；面板不消费仓库之外的技能。
 */
async function handleSkills(ctx, root, res) {
  const registry = ctx.get('skills');
  if (!registry?.list || !registry?.get) {
    throw new ApiError(501, 'SKILLS_UNAVAILABLE', '当前 dsh 宿主未提供技能注册表');
  }

  const skillsRoot = path.resolve(root, 'skills');
  let summaries;
  try {
    summaries = await registry.list({ cwd: root });
  } catch (error) {
    ctx.logger.warn('comfyui-prompt skill discovery failed: %s', redactSecrets(error.message));
    throw new ApiError(502, 'SKILLS_UNAVAILABLE', 'dsh 技能目录读取失败');
  }

  const failures = [];
  const skills = [];
  await Promise.all(
    summaries
      .filter((summary) => isPathInside(skillsRoot, summary.path))
      .map(async (summary) => {
        try {
          const skill = await registry.get(summary.name, { cwd: root });
          if (!skill || !isPathInside(skillsRoot, skill.path)) {
            failures.push(summary.name);
            return;
          }
          skills.push({
            name: skill.name,
            description: skill.description ?? '',
            whenToUse: skill.whenToUse ?? '',
            content: skill.content,
            metadata: skill.metadata ?? {},
          });
        } catch (error) {
          ctx.logger.warn('comfyui-prompt skill load failed (%s): %s', summary.name, redactSecrets(error.message));
          failures.push(summary.name);
        }
      }),
  );

  skills.sort((a, b) => a.name.localeCompare(b.name));
  failures.sort();
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({
    skills,
    failures,
    ...(skills.length ? {} : {
      hint: `未发现 ${skillsRoot} 下的技能；请确认 dsh skill-filesystem 的 customSkillDirs 包含该目录。`,
    }),
  }));
}

async function loadRepoSkill(ctx, root, name) {
  if (typeof name !== 'string' || !name) {
    throw new TaskError('SKILL_NOT_FOUND', { message: '尚未选择技能' });
  }
  const registry = ctx.get('skills');
  if (!registry?.get) throw new TaskError('SKILL_NOT_FOUND', { message: '宿主未提供技能注册表' });
  const skill = await registry.get(name, { cwd: root });
  if (!skill || !isPathInside(path.resolve(root, 'skills'), skill.path)) {
    throw new TaskError('SKILL_NOT_FOUND', { message: `技能 ${name} 不属于本仓库` });
  }
  return skill;
}

/** 单次生成：服务端完成输入校验、技能加载、消息组装、调用与三段解析。 */
async function handleGenerate(ctx, req, res, { root, systemPrompt }) {
  // 只接受 JSON：application/json 不属于 CORS 简单请求，跨站表单无法直接触发模型调用。
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new ApiError(415, 'CONTENT_TYPE_UNSUPPORTED', '请求必须使用 application/json');
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  let finished = false;
  const abort = () => {
    if (!finished) controller.abort();
  };
  req.on('aborted', abort);
  req.on('error', abort);
  res.on('close', abort);

  let text = '';
  let blockHasDelta = false;
  const chunkCounts = {};
  let finishReason = null;
  try {
    // 宿主图片上限可能是 50 MB；base64 会膨胀约 4/3，再留一点 JSON 开销。
    const body = await readJsonBody(req, 80 * 1024 * 1024);
    if (controller.signal.aborted) throw new ApiError(499, 'CANCELLED', '客户端已取消');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(400, 'INPUT_INVALID', '请求体必须是 JSON 对象');
    }

    const mode = body.mode === 'image' ? 'image' : 'text';
    const userText = typeof body.text === 'string' ? body.text : '';
    const image = body.image && typeof body.image === 'object' ? body.image : null;
    if (mode === 'text' && !userText.trim()) {
      throw new TaskError('INPUT_EMPTY', { hint: '请先输入需要整理的描述。' });
    }
    if (mode === 'image') {
      if (!image?.dataUrl || !image?.mimeType) {
        throw new TaskError('INPUT_EMPTY', { hint: '请选择一张图片后再生成。' });
      }
      if (!SUPPORTED_IMAGE_TYPES.includes(image.mimeType)) {
        throw new TaskError('INPUT_IMAGE_FORMAT', {
          message: `不支持的图片格式：${image.mimeType}`,
        });
      }
    }

    const [providerId, ...rest] = String(body.modelId ?? '').split('::');
    const model = rest.join('::');
    if (!providerId || !model) {
      throw new TaskError('MODEL_REQUIRED', {
        message: 'modelId 必须是 "<provider>::<model>" 形式',
      });
    }

    const skill = await loadRepoSkill(ctx, root, body.skillName);
    const prompt = await toDshRequest(
      ctx,
      buildMessages({ mode, text: userText, image, skill, systemPrompt }),
    );
    if (controller.signal.aborted) throw new TaskError('CANCELLED');

    for await (const chunk of ctx.llm.stream({
      provider: providerId,
      model,
      system: prompt.system,
      messages: prompt.messages,
      signal: controller.signal,
      purpose: 'prompt-enhance',
    })) {
      // 调试日志只统计类型与终止原因，不记录任何模型输入输出内容。
      chunkCounts[chunk.type] = (chunkCounts[chunk.type] ?? 0) + 1;
      if (chunk.type === 'block-start') {
        blockHasDelta = false;
      } else if (chunk.type === 'text-delta') {
        if (typeof chunk.text === 'string') text += chunk.text;
        blockHasDelta = true;
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
        if (!blockHasDelta && typeof chunk.block.text === 'string') text += chunk.block.text;
        blockHasDelta = false;
      } else if (chunk.type === 'finish') {
        finishReason = chunk.reason ?? null;
        break;
      }
    }

    // dsh 的 stream 把适配器与调用失败转成终止 chunk，而不是抛出异常。
    if (finishReason?.kind === 'error') {
      const failure = finishReason.failure ?? {};
      throw new TaskError('MODEL_ERROR', {
        message: failure.message ?? '模型调用失败',
        details: failure.code ? [`宿主错误码：${failure.code}`] : [],
      });
    }
    if (finishReason?.kind === 'aborted') throw new TaskError('CANCELLED');
    if (!finishReason) throw new TaskError('MODEL_ERROR', { message: '模型响应流不完整：缺少 finish 终止块' });
    if (!text) {
      ctx.logger.warn(
        'comfyui-prompt: stream finished without text (provider=%s model=%s chunks=%s finish=%s)',
        providerId,
        model,
        JSON.stringify(chunkCounts),
        finishReason.kind ?? 'none',
      );
      throw new TaskError('MODEL_ERROR', { message: '模型没有返回文本内容' });
    }
    if (controller.signal.aborted) throw new TaskError('CANCELLED');

    const result = extractResult(parseStructuredOutput(text));
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({
      result,
      meta: {
        mode,
        modelId: `${providerId}::${model}`,
        skillName: skill.name,
        llmCalls: 1,
        durationMs: Date.now() - startedAt,
      },
    }));
  } finally {
    finished = true;
    req.off('aborted', abort);
    req.off('error', abort);
    res.off('close', abort);
  }
}

/**
 * buildMessages 产出 -> dsh 请求：system 消息合并进 options.system，
 * user 消息保持原样；图片部件经 attachments 服务转成附件引用。
 */
async function toDshRequest(ctx, raw) {
  const systemParts = [];
  const conversation = [];

  for (const message of raw) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    const parts = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;
    const content = [];
    for (const part of parts) {
      content.push(part.type === 'image' ? await admitImage(ctx, part) : { type: 'text', text: part.text });
    }
    conversation.push({ role: 'user', content });
  }

  return { system: systemParts.join('\n\n---\n\n'), messages: conversation };
}

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * 把 UI 传来的 data URL 图片存入 dsh 附件服务，返回 image 内容块。
 * 只有宿主声明了 attachments 服务时才可用；否则明确拒绝，绝不换 Provider 重试。
 */
async function admitImage(ctx, part) {
  const attachments = ctx.get('attachments');
  if (!attachments?.saveImage) {
    throw new TaskError('VISION_UNSUPPORTED', {
      message: '当前 dsh 宿主未提供附件服务（attachments），图片反推不可用。',
    });
  }

  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(String(part.dataUrl ?? ''));
  if (!match) throw new TaskError('INPUT_IMAGE_FORMAT', { message: '图片必须是 base64 data URL' });
  const dataMediaType = match[1].toLowerCase();
  const mediaType = String(part.mimeType ?? dataMediaType).toLowerCase();
  if (mediaType !== dataMediaType) {
    throw new TaskError('INPUT_IMAGE_FORMAT', { message: '图片 mimeType 与 data URL 声明不一致' });
  }
  const limits = attachments.imageLimits;
  const hostAllowsType = !Array.isArray(limits?.mediaTypes)
    || !limits.mediaTypes.length
    || limits.mediaTypes.includes(mediaType);
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType) || !hostAllowsType) {
    throw new TaskError('INPUT_IMAGE_FORMAT', { message: `不支持的图片格式：${mediaType}` });
  }

  const encoded = match[2];
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new TaskError('INPUT_IMAGE_FORMAT', { message: '图片 base64 编码无效' });
  }
  const maxBytes = Number(limits?.maxImageBytes);
  const estimatedBytes = (encoded.length / 4) * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (Number.isFinite(maxBytes) && maxBytes > 0 && estimatedBytes > maxBytes) {
    throw new TaskError('INPUT_IMAGE_FORMAT', { message: `图片超过宿主上限 ${maxBytes} 字节` });
  }
  const data = Buffer.from(encoded, 'base64');
  if (!data.length) throw new TaskError('INPUT_IMAGE_FORMAT', { message: '图片内容为空' });

  try {
    const attachment = await attachments.saveImage({
      data,
      mediaType,
      name: typeof part.name === 'string' && part.name ? part.name : undefined,
    });
    return { type: 'image', attachment };
  } catch (error) {
    ctx.logger.warn('comfyui-prompt image save failed: %s', redactSecrets(error.message));
    throw new TaskError('INPUT_IMAGE_FORMAT', {
      message: '图片校验或存储失败，请检查图片格式、大小与宿主附件服务配置',
      details: error.code ? [`宿主错误码：${error.code}`] : [],
    });
  }
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体过大'));
      return;
    }

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(new ApiError(400, 'JSON_INVALID', `请求体不是合法 JSON：${error.message}`));
      }
    });
    req.on('aborted', () => reject(new ApiError(499, 'CANCELLED', '客户端已取消')));
    req.on('error', reject);
  });
}
