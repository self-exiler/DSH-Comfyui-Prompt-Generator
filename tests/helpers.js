import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VALID_OUTPUT = {
  prompt_en: 'A girl walking in the rain, no umbrella.',
  translation_zh: '一个女孩在雨中行走，没有伞。',
  notes: '',
};

export class MockResponse extends EventEmitter {
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

/** 启动一次 /api/generate 请求，返回 pending 与可检查的 req/res。 */
export function startRequest(handler, body, headers = {}) {
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

/** 请求任意面板 API 或静态资源。 */
export function get(handler, pathname, method = 'GET') {
  const req = new EventEmitter();
  req.method = method;
  req.url = `/comfyui-prompt${pathname}`;
  req.headers = {};
  const res = new MockResponse();
  return Promise.resolve(handler(req, res)).then(() => res);
}
