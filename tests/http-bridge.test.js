import test from 'node:test';
import assert from 'node:assert/strict';

import { createBridge } from '../src/host/http-bridge.js';
import { TaskError } from '../src/core/errors.js';

const MOUNT_URL = 'http://127.0.0.1:3081/comfyui-prompt/';

/** 临时替换 fetch，返回记录的调用 */
async function withFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });

test('读取服务端模型与技能目录', async () => {
  const models = [{ id: 'p::m', label: 'M', vision: true }];
  const skills = [{ name: 'sd-prompt', description: 'SD' }];
  await withFetch(
    (url) => ok(url.endsWith('/api/models')
      ? { models, imageLimits: { maxImageBytes: 1024 } }
      : { skills }),
    async (calls) => {
      const bridge = createBridge(MOUNT_URL);
      assert.deepEqual(await bridge.models(), { models, imageLimits: { maxImageBytes: 1024 } });
      assert.deepEqual(await bridge.skills(), { skills });
      assert.deepEqual(calls.map((call) => call.url), [`${MOUNT_URL}api/models`, `${MOUNT_URL}api/skills`]);
      assert.ok(calls.every((call) => call.options.method === 'GET'));
    },
  );
});

test('生成请求只发送输入、模型和技能名，并透传 AbortSignal', async () => {
  const controller = new AbortController();
  await withFetch(
    () => ok({ result: { prompt_en: 'A', translation_zh: '甲', notes: '' }, meta: {} }),
    async (calls) => {
      const output = await createBridge(MOUNT_URL).generate({
        mode: 'text',
        text: '一个女孩',
        image: null,
        modelId: 'p::m',
        skillName: 'sd-prompt',
        ignored: 'x',
      }, controller.signal);
      assert.equal(output.result.prompt_en, 'A');
      assert.equal(calls[0].url, `${MOUNT_URL}api/generate`);
      assert.equal(calls[0].options.signal, controller.signal);
      assert.deepEqual(Object.keys(JSON.parse(calls[0].options.body)).sort(),
        ['image', 'mode', 'modelId', 'skillName', 'text']);
    },
  );
});

test('服务端结构化错误保留 code、stage 和 details', async () => {
  await withFetch(
    () => ({
      ok: false,
      status: 422,
      json: async () => ({
        error: { code: 'MODEL_OUTPUT_INVALID', stage: 'validate', message: '字段非法', hint: '重试', details: ['缺少 notes'] },
      }),
    }),
    async () => {
      await assert.rejects(
        createBridge(MOUNT_URL).generate({ mode: 'text', text: 'x', modelId: 'p::m', skillName: 's' }),
        (error) => error instanceof TaskError
          && error.code === 'MODEL_OUTPUT_INVALID'
          && error.stage === 'validate'
          && error.details[0] === '缺少 notes',
      );
    },
  );
});

test('网络失败转成 HOST_ERROR，取消则原样抛出 AbortError', async () => {
  await withFetch(() => { throw new TypeError('fetch failed'); }, async () => {
    await assert.rejects(createBridge(MOUNT_URL).skills(), (error) => error.code === 'HOST_ERROR');
  });

  const controller = new AbortController();
  controller.abort();
  await withFetch(() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, async () => {
    await assert.rejects(
      createBridge(MOUNT_URL).generate({ mode: 'text', text: 'x', modelId: 'p::m', skillName: 's' }, controller.signal),
      (error) => error.name === 'AbortError',
    );
  });
});

test('响应结构不符合约定时报 HOST_ERROR', async () => {
  await withFetch(() => ok({ models: 'nope' }), async () => {
    await assert.rejects(createBridge(MOUNT_URL).models(), (error) => error.code === 'HOST_ERROR');
  });
  await withFetch(() => ok({ result: {} }), async () => {
    await assert.rejects(
      createBridge(MOUNT_URL).generate({ mode: 'text', text: 'x', modelId: 'p::m', skillName: 's' }),
      (error) => error.code === 'HOST_ERROR',
    );
  });
});
