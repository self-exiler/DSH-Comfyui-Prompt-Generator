/** 浏览器到 dsh 插件的唯一通道；模型、技能、提示词与生成都在服务端。 */

import { TaskError } from '../core/errors.js';

/** base 是插件挂载根（以 / 结尾），例如 http://host/comfyui-prompt/ */
export function createBridge(base) {
  async function request(method, route, body, signal) {
    let response;
    try {
      response = await fetch(new URL(route, base), {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      throw new TaskError('HOST_ERROR', {
        message: `无法连接宿主：${error.message}`,
        hint: '请从 dsh 侧栏打开本面板，并确认 comfyui-prompt-tool 插件已挂载。',
      });
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload?.error ?? {};
      throw new TaskError(detail.code ?? 'HOST_ERROR', {
        stage: detail.stage,
        message: detail.message ?? `宿主返回 HTTP ${response.status}`,
        hint: detail.hint,
        details: detail.details,
      });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TaskError('HOST_ERROR', { message: '宿主返回了无法识别的 JSON 响应' });
    }
    return payload;
  }

  return {
    /** -> { models: [{ id, label, vision }], imageLimits? } */
    async models() {
      const data = await request('GET', 'api/models');
      if (!Array.isArray(data.models)) {
        throw new TaskError('HOST_ERROR', { message: '宿主模型目录响应缺少 models 数组' });
      }
      return data;
    },
    /** -> { skills: [{ name, description }], hint? } */
    async skills() {
      const data = await request('GET', 'api/skills');
      if (!Array.isArray(data.skills)) {
        throw new TaskError('HOST_ERROR', { message: '宿主技能目录响应缺少 skills 数组' });
      }
      return data;
    },
    /** -> { result: { prompt_en, translation_zh, notes }, meta } */
    async generate({ mode, text, image, modelId, skillName }, signal) {
      const data = await request('POST', 'api/generate', { mode, text, image, modelId, skillName }, signal);
      if (!data.result || !data.meta) {
        throw new TaskError('HOST_ERROR', { message: '宿主生成响应缺少 result 或 meta' });
      }
      return data;
    },
  };
}
