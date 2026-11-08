/**
 * 真实宿主联调脚本（开发工具，无第三方依赖；需 Node >=22，脚本用全局 WebSocket 连 CDP）
 *
 * 它跑在 dsh web profile 挂载的插件页面上，会真的经 ctx.llm 调一次模型：
 *   - 页面通过 HTTP 桥接识别到 dsh 插件
 *   - 原生技能目录与模型目录加载成功
 *   - 选中一个真实模型后，文本生成能一次返回三段结果（英文提示词 / 中文翻译 / 补充说明）
 *   - 图片模式能选到视觉模型；若模型侧失败，错误必须来自模型而不是图片校验
 *   - 可选：--cancel 验证取消保留输入与上一次结果
 *
 *   node tools/ui-live-check.js --url http://127.0.0.1:3080/comfyui-prompt/src/ui/index.html \
 *     --model modelscope::deepseek-ai/DeepSeek-V4.1-Flash-1017 --shot ui-live.png
 *   可选：--vision-model <id> 指定视觉模型；--cancel --cancel-model <慢模型>
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index > -1 ? args[index + 1] : fallback;
};

const url = argValue('url', 'http://127.0.0.1:3080/comfyui-prompt/src/ui/index.html');
const shotPath = argValue('shot', path.resolve('ui-live.png'));
const port = Number(argValue('port', '9334'));
const modelId = argValue('model', 'modelscope::deepseek-ai/DeepSeek-V4.1-Flash-1017');
const visionModelId = argValue('vision-model', '');
const cancelModel = argValue('cancel-model', '');

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const browserPath = CANDIDATES.find((candidate) => existsSync(candidate));
if (!browserPath) {
  console.error('没有找到 Edge/Chrome，可手动打开：', url);
  process.exit(1);
}

const browser = spawn(browserPath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${port}`,
  '--window-size=1500,1200',
  'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => {
  if (browser.exitCode === null && !browser.signalCode) browser.kill();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      const page = list.find((item) => item.type === 'page');
      if (page) return page;
    } catch {
      /* 浏览器还没就绪 */
    }
    await sleep(150);
  }
  throw new Error('无法连接浏览器调试端口');
}

const page = await pageTarget();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let sequence = 0;
const pending = new Map();
const consoleErrors = [];

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? '未知异常');
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
  }
});

function send(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? '页面脚本执行失败');
  }
  return result.result.value;
}

async function waitForIdle(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const busy = await evaluate(`document.getElementById('generate').disabled`);
    if (!busy) return true;
    await sleep(300);
  }
  return false;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });

async function waitForReady(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(`document.body.dataset.ready ?? ''`);
    if (ready) {
      if (ready !== 'ok') throw new Error(`页面初始化状态异常：${ready}`);
      return;
    }
    await sleep(250);
  }
  throw new Error('页面初始化超时');
}
await waitForReady();

const initial = await evaluate(`(() => ({
  host: document.getElementById('host-status').textContent,
  hostTitle: document.getElementById('host-status').title,
  skills: [...document.querySelectorAll('#skill-select option')].map((o) => o.value),
  models: [...document.querySelectorAll('#model-text option')].map((o) => ({ value: o.value, label: o.textContent })),
  modelNote: document.getElementById('model-note').textContent,
  error: document.getElementById('error-box').hidden ? null : document.getElementById('err-message').textContent,
}))()`);

/* ---------------- 1. 文本整合：一次直出三段 ---------------- */

const modelApplied = await evaluate(`(() => {
  const select = document.getElementById('model-text');
  const wanted = ${JSON.stringify(modelId)};
  const exists = [...select.options].some((o) => o.value === wanted);
  if (exists) {
    select.value = wanted;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const input = document.getElementById('input-text');
  input.value = '一个女孩在雨中，不要伞';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('generate').click();
  return { exists, value: select.value };
})()`);

const idle1 = await waitForIdle();

const afterGenerate = await evaluate(`(() => ({
  promptEn: document.getElementById('result-prompt-en').textContent,
  promptEmpty: document.getElementById('result-prompt-en').classList.contains('empty'),
  translation: document.getElementById('result-translation').textContent,
  notesBlockHidden: document.getElementById('notes-block').hidden,
  notes: document.getElementById('result-notes').textContent,
  meta: document.getElementById('result-meta').textContent,
  error: document.getElementById('error-box').hidden ? null : {
    stage: document.getElementById('err-stage').textContent,
    message: document.getElementById('err-message').textContent,
    hint: document.getElementById('err-hint').textContent,
  },
  statusVisible: !document.getElementById('status-line').hidden,
}))()`);

const textShot = await send('Page.captureScreenshot', { format: 'png' });
const textShotPath = shotPath.replace(/\.png$/i, '-text.png');
await writeFile(textShotPath, Buffer.from(textShot.data, 'base64'));

/* ---------------- 2. 图片模式与视觉模型 ---------------- */

const imageMode = await evaluate(`(async () => {
  document.getElementById('mode-image').click();
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  g.fillStyle = '#c0392b';
  g.fillRect(0, 0, 64, 64);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const file = new File([blob], 'live-check.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.getElementById('image-file');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  return {
    textHidden: document.getElementById('text-input-wrap').hidden,
    imageVisible: !document.getElementById('image-input-wrap').hidden,
    visionVisible: !document.getElementById('vision-model-field').hidden,
    visionModels: [...document.querySelectorAll('#model-vision option')].map((o) => ({ value: o.value, label: o.textContent })),
    previewVisible: !document.getElementById('image-preview-wrap').hidden,
    imageMeta: document.getElementById('image-meta').textContent,
    dropHint: document.querySelector('#dropzone .hint')?.textContent ?? null,
    imageError: document.getElementById('error-box').hidden ? null : document.getElementById('err-message').textContent,
  };
})()`);

let afterImageGenerate = null;
const chosenVision = visionModelId || imageMode.visionModels[0]?.value;
const visionOptions = imageMode.visionModels.map((item) => item.value);
if (chosenVision && visionOptions.includes(chosenVision)) {
  await evaluate(`(() => {
    const select = document.getElementById('model-vision');
    select.value = ${JSON.stringify(chosenVision)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('generate').click();
    return true;
  })()`);
  await waitForIdle(240000);
  afterImageGenerate = await evaluate(`(() => ({
    model: document.getElementById('model-vision').value,
    error: document.getElementById('error-box').hidden ? null : {
      stage: document.getElementById('err-stage').textContent,
      message: document.getElementById('err-message').textContent,
    },
    promptEn: document.getElementById('result-prompt-en').textContent,
    translation: document.getElementById('result-translation').textContent,
    meta: document.getElementById('result-meta').textContent,
    statusVisible: !document.getElementById('status-line').hidden,
  }))()`);
}

/* ---------------- 3. 用户取消（可选） ---------------- */
let cancelCheck = null;
if (args.includes('--cancel')) {
  await evaluate(`(() => { document.getElementById('mode-text').click(); return true; })()`);
  const before = await evaluate(`document.getElementById('result-prompt-en').textContent`);
  await evaluate(`(() => {
    const select = document.getElementById('model-text');
    select.value = ${JSON.stringify(cancelModel || modelId)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const input = document.getElementById('input-text');
    input.value = '请写一段很长的画面描述：' + '一个女孩在雨中，'.repeat(120);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('generate').click();
    return true;
  })()`);
  await sleep(1200);
  const busyVisible = await evaluate(`(() => ({
    cancelVisible: !document.getElementById('cancel').hidden,
    status: document.getElementById('status-text').textContent,
  }))()`);
  await evaluate(`(() => { document.getElementById('cancel').click(); return true; })()`);
  await waitForIdle(120000);
  cancelCheck = await evaluate(`(() => ({
    busyReleased: !document.getElementById('generate').disabled,
    stage: document.getElementById('error-box').hidden ? null : document.getElementById('err-stage').textContent,
    message: document.getElementById('error-box').hidden ? null : document.getElementById('err-message').textContent,
    inputValue: document.getElementById('input-text').value.length,
    preservedPrompt: document.getElementById('result-prompt-en').textContent,
  }))()`);
  cancelCheck.before = before;
  cancelCheck.busyVisible = busyVisible;
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
await writeFile(shotPath, Buffer.from(shot.data, 'base64'));

const report = {
  url, modelId, visionModelId: chosenVision ?? null, initial, modelApplied, idle1,
  afterGenerate, imageMode, afterImageGenerate, cancelCheck, consoleErrors, shotPath, textShotPath,
};
console.log(JSON.stringify(report, null, 2));

socket.close();
browser.kill();

/* ---------------- 断言 ---------------- */

const failures = [];
if (!initial.host.includes('已连接')) failures.push(`宿主未连接：${initial.host}`);
if (initial.hostTitle && !initial.hostTitle.includes('dsh 插件')) failures.push('连接说明未指向 dsh 插件');
if (initial.skills.length < 1) failures.push('原生技能未加载');
if (!initial.models.length) failures.push('模型列表为空');
if (!modelApplied.exists) failures.push(`模型 ${modelId} 不在列表中`);
if (afterGenerate.error) failures.push(`文本生成失败：${afterGenerate.error.stage} ${afterGenerate.error.message}`);
if (!afterGenerate.error && afterGenerate.promptEn.includes('尚未生成')) failures.push('英文提示词未生成');
if (!afterGenerate.error && (afterGenerate.promptEmpty || !afterGenerate.translation || afterGenerate.translation.includes('尚未生成'))) {
  failures.push('三段结果不完整（英文或中文翻译缺失）');
}
if (afterGenerate.statusVisible) failures.push('生成结束后状态栏未隐藏');
if (!imageMode.imageVisible || imageMode.textHidden === false) failures.push('图片模式切换异常');
if (!imageMode.visionVisible) failures.push('视觉模型选择未显示');
if (!imageMode.previewVisible) failures.push('图片预览未显示');
if (afterImageGenerate?.error?.stage === '输入检查' || afterImageGenerate?.error?.stage === '模型与技能选择') {
  failures.push(`图片请求未进入模型阶段：${afterImageGenerate.error.message}`);
}
if (cancelCheck) {
  if (!cancelCheck.busyVisible.cancelVisible) failures.push('取消按钮未在任务中显示');
  if (!cancelCheck.busyReleased) failures.push('取消后忙碌状态未释放');
  if (cancelCheck.inputValue === 0) failures.push('取消后原始输入丢失');
  if (cancelCheck.preservedPrompt !== cancelCheck.before) failures.push('取消后上一次有效结果被覆盖');
  if (!cancelCheck.message) failures.push('取消后未向用户显示取消状态');
}
if (consoleErrors.length) failures.push(`控制台错误：${consoleErrors.join(' | ')}`);

if (failures.length) {
  console.error('真实宿主联调失败：', failures.join('；'));
  process.exit(1);
}
console.log('真实宿主联调通过');
