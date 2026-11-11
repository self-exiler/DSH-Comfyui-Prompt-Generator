/**
 * comfyui-prompt-tool — dsh (cordis) 插件服务端
 *
 * 1. 把 src/ 下的 WebView 以静态资源方式挂在 web profile 的 HTTP 服务上；
 * 2. 提供 /api/models、/api/skills 与 /api/generate：
 *    - models 来自 ctx.llm；
 *    - skills 只暴露本仓库 skills/ 下的原生技能；
 *    - generate 在服务端完成提示词组装、图片入库、单次模型调用与三段解析。
 * 3. 不读取、不存储任何密钥；凭据完全由宿主的 provider 适配器复用。
 *
 * 图片经宿主附件服务（ctx.attachments.saveImage）转成附件引用再交给 ctx.llm；
 * 宿主不可用时明确返回 VISION_UNSUPPORTED，不静默改道到其他 Provider。
 */

import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskError, redactSecrets } from '../../../src/core/errors.js';
import { IMAGE_TYPES, buildPrompt } from '../../../src/core/prompt.js';
import { extractResult, parseStructuredOutput } from '../../../src/core/task.js';
import { createRepoSkillProvider, isPathInside } from './repo-skills.js';

export const name = 'comfyui-prompt-tool';

export const inject = ['webServer', 'llm'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const DEFAULT_PREFIX = '/comfyui-prompt';
/** 宿主图片上限可能是 50 MB；base64 膨胀约 4/3，再留一点 JSON 开销。 */
const MAX_BODY_BYTES = 80 * 1024 * 1024;
/** 插件位于 <仓库>/plugins/comfyui-prompt/lib，仓库根在其上三级 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function apply(ctx, config = {}) {
  const root = path.resolve(config.root ?? REPO_ROOT);
  const prefix = `/${(config.prefix ?? DEFAULT_PREFIX).replace(/^\/+|\/+$/g, '')}`;
  const systemPrompt = resolveSystemPrompt(ctx, config, root);

  // 路由必须挂在 ctx.effect 上：插件被卸载 / HMR 重载时由 cordis 自动注销。
  // 直接返回 dispose 函数不会被加载器调用，旧路由会残留并触发 "duplicate prefix route"。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: prefix,
      handler: (req, res) => serveStatic(req, res, { root, prefix }),
    }),
    `comfyui-prompt: webview ${prefix}`,
  );

  // 最长前缀匹配：/api 优先于上面的整目录路由
  ctx.effect(
    () => ctx.webServer.register({
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

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/* ------------------------------------------------------------------ 静态资源 */

/**
 * 浏览器只加载 src/ 下的页面与模块；系统提示词只由服务端 fs 读取，
 * 技能正文不下发浏览器，二者均不作为静态资源暴露。
 */
async function serveStatic(req, res, { root, prefix }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let relative;
  try {
    relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(prefix.length) || '/';
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (relative === '/') relative = '/src/ui/index.html';

  // 编码后的反斜杠 / .. 在解码后才出现，所以按两种分隔符切分；
  // 任何以 "." 开头的片段（. / .. / 隐藏文件）一律拒绝，因此拼接结果不可能逃出 root。
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  if (segments[0] !== 'src' || segments.some((segment) => segment.startsWith('.'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }

  try {
    let file = path.join(root, ...segments);
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
}

/* ------------------------------------------------------------------ 桥接 API */

async function serveApi(req, res, { ctx, prefix, root, systemPrompt }) {
  const route = new URL(req.url, 'http://localhost').pathname.slice(prefix.length);
  try {
    if (route === '/api/models' && req.method === 'GET') return await handleModels(ctx, res);
    if (route === '/api/skills' && req.method === 'GET') return await handleSkills(ctx, root, res);
    if (route === '/api/generate' && req.method === 'POST') {
      return await handleGenerate(ctx, req, res, { root, systemPrompt });
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `未知端点 ${route}` } });
  } catch (error) {
    if (res.writableEnded || res.destroyed) return;
    ctx.logger.warn('comfyui-prompt api error: %s', redactSecrets(error.message));
    if (error instanceof TaskError) {
      sendJson(res, error.status, { error: error.toJSON() });
    } else {
      // 未知异常不把原文返回给浏览器
      sendJson(res, 500, { error: { code: 'HOST_ERROR', message: '宿主内部处理失败' } });
    }
  }
}

/** 模型目录来自 ctx.llm，插件不维护模型清单。各 provider 并行查询，单个失败不拖累整体。 */
async function handleModels(ctx, res) {
  const lists = await Promise.all(
    ctx.llm.listProviders().map(async (info) => {
      try {
        return (await ctx.llm.listModels(info.id)).map((model) => ({
          id: `${info.id}::${model.id}`,
          label: `${model.name} · ${info.name ?? info.id}`,
          // inputModalities 缺失表示未知：按不支持处理，宁可拦住也不误发图片
          vision: Array.isArray(model.inputModalities) && model.inputModalities.includes('image'),
        }));
      } catch (error) {
        ctx.logger.warn('comfyui-prompt model list failed (%s): %s', info.id, redactSecrets(error.message));
        return [];
      }
    }),
  );
  const imageLimits = ctx.get('attachments')?.imageLimits;
  sendJson(res, 200, { models: lists.flat(), ...(imageLimits ? { imageLimits } : {}) });
}

/**
 * 原生技能目录，只允许本仓库 skills/ 下的条目（ctx.skills 还可能含项目、用户和自定义根）。
 * 只返回名称与简介：技能正文在生成时由服务端按名称加载，不下发浏览器。
 */
async function handleSkills(ctx, root, res) {
  const registry = ctx.get('skills');
  if (!registry?.list) throw new TaskError('SKILLS_UNAVAILABLE');

  const skillsRoot = path.resolve(root, 'skills');
  let summaries;
  try {
    summaries = await registry.list({ cwd: root });
  } catch (error) {
    ctx.logger.warn('comfyui-prompt skill discovery failed: %s', redactSecrets(error.message));
    throw new TaskError('SKILLS_UNAVAILABLE', { message: 'dsh 技能目录读取失败', status: 502 });
  }

  const skills = summaries
    .filter((summary) => isPathInside(skillsRoot, summary.path))
    .map(({ name: skillName, description }) => ({ name: skillName, description: description ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  sendJson(res, 200, {
    skills,
    ...(skills.length ? {} : {
      hint: `未发现 ${skillsRoot} 下的技能；请确认 dsh skill-filesystem 的 customSkillDirs 包含该目录。`,
    }),
  });
}

async function loadRepoSkill(ctx, root, skillName) {
  if (typeof skillName !== 'string' || !skillName) {
    throw new TaskError('SKILL_NOT_FOUND', { message: '尚未选择技能' });
  }
  const registry = ctx.get('skills');
  if (!registry?.get) throw new TaskError('SKILL_NOT_FOUND', { message: '宿主未提供技能注册表' });
  const skill = await registry.get(skillName, { cwd: root });
  if (!skill || !isPathInside(path.resolve(root, 'skills'), skill.path)) {
    throw new TaskError('SKILL_NOT_FOUND', { message: `技能 ${skillName} 不属于本仓库` });
  }
  return skill;
}

/** 单次生成：服务端完成输入校验、技能加载、提示词组装、调用与三段解析。 */
async function handleGenerate(ctx, req, res, { root, systemPrompt }) {
  // 只接受 JSON：application/json 不属于 CORS 简单请求，跨站表单无法直接触发模型调用。
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new TaskError('CONTENT_TYPE_UNSUPPORTED');
  }

  // 响应还没写完就关闭连接 = 客户端取消，把取消传给宿主
  const controller = new AbortController();
  const { signal } = controller;
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const throwIfCancelled = () => {
    if (signal.aborted) throw new TaskError('CANCELLED');
  };

  const startedAt = Date.now();
  const body = await readJsonBody(req);
  throwIfCancelled();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TaskError('BODY_INVALID');

  const mode = body.mode === 'image' ? 'image' : 'text';
  const text = typeof body.text === 'string' ? body.text : '';
  if (mode === 'text' && !text.trim()) {
    throw new TaskError('INPUT_EMPTY', { hint: '请先输入需要整理的描述。' });
  }
  if (mode === 'image' && !body.image?.dataUrl) {
    throw new TaskError('INPUT_EMPTY', { hint: '请选择一张图片后再生成。' });
  }

  const [providerId, ...rest] = String(body.modelId ?? '').split('::');
  const model = rest.join('::');
  if (!providerId || !model) {
    throw new TaskError('MODEL_REQUIRED', { message: 'modelId 必须是 "<provider>::<model>" 形式' });
  }

  const skill = await loadRepoSkill(ctx, root, body.skillName);
  const prompt = buildPrompt({ mode, text, skill, systemPrompt });
  const content = [{ type: 'text', text: prompt.user }];
  if (mode === 'image') content.push(await admitImage(ctx, body.image));
  throwIfCancelled();

  let output = '';
  let blockHasDelta = false;
  let finish = null;
  for await (const chunk of ctx.llm.stream({
    provider: providerId,
    model,
    system: prompt.system,
    messages: [{ role: 'user', content }],
    signal,
    purpose: 'prompt-enhance',
  })) {
    if (chunk.type === 'block-start') {
      blockHasDelta = false;
    } else if (chunk.type === 'text-delta') {
      if (typeof chunk.text === 'string') output += chunk.text;
      blockHasDelta = true;
    } else if (chunk.type === 'block-end') {
      // 不流式输出增量的宿主只在 block-end 里给整块文本
      if (chunk.block?.type === 'text' && !blockHasDelta && typeof chunk.block.text === 'string') {
        output += chunk.block.text;
      }
    } else if (chunk.type === 'finish') {
      finish = chunk.reason ?? {};
      break;
    }
  }

  // dsh 的 stream 把适配器与调用失败转成终止 chunk，而不是抛出异常。
  if (finish?.kind === 'error') {
    const failure = finish.failure ?? {};
    throw new TaskError('MODEL_ERROR', {
      message: failure.message ?? '模型调用失败',
      details: failure.code ? [`宿主错误码：${failure.code}`] : [],
    });
  }
  if (finish?.kind === 'aborted') throw new TaskError('CANCELLED');
  if (!finish) throw new TaskError('MODEL_ERROR', { message: '模型响应流不完整：缺少 finish 终止块' });
  if (!output) {
    // 只记录终止原因，不记录任何模型输入输出内容
    ctx.logger.warn('comfyui-prompt: stream finished without text (provider=%s model=%s finish=%s)',
      providerId, model, finish.kind ?? 'none');
    throw new TaskError('MODEL_ERROR', { message: '模型没有返回文本内容' });
  }
  throwIfCancelled();

  sendJson(res, 200, {
    result: extractResult(parseStructuredOutput(output)),
    meta: {
      mode,
      modelId: `${providerId}::${model}`,
      skillName: skill.name,
      durationMs: Date.now() - startedAt,
    },
  });
}

/**
 * 把 UI 传来的 data URL 图片存入 dsh 附件服务，返回 image 内容块。
 * 只有宿主声明了 attachments 服务时才可用；否则明确拒绝，绝不换 Provider 重试。
 */
async function admitImage(ctx, image) {
  const attachments = ctx.get('attachments');
  if (!attachments?.saveImage) {
    throw new TaskError('VISION_UNSUPPORTED', {
      message: '当前 dsh 宿主未提供附件服务（attachments），图片反推不可用。',
    });
  }

  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(image.dataUrl));
  if (!match) throw new TaskError('INPUT_IMAGE_FORMAT', { message: '图片必须是有效的 base64 data URL' });
  const mediaType = match[1].toLowerCase();
  const encoded = match[2];
  if (image.mimeType !== undefined && String(image.mimeType).toLowerCase() !== mediaType) {
    throw new TaskError('INPUT_IMAGE_FORMAT', { message: '图片 mimeType 与 data URL 声明不一致' });
  }

  const { mediaTypes, maxImageBytes } = attachments.imageLimits ?? {};
  const hostAllows = !Array.isArray(mediaTypes) || !mediaTypes.length || mediaTypes.includes(mediaType);
  if (!IMAGE_TYPES.includes(mediaType) || !hostAllows) {
    throw new TaskError('INPUT_IMAGE_FORMAT', { message: `不支持的图片格式：${mediaType}` });
  }
  if (encoded.length % 4 !== 0) throw new TaskError('INPUT_IMAGE_FORMAT', { message: '图片 base64 编码无效' });
  const bytes = (encoded.length / 4) * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (Number(maxImageBytes) > 0 && bytes > Number(maxImageBytes)) {
    throw new TaskError('INPUT_IMAGE_FORMAT', { message: `图片超过宿主上限 ${maxImageBytes} 字节` });
  }

  try {
    const attachment = await attachments.saveImage({
      data: Buffer.from(encoded, 'base64'),
      mediaType,
      name: typeof image.name === 'string' && image.name ? image.name : undefined,
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

async function readJsonBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    req.resume();
    throw new TaskError('PAYLOAD_TOO_LARGE');
  }
  // 超限后继续读完并丢弃，而不是中途 break：break 会销毁 socket，客户端就收不到 413。
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    else chunks.length = 0;
  }
  if (size > MAX_BODY_BYTES) throw new TaskError('PAYLOAD_TOO_LARGE');
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new TaskError('BODY_INVALID', { message: `请求体不是合法 JSON：${error.message}` });
  }
}
