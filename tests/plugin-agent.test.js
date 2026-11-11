import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../plugins/comfyui-prompt/lib/plugin.js';
import { LIST_TOOL, READ_TOOL } from '../plugins/comfyui-prompt/lib/skill-resources.js';
import { startRequest, VALID_OUTPUT } from './helpers.js';

const SKILL_NAME = 'moss-image-prompt-enhancer';

function createHarness() {
  const routes = [];
  const listeners = new Map();
  const captures = { stream: 0, tools: [], restrict: null, section: null, disposed: false };

  const emit = (name, ...args) => {
    for (const listener of listeners.get(name) ?? []) listener(...args);
  };

  const agents = {
    async create(options) {
      captures.create = options;
      const agentCtx = {
        systemPrompt: {
          section(section) { captures.section = section; },
          suppressRuntimeContext() {},
        },
        tools: {
          register(definition) { captures.tools.push(definition); return () => {}; },
          definitions: () => [{ name: 'read' }, { name: 'write' }, { name: 'bash' }],
          restrict(filter) { captures.restrict = filter; },
        },
      };
      await options.setup(agentCtx);
      return {
        agent: {
          session: { id: options.sessionId },
          followup() {
            emit('session/event', { id: options.sessionId }, {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: JSON.stringify(VALID_OUTPUT) }] } },
            });
            emit('session/event', { id: options.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
          },
          async whenIdle() {},
          cancel() {},
        },
        async dispose() { captures.disposed = true; },
      };
    },
  };

  const ctx = {
    llm: {
      listProviders: () => [],
      async listModels() { return []; },
      async *stream() {
        captures.stream += 1;
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    logger: { info() {}, warn() {} },
    effect: (callback) => callback(),
    webServer: {
      register(route) { routes.push(route); return () => {}; },
    },
    get(name) {
      if (name === 'agents') return agents;
      if (name === 'tools') return { register() {} };
      if (name === 'systemPrompt') return { section() {} };
      if (name === 'skills') return { registerProvider() {} };
      return null;
    },
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
      return () => {
        const list = listeners.get(name) ?? [];
        const index = list.indexOf(listener);
        if (index !== -1) list.splice(index, 1);
      };
    },
  };

  apply(ctx, { systemPrompt: 'SYSTEM CONTRACT' });
  return { handler: routes.find((route) => route.path.endsWith('/api')).handler, captures };
}

test('默认生成走后台受限 Agent，不调用 ctx.llm.stream 且把资源清单放进系统提示词', async () => {
  const { handler, captures } = createHarness();
  const { pending, res } = startRequest(handler, {
    mode: 'text',
    text: '做一个海报',
    image: null,
    modelId: 'provider::model',
    skillName: SKILL_NAME,
  });
  await pending;

  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().result, VALID_OUTPUT);
  assert.equal(res.json().meta.engine, 'agent');
  assert.equal(res.json().meta.skillName, SKILL_NAME);
  assert.equal(captures.stream, 0);
  assert.equal(captures.create.meta.origin, 'subagent');
  assert.equal(captures.section.complete, true);
  assert.match(captures.section.text, /SYSTEM CONTRACT/);
  assert.match(captures.section.text, /<skill_resources>/);
  assert.match(captures.section.text, /references\/layout\.md/);
  assert.match(captures.section.text, /scripts\/compile_prompt\.py/);
  assert.deepEqual(captures.tools.map((tool) => tool.name), [READ_TOOL, LIST_TOOL]);
  assert.deepEqual(captures.restrict.deny.sort(), ['bash', 'read', 'write']);
  assert.equal(captures.disposed, true);
});

test('config.engine=direct 强制回退一次直出', async () => {
  const routes = [];
  const ctx = {
    llm: {
      listProviders: () => [],
      async listModels() { return []; },
      async *stream() {
        this.calls = (this.calls ?? 0) + 1;
        yield { type: 'text-delta', text: JSON.stringify(VALID_OUTPUT) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    logger: { info() {}, warn() {} },
    effect: (callback) => callback(),
    webServer: { register(route) { routes.push(route); return () => {}; } },
    get(name) {
      if (name === 'skills') return { registerProvider() {} };
      return null;
    },
  };
  apply(ctx, { systemPrompt: 'SYSTEM CONTRACT', engine: 'direct' });
  const handler = routes.find((route) => route.path.endsWith('/api')).handler;
  const { pending, res } = startRequest(handler, {
    mode: 'text',
    text: '做一个海报',
    image: null,
    modelId: 'provider::model',
    skillName: SKILL_NAME,
  });
  await pending;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().meta.engine, 'direct');
  assert.equal(ctx.llm.calls, 1);
});
