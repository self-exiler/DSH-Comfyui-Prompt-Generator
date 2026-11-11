import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Readable } from 'node:stream';

import { apply } from '../plugins/comfyui-prompt/lib/plugin.js';
import { ROOT, VALID_OUTPUT } from './helpers.js';

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.body = '';
    this.writableEnded = false;
    this.destroyed = false;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    Object.assign(this.headers, headers);
    return this;
  }

  end(chunk) {
    if (chunk) this.body += String(chunk);
    this.writableEnded = true;
    return this;
  }

  json() {
    return JSON.parse(this.body);
  }
}

const repoSkillPath = path.join(ROOT, 'skills', 'sd-prompt', 'SKILL.md');
const defaultSkill = {
  name: 'sd-prompt',
  description: 'SD 提示词',
  content: '# SD\n使用逗号分隔标签。',
  path: repoSkillPath,
};

function createApi({
  chunks,
  stream,
  saveImage,
  imageLimits,
  skills,
  systemPrompt = 'SYSTEM CONTRACT',
} = {}) {
  const routes = [];
  const warnings = [];
  const calls = { stream: 0, saveImage: 0, streamArgs: null };
  const skillService = skills === null ? null : skills ?? {
    list: async () => [{ name: defaultSkill.name, description: defaultSkill.description, path: repoSkillPath }],
    get: async () => defaultSkill,
  };

  const ctx = {
    llm: {
      listProviders: () => [],
      async listModels() { return []; },
      async *stream(args) {
        calls.stream += 1;
        calls.streamArgs = args;
        if (stream) {
          yield* stream(args);
          return;
        }
        for (const chunk of chunks ?? [
          { type: 'text-delta', text: JSON.stringify(VALID_OUTPUT) },
          { type: 'finish', reason: { kind: 'stop' } },
        ]) yield chunk;
      },
    },
    logger: {
      info() {},
      warn(...args) { warnings.push(args.join(' ')); },
    },
    effect: (callback) => callback(),
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    get(key) {
      if (key === 'skills') return skillService;
      if (key !== 'attachments') return null;
      return {
        imageLimits,
        async saveImage() {
          calls.saveImage += 1;
          if (saveImage) return saveImage();
          return { id: 'image-1' };
        },
      };
    },
  };

  apply(ctx, { systemPrompt });
  return {
    handler: routes.find((route) => route.path.endsWith('/api')).handler,
    staticHandler: routes.find((route) => !route.path.endsWith('/api')).handler,
    calls,
    warnings,
  };
}

function generationBody(overrides = {}) {
  return {
    mode: 'text',
    text: '一个女孩在雨中',
    image: null,
    modelId: 'provider::model',
    skillName: 'sd-prompt',
    ...overrides,
  };
}

function startRequest(handler, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Object.assign(Readable.from(chunks), {
    method: 'POST',
    url: '/comfyui-prompt/api/generate',
    headers: { 'content-type': 'application/json', ...headers },
  });
  req.resume = () => { req.resumed = true; };
  const res = new MockResponse();
  return { pending: handler(req, res), req, res };
}

async function generate(handler, body, headers) {
  const { pending, res } = startRequest(handler, body, headers);
  await pending;
  return res;
}

async function get(handler, pathname, method = 'GET') {
  const req = new EventEmitter();
  req.method = method;
  req.url = `/comfyui-prompt${pathname}`;
  req.headers = {};
  const res = new MockResponse();
  await handler(req, res);
  return res;
}

const getJson = get;

test('服务端一次生成返回三段结果与元数据', async () => {
  const { handler, calls } = createApi();
  const res = await generate(handler, generationBody());
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().result, VALID_OUTPUT);
  assert.equal(res.json().meta.skillName, 'sd-prompt');
  assert.equal(calls.stream, 1);
  assert.match(calls.streamArgs.system, /SYSTEM CONTRACT/);
  assert.match(calls.streamArgs.system, /使用逗号分隔标签/);
  assert.match(calls.streamArgs.messages[0].content[0].text, /一个女孩在雨中/);
});

test('空文本、缺少模型和缺失技能不会调用模型', async () => {
  const cases = [
    { body: generationBody({ text: '   ' }), status: 400, code: 'INPUT_EMPTY' },
    { body: generationBody({ modelId: '' }), status: 400, code: 'MODEL_REQUIRED' },
    { body: generationBody({ skillName: '' }), status: 404, code: 'SKILL_NOT_FOUND' },
  ];
  for (const item of cases) {
    const { handler, calls } = createApi();
    const res = await generate(handler, item.body);
    assert.equal(res.statusCode, item.status);
    assert.equal(res.json().error.code, item.code);
    assert.equal(calls.stream, 0);
  }
});

test('不在本仓库 skills/ 下的技能不能用于生成', async () => {
  const { handler, calls } = createApi({
    skills: {
      list: async () => [],
      get: async () => ({ ...defaultSkill, path: path.join(ROOT, '..', 'user', 'SKILL.md') }),
    },
  });
  const res = await generate(handler, generationBody());
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'SKILL_NOT_FOUND');
  assert.equal(calls.stream, 0);
});

test('图片模式经附件服务转换后才进入模型消息', async () => {
  const { handler, calls } = createApi();
  const res = await generate(handler, generationBody({
    mode: 'image',
    image: { dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png' },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.saveImage, 1);
  assert.ok(calls.streamArgs.messages[0].content.some((part) => part.type === 'image'));
});

test('图片 MIME 不匹配或 base64 非法时拒绝', async () => {
  const cases = [
    { dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/jpeg' },
    { dataUrl: 'data:image/png;base64,!!!', mimeType: 'image/png' },
  ];
  for (const image of cases) {
    const { handler, calls } = createApi();
    const res = await generate(handler, generationBody({ mode: 'image', image }));
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'INPUT_IMAGE_FORMAT');
    assert.equal(calls.saveImage, 0);
    assert.equal(calls.stream, 0);
  }
});

test('插件按 Content-Length 拒绝超限请求并排空连接', async () => {
  const { handler, calls } = createApi();
  const { pending, req, res } = startRequest(handler, undefined, {
    'content-length': String(81 * 1024 * 1024),
  });
  await pending;
  assert.equal(res.statusCode, 413);
  assert.equal(req.resumed, true);
  assert.equal(calls.stream, 0);
});

test('聚合多个文本块且拒绝缺少 finish 的半截流', async () => {
  const { handler } = createApi({
    chunks: [
      { type: 'block-start' },
      { type: 'block-end', block: { type: 'text', text: '{"prompt_en":"A",' } },
      { type: 'block-start' },
      { type: 'text-delta', text: '"translation_zh":"甲","notes":""}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  });
  const ok = await generate(handler, generationBody());
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().result.prompt_en, 'A');

  const partial = createApi({ chunks: [{ type: 'text-delta', text: 'partial' }] });
  const failed = await generate(partial.handler, generationBody());
  assert.equal(failed.statusCode, 502);
  assert.match(failed.json().error.message, /缺少 finish/);
});

test('模型流错误映射为 MODEL_ERROR，未知异常不泄露原文', async () => {
  const finishError = createApi({
    chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota', code: '429' } } }],
  });
  const res = await generate(finishError.handler, generationBody());
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error.code, 'MODEL_ERROR');

  const unknown = createApi({
    stream: async function* () {
      throw new Error('Authorization: Bearer abcdefgh12345678');
    },
  });
  const crashed = await generate(unknown.handler, generationBody());
  assert.equal(crashed.statusCode, 500);
  assert.equal(crashed.json().error.message, '宿主内部处理失败');
  assert.ok(!crashed.body.includes('abcdefgh12345678'));
  assert.ok(!unknown.warnings.join('\n').includes('abcdefgh12345678'));
});

test('技能目录只返回仓库 skills/ 下的原生技能，且不下发正文', async () => {
  const { handler } = createApi({
    skills: {
      list: async () => [
        { name: 'sd-prompt', description: 'SD', path: repoSkillPath },
        { name: 'user-only', description: '用户技能', path: path.join(ROOT, '..', 'user-skills', 'SKILL.md') },
      ],
      get: async () => defaultSkill,
    },
  });
  const res = await getJson(handler, '/api/skills');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().skills, [{ name: 'sd-prompt', description: 'SD' }]);
  assert.ok(!res.body.includes(defaultSkill.content));
});

test('模型目录聚合各 provider，单个 provider 失败不影响其余', async () => {
  // createApi 的默认 llm 没有 provider；这里单独挂一个多 provider 的 llm
  const warnings = [];
  const routes = [];
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'a', name: 'A' }, { id: 'bad' }, { id: 'c' }],
      async listModels(id) {
        if (id === 'bad') throw new Error('timeout token=secretsecret');
        return [{ id: 'm1', name: 'M1', inputModalities: id === 'a' ? ['text', 'image'] : ['text'] }];
      },
    },
    logger: { info() {}, warn(...args) { warnings.push(args.join(' ')); } },
    effect: (callback) => callback(),
    webServer: { register(route) { routes.push(route); return () => {}; } },
    get: () => null,
  };
  apply(ctx, { systemPrompt: 'S' });
  const res = await getJson(routes.find((route) => route.path.endsWith('/api')).handler, '/api/models');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().models, [
    { id: 'a::m1', label: 'M1 · A', vision: true },
    { id: 'c::m1', label: 'M1 · c', vision: false },
  ]);
  assert.ok(!warnings.join('\n').includes('secretsecret'));
});

test('静态资源只放行 src/，拒绝穿越、隐藏文件与非 GET', async () => {
  const { staticHandler } = createApi();
  const page = await get(staticHandler, '/');
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['Content-Type'], /text\/html/);
  assert.equal((await get(staticHandler, '/src/ui/app.js')).statusCode, 200);

  for (const blocked of [
    '/prompts/system.md',
    '/package.json',
    '/skills/sd-prompt/SKILL.md',
    '/src/%2e%2e/package.json',
    '/src/%5C..%5Cpackage.json',
    '/src/..%2F..%2Fpackage.json',
    '/src/.hidden',
    '/src/ui/missing.js',
  ]) {
    assert.equal((await get(staticHandler, blocked)).statusCode, 404, blocked);
  }
  assert.equal((await get(staticHandler, '/', 'POST')).statusCode, 405);
});

test('响应结束前连接关闭会取消宿主调用', async () => {
  let aborted = false;
  const { handler, calls } = createApi({
    stream: async function* ({ signal }) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      aborted = true;
      yield { type: 'finish', reason: { kind: 'aborted' } };
    },
  });
  const { pending, res } = startRequest(handler, generationBody());
  while (calls.stream === 0) await new Promise((resolve) => setImmediate(resolve));
  res.emit('close');
  await pending;
  assert.equal(aborted, true);
  assert.equal(res.json().error.code, 'CANCELLED');
});

test('请求体不是 JSON 对象或 Content-Type 不对时拒绝', async () => {
  const { handler, calls } = createApi();
  assert.equal((await generate(handler, '{broken')).json().error.code, 'BODY_INVALID');
  assert.equal((await generate(handler, '[]')).json().error.code, 'BODY_INVALID');
  const wrongType = await generate(handler, generationBody(), { 'content-type': 'text/plain' });
  assert.equal(wrongType.statusCode, 415);
  assert.equal(calls.stream, 0);
});

test('技能注册表缺席时返回明确的不可用错误', async () => {
  const { handler } = createApi({ skills: null });
  const res = await getJson(handler, '/api/skills');
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().error.code, 'SKILLS_UNAVAILABLE');
});
