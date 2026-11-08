/** 浏览器到 dsh 插件的唯一通道；模型、技能、提示词与生成都在服务端。 */

import { TaskError } from '../core/errors.js';

export class HttpHarnessAdapter {
  constructor(base) {
    this.base = new URL(base, globalThis.location?.href ?? 'http://localhost/').href;
    this.imageLimits = null;
  }

  async listModels() {
    const data = await this.request('GET', 'api/models');
    if (!Array.isArray(data?.models)) {
      throw new TaskError('HOST_ERROR', { message: '宿主模型目录响应缺少 models 数组' });
    }
    this.imageLimits = data.imageLimits ?? null;
    return data.models;
  }

  async listSkills() {
    const data = await this.request('GET', 'api/skills');
    if (!Array.isArray(data?.skills)) {
      throw new TaskError('HOST_ERROR', { message: '宿主技能目录响应缺少 skills 数组' });
    }
    return {
      skills: data.skills,
      failures: Array.isArray(data.failures) ? data.failures : [],
      hint: typeof data.hint === 'string' ? data.hint : '',
    };
  }

  async generate({ mode, text, image, modelId, skillName, signal }) {
    const data = await this.request(
      'POST',
      'api/generate',
      { mode, text, image, modelId, skillName },
      signal,
    );
    if (!data?.result || !data?.meta) {
      throw new TaskError('HOST_ERROR', { message: '宿主生成响应缺少 result 或 meta' });
    }
    return { result: data.result, meta: data.meta };
  }

  async request(method, path, body, signal) {
    let response;
    try {
      response = await fetch(new URL(path, this.base), {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      throw new TaskError('HOST_ERROR', {
        message: `无法连接宿主：${error.message}`,
        hint: '请确认 dsh web profile 正在运行，且 comfyui-prompt-tool 插件已挂载。',
      });
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const detail = payload?.error ?? {};
      throw new TaskError(detail.code ?? 'HOST_ERROR', {
        stage: detail.stage,
        message: detail.message ?? `宿主返回 HTTP ${response.status}`,
        hint: detail.hint,
        details: [
          ...(Array.isArray(detail.details) ? detail.details : []),
          detail.detail ? `Provider 错误码：${detail.detail}` : '',
        ].filter(Boolean),
      });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TaskError('HOST_ERROR', { message: '宿主返回了无法识别的 JSON 响应' });
    }
    return payload;
  }
}

export async function probeHttpHarness(timeoutMs = 2000, referenceUrl = globalThis.location?.href) {
  if (!referenceUrl) return null;
  let base;
  try {
    base = new URL('../../', referenceUrl);
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL('api/health', base), { signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json();
    if (data?.ok !== true) return null;
    return new HttpHarnessAdapter(base.href);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
