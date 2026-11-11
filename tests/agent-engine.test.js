import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { canUseAgentEngine, runAgentGeneration } from '../plugins/comfyui-prompt/lib/agent-engine.js';
import { LIST_TOOL, READ_TOOL } from '../plugins/comfyui-prompt/lib/skill-resources.js';
import { ROOT, VALID_OUTPUT } from './helpers.js';

const SKILL_DIR = path.join(ROOT, 'skills', 'sd-prompt');

function createHarness({
  onFollowup,
  whenIdle,
  createError,
  globalTools = [{ name: 'read' }, { name: 'write' }, { name: 'bash' }, { name: 'run_code' }],
} = {}) {
  const listeners = new Map();
  const captures = {
    create: null,
    section: null,
    suppressed: false,
    tools: [],
    restrict: null,
    message: null,
    cancel: null,
    disposed: false,
  };

  const emit = (name, ...args) => {
    for (const listener of listeners.get(name) ?? []) listener(...args);
  };

  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'agents') return agents;
      if (name === 'tools') return { register() {}, definitions: () => [] };
      if (name === 'systemPrompt') return { section() {} };
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
    emit,
  };

  const agents = {
    async create(options) {
      captures.create = options;
      if (createError) throw createError;
      const agentCtx = {
        systemPrompt: {
          section(section) { captures.section = section; },
          suppressRuntimeContext() { captures.suppressed = true; },
        },
        tools: {
          register(definition) {
            captures.tools.push(definition);
            return () => {};
          },
          definitions: () => globalTools,
          restrict(filter) { captures.restrict = filter; },
        },
      };
      await options.setup(agentCtx);
      let resolveIdle;
      const idle = new Promise((resolve) => { resolveIdle = resolve; });
      return {
        agent: {
          session: { id: options.sessionId },
          followup(message) {
            captures.message = message;
            if (onFollowup) onFollowup({ emit, sessionId: options.sessionId, captures });
            else {
              emit('session/event', { id: options.sessionId }, {
                type: 'assistant/message',
                data: { message: { content: [{ type: 'text', text: JSON.stringify(VALID_OUTPUT) }] } },
              });
              emit('session/event', { id: options.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
            }
          },
          whenIdle() {
            if (whenIdle) return whenIdle({ resolveIdle, captures });
            return Promise.resolve();
          },
          cancel(cause) {
            captures.cancel = cause;
            resolveIdle?.();
          },
        },
        async dispose() { captures.disposed = true; },
      };
    },
  };

  return { ctx, captures, emit };
}

test('canUseAgentEngine 要求 agents、tools、systemPrompt 三个服务', () => {
  const { ctx } = createHarness();
  assert.equal(canUseAgentEngine(ctx), true);
  assert.equal(canUseAgentEngine({ get: () => null }), false);
  assert.equal(canUseAgentEngine({ get: (name) => (name === 'agents' ? { create() {} } : null) }), false);
});

test('受限 Agent：临时会话、complete 系统提示词、两个只读 scoped 工具、拒绝全局工具', async () => {
  const { ctx, captures } = createHarness();
  const result = await runAgentGeneration(ctx, {
    providerId: 'provider',
    model: 'model',
    systemPrompt: 'SYSTEM CONTRACT',
    userContent: [{ type: 'text', text: '一个女孩' }],
    skillDir: SKILL_DIR,
  });

  assert.deepEqual(result.texts, [JSON.stringify(VALID_OUTPUT)]);
  assert.deepEqual(result.toolCalls, []);
  assert.equal(captures.create.meta.origin, 'subagent');
  assert.deepEqual(captures.create.agentOptions, { provider: 'provider', model: 'model' });
  assert.equal(captures.section.name, 'deployment:persona-prefix');
  assert.equal(captures.section.complete, true);
  assert.equal(captures.section.interpolate, false);
  assert.equal(captures.section.text, 'SYSTEM CONTRACT');
  assert.equal(captures.suppressed, true);
  assert.deepEqual(captures.tools.map((tool) => tool.name), [READ_TOOL, LIST_TOOL]);
  assert.deepEqual(captures.restrict.deny.sort(), ['bash', 'read', 'write']);
  assert.equal(captures.message.role, 'user');
  assert.equal(captures.message.source.kind, 'user');
  assert.equal(captures.disposed, true);
});

test('受限 Agent 收集工具调用并返回最后一条 assistant 文本', async () => {
  const { ctx } = createHarness({
    onFollowup({ emit, sessionId }) {
      emit('session/event', { id: sessionId }, { type: 'tool/call', data: { name: 'read_file' } });
      emit('session/event', { id: sessionId }, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '先读取模板。' }] } },
      });
      emit('session/event', { id: sessionId }, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: JSON.stringify(VALID_OUTPUT) }] } },
      });
      emit('session/event', { id: sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    },
  });

  const result = await runAgentGeneration(ctx, {
    providerId: 'p',
    model: 'm',
    systemPrompt: 'S',
    userContent: [{ type: 'text', text: 'x' }],
    skillDir: SKILL_DIR,
  });
  assert.deepEqual(result.toolCalls, ['read_file']);
  assert.equal(result.texts.length, 2);
});

test('客户端取消会调用 agent.cancel 并抛出 CANCELLED', async () => {
  const { ctx, captures } = createHarness();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runAgentGeneration(ctx, {
      providerId: 'p',
      model: 'm',
      systemPrompt: 'S',
      userContent: [{ type: 'text', text: 'x' }],
      skillDir: SKILL_DIR,
      signal: controller.signal,
    }),
    (error) => error.code === 'CANCELLED',
  );
  assert.deepEqual(captures.cancel, { kind: 'user' });
  assert.equal(captures.disposed, true);
});

test('Agent 超时映射为 MODEL_TIMEOUT 并释放会话', async () => {
  const { ctx, captures } = createHarness({
    onFollowup() {
      // 保持运行，等待超时取消。
    },
    whenIdle() {
      return new Promise((resolve) => setTimeout(resolve, 50));
    },
  });

  await assert.rejects(
    runAgentGeneration(ctx, {
      providerId: 'p',
      model: 'm',
      systemPrompt: 'S',
      userContent: [{ type: 'text', text: 'x' }],
      skillDir: SKILL_DIR,
      timeoutMs: 10,
    }),
    (error) => error.code === 'MODEL_TIMEOUT',
  );
  assert.deepEqual(captures.cancel, { kind: 'user' });
  assert.equal(captures.disposed, true);
});

test('turn/end 错误与空文本分别映射为 MODEL_ERROR', async () => {
  const failed = createHarness({
    onFollowup({ emit, sessionId }) {
      emit('session/event', { id: sessionId }, {
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { message: 'quota', code: '429' } } },
      });
    },
  });
  await assert.rejects(
    runAgentGeneration(failed.ctx, {
      providerId: 'p', model: 'm', systemPrompt: 'S',
      userContent: [{ type: 'text', text: 'x' }], skillDir: SKILL_DIR,
    }),
    (error) => error.code === 'MODEL_ERROR' && /quota/.test(error.message),
  );

  const empty = createHarness({
    onFollowup({ emit, sessionId }) {
      emit('session/event', { id: sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    },
  });
  await assert.rejects(
    runAgentGeneration(empty.ctx, {
      providerId: 'p', model: 'm', systemPrompt: 'S',
      userContent: [{ type: 'text', text: 'x' }], skillDir: SKILL_DIR,
    }),
    (error) => error.code === 'MODEL_ERROR' && /没有返回文本/.test(error.message),
  );
});

test('Agent 创建失败时释放监听并返回 MODEL_ERROR', async () => {
  const { ctx } = createHarness({ createError: new Error('setup boom') });
  await assert.rejects(
    runAgentGeneration(ctx, {
      providerId: 'p', model: 'm', systemPrompt: 'S',
      userContent: [{ type: 'text', text: 'x' }], skillDir: SKILL_DIR,
    }),
    (error) => error.code === 'MODEL_ERROR' && /setup boom/.test(error.message),
  );
});
