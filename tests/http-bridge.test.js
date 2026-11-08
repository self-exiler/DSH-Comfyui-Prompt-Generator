import test from 'node:test';
import assert from 'node:assert/strict';

import { HttpHarnessAdapter, probeHttpHarness } from '../src/host/http-bridge.js';
import { TaskError } from '../src/core/errors.js';

const PAGE_URL = 'http://127.0.0.1:3081/comfyui-prompt/src/ui/index.html';
const MOUNT_URL = 'http://127.0.0.1:3081/comfyui-prompt/';

function withGlobals(run) {
  const originalFetch = globalThis.fetch;
  const hadLocation = Object.hasOwn(globalThis, 'location');
  const originalLocation = globalThis.location;
  globalThis.location = { href: PAGE_URL };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = originalFetch;
      if (hadLocation) globalThis.location = originalLocation;
      else delete globalThis.location;
    });
}

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  return calls;
}

test('HTTP 探测只请求 health', async () => {
  await withGlobals(async () => {
    const calls = stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }));
    const probe = await probeHttpHarness(1000);
    assert.ok(probe instanceof HttpHarnessAdapter);
    assert.equal(calls[0].url, `${MOUNT_URL}api/health`);
  });
});

test('HTTP 探测失败时返回 null', async () => {
  await withGlobals(async () => {
    stubFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));
    assert.equal(await probeHttpHarness(1000), null);
  });
});

test('读取服务端模型与技能目录', async () => {
  const adapter = new HttpHarnessAdapter(MOUNT_URL);
  const originalFetch = globalThis.fetch;
  const models = [{ id: 'p::m', label: 'M', capabilities: { vision: true } }];
  const skills = [{ name: 'sd-prompt', description: 'SD', content: '# SD' }];
  const calls = stubFetch((url) => ({
    ok: true,
    status: 200,
    json: async () => (url.endsWith('/api/models')
      ? { models, imageLimits: { maxImageBytes: 1024 } }
      : { skills, failures: [], hint: '' }),
  }));

  try {
    assert.deepEqual(await adapter.listModels(), models);
    assert.deepEqual(await adapter.listSkills(), { skills, failures: [], hint: '' });
    assert.equal(adapter.imageLimits.maxImageBytes, 1024);
    assert.ok(calls.every((call) => call.options.method === 'GET'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('生成请求只发送输入、模型和技能名', async () => {
  const adapter = new HttpHarnessAdapter(MOUNT_URL);
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: { prompt_en: 'A', translation_zh: '甲', notes: '' }, meta: { llmCalls: 1 } }),
    };
  };

  try {
    const output = await adapter.generate({
      mode: 'text',
      text: '一个女孩',
      image: null,
      modelId: 'p::m',
      skillName: 'sd-prompt',
    });
    assert.equal(output.result.prompt_en, 'A');
    assert.equal(captured.url, `${MOUNT_URL}api/generate`);
    assert.deepEqual(Object.keys(captured.body).sort(), ['image', 'mode', 'modelId', 'skillName', 'text']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('服务端结构化错误保留 code、stage 和 details', async () => {
  const adapter = new HttpHarnessAdapter(MOUNT_URL);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 422,
    json: async () => ({
      error: {
        code: 'MODEL_OUTPUT_INVALID',
        stage: 'validate',
        message: '字段非法',
        hint: '重试',
        details: ['缺少 notes'],
      },
    }),
  });

  try {
    await assert.rejects(
      adapter.generate({ mode: 'text', text: 'x', modelId: 'p::m', skillName: 's' }),
      (error) => error instanceof TaskError
        && error.code === 'MODEL_OUTPUT_INVALID'
        && error.stage === 'validate'
        && error.details[0] === '缺少 notes',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
