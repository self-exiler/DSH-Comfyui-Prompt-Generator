/**
 * 后台受限 Agent：每次生成创建一个临时 Agent，只注册技能资源工具，
 * 并拒绝宿主全局工具。前端的 /api/generate 契约保持不变。
 *
 * 会话使用 origin=subagent 且不设置 cwd：避免会话标题的额外模型调用，
 * 生成结束后 dispose，冷会话列表也不会出现这条内部记录。
 */

import { randomUUID } from 'node:crypto';
import { modelErrorFromFailure, TaskError } from '../../../src/core/errors.js';
import { createSkillTools } from './skill-resources.js';

const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix';

/** 宿主是否具备 Agent 编排所需的服务。 */
export function canUseAgentEngine(ctx) {
  const agents = safeGet(ctx, 'agents');
  const tools = safeGet(ctx, 'tools');
  const systemPrompt = safeGet(ctx, 'systemPrompt');
  return Boolean(agents?.create && tools?.register && systemPrompt?.section);
}

/**
 * 运行一次受限 Agent 生成。
 * @returns {Promise<{ texts: string[], toolCalls: string[] }>} 按产生顺序的 assistant 文本与工具名。
 */
export async function runAgentGeneration(ctx, {
  providerId,
  model,
  systemPrompt,
  userContent,
  skillDir,
  signal,
  timeoutMs = 180_000,
}) {
  const agents = safeGet(ctx, 'agents');
  if (!agents?.create) throw new TaskError('HOST_ERROR', { message: '宿主未提供 Agent 服务' });

  const tools = createSkillTools({ skillDir });
  const sessionId = randomUUID();
  const run = { texts: [], toolCalls: [], endReason: undefined, agentError: undefined, timedOut: false };
  const offSession = ctx.on('session/event', (session, event) => {
    if (sessionIdOf(session) !== sessionId) return;
    recordEvent(run, event);
  });
  const offAgentError = ctx.on('agent/error', (payload) => {
    if (payload?.agent?.session?.id === sessionId) run.agentError ??= payload.error;
  });

  let handle;
  let timer;
  let cancel;
  const onAbort = () => {
    try {
      cancel?.();
    } catch {
      // 已被 dispose 的 agent 取消是无害的。
    }
  };

  try {
    handle = await agents.create({
      sessionId,
      meta: { origin: 'subagent' },
      agentOptions: { provider: providerId, model },
      signal,
      setup: (agentCtx) => composeAgent(agentCtx, { systemPrompt, tools }),
    });
    cancel = () => handle.agent.cancel({ kind: 'user' });

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      run.timedOut = true;
      onAbort();
    }, timeoutMs);

    handle.agent.followup({
      id: randomUUID(),
      role: 'user',
      content: userContent,
      source: { kind: 'user' },
    });
    await handle.agent.whenIdle();

    if (signal?.aborted) throw new TaskError('CANCELLED');
    if (run.timedOut) throw new TaskError('MODEL_TIMEOUT');

    const reason = run.endReason;
    if (reason?.kind === 'error') {
      throw modelErrorFromFailure(reason.error, 'Agent 调用失败');
    }
    if (reason?.kind === 'aborted') throw new TaskError('CANCELLED');
    if (reason?.kind === 'max-tokens') {
      throw new TaskError('MODEL_ERROR', { message: '模型输出达到 token 上限' });
    }
    if (run.texts.length === 0) {
      throw new TaskError('MODEL_ERROR', {
        message: run.agentError ? `Agent 执行失败：${errorMessage(run.agentError)}` : 'Agent 没有返回文本内容',
      });
    }
    return { texts: run.texts, toolCalls: run.toolCalls };
  } catch (error) {
    if (error instanceof TaskError) throw error;
    if (signal?.aborted) throw new TaskError('CANCELLED');
    if (run.timedOut) throw new TaskError('MODEL_TIMEOUT');
    throw new TaskError('MODEL_ERROR', { message: `Agent 执行失败：${errorMessage(error)}` });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (typeof offSession === 'function') offSession();
    if (typeof offAgentError === 'function') offAgentError();
    if (handle) {
      try {
        await handle.dispose();
      } catch (error) {
        ctx.logger.warn('comfyui-prompt agent dispose failed: %s', errorMessage(error));
      }
    }
  }
}

function composeAgent(agentCtx, { systemPrompt, tools }) {
  const prompt = agentCtx.systemPrompt;
  if (!prompt?.section) throw new Error('Agent 上下文没有 systemPrompt 服务');

  // 同名覆盖部署 persona，complete 让面板契约成为唯一系统提示词。
  prompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: 0,
    complete: true,
    interpolate: false,
    text: systemPrompt,
  });
  prompt.suppressRuntimeContext?.();

  const registry = agentCtx.tools;
  if (!registry?.register) throw new Error('Agent 上下文没有 tools 服务');
  for (const tool of tools) registry.register(tool);

  // 拒绝全部全局工具；scoped 注册不受 restriction 影响。
  const globalNames = [...new Set(registry.definitions().map((definition) => definition.name))]
    .filter((name) => name !== 'run_code');
  if (globalNames.length) registry.restrict({ deny: globalNames });
}

function recordEvent(run, event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'assistant/message') {
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) return;
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
      .trim();
    if (text) run.texts.push(text);
    return;
  }
  if (event.type === 'tool/call') {
    if (typeof event.data?.name === 'string') run.toolCalls.push(event.data.name);
    return;
  }
  if (event.type === 'turn/end') run.endReason = event.data?.reason;
}

function sessionIdOf(session) {
  return session?.id ?? session?.header?.id;
}

function safeGet(ctx, name) {
  try {
    return ctx.get?.(name);
  } catch {
    return undefined;
  }
}

function errorMessage(error) {
  return String(error?.message ?? error);
}
