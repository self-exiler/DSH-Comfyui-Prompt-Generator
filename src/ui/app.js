/**
 * ComfyUI 提示词面板。
 * UI 只负责输入、目录展示和结果渲染；模型调用、提示词、技能与解析全部在 dsh 插件服务端。
 */

import { IMAGE_TYPES } from '../core/prompt.js';
import { TaskError, toTaskError } from '../core/errors.js';
import { createBridge } from '../host/http-bridge.js';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** 本文件位于 <挂载根>/src/ui/，挂载根在其上两级 */
const MOUNT_ROOT = new URL('../../', import.meta.url);
const PANEL_URL = new URL('./panel.html', import.meta.url);
const STYLES_URL = new URL('./styles.css', import.meta.url);

function abortError() {
  const error = new Error('挂载已取消');
  error.name = 'AbortError';
  return error;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function initialState() {
  return {
    mode: 'text',
    models: [],
    modelText: '',
    modelVision: '',
    skills: [],
    skillKey: '',
    result: null,
    meta: null,
    busy: false,
    image: null,
    imageLimits: null,
  };
}

const store = {
  get(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* 宿主未开放存储时不影响编辑 */
    }
  },
};

function ensureStyles() {
  if (document.querySelector('link[data-comfyui-prompt-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLES_URL.href;
  link.dataset.comfyuiPromptCss = '';
  document.head.append(link);
}

function createAppInstance(container, { embedded = false, signal } = {}) {
  const root = container;
  const state = initialState();
  const el = (id) => root.querySelector(`#${id}`);

  const bridge = createBridge(MOUNT_ROOT);
  let modelsError = null;
  let modelRefreshToken = 0;
  let skillRefreshToken = 0;
  let transientTimer = null;
  let imageReadToken = 0;
  let activeController = null;
  let disposed = false;

  function clearTransient() {
    clearTimeout(transientTimer);
    transientTimer = null;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', dispose);
    modelRefreshToken += 1;
    skillRefreshToken += 1;
    clearTransient();
    activeController?.abort();
    activeController = null;
  }

  if (signal?.aborted) disposed = true;
  else signal?.addEventListener('abort', dispose, { once: true });

  function imageMaxBytes() {
    const limit = Number(state.imageLimits?.maxImageBytes);
    return Number.isFinite(limit) && limit > 0 ? limit : MAX_IMAGE_BYTES;
  }

  function supportedImageTypes() {
    const list = state.imageLimits?.mediaTypes;
    if (!Array.isArray(list) || !list.length) return IMAGE_TYPES;
    const allowed = list.filter((type) => IMAGE_TYPES.includes(type));
    return allowed.length ? allowed : IMAGE_TYPES;
  }

  function applyImageLimitsHint() {
    if (disposed) return;
    const hint = root.querySelector('#dropzone .hint');
    if (!hint) return;
    const types = supportedImageTypes()
      .map((type) => type.replace(/^image\//, '').toUpperCase())
      .join(' / ');
    hint.textContent = `${types}，最大 ${formatBytes(imageMaxBytes())}。图片只会发送给你当前选择的 Harness Provider。`;
  }

  function setHostStatus(mode, text, title = '') {
    const status = el('host-status');
    status.dataset.mode = mode;
    status.textContent = text;
    status.title = title;
  }

  /* ---------------------------------------------------------------- 初始化 */

  async function init() {
    bindEvents();
    restoreSelection();
    updateMode();
    applyImageLimitsHint();

    // 没有单独的"探测宿主"步骤：目录请求失败即视为未连接，错误原样展示。
    const [skillsResult] = await Promise.allSettled([
      refreshSkills(),
      refreshModels({ silent: true }),
    ]);
    if (disposed) return;
    if (skillsResult.status === 'rejected') {
      setHostStatus('offline', '未连接 dsh');
      showError(toTaskError(skillsResult.reason));
    } else {
      setHostStatus('harness', '已连接 dsh', '模型、技能与系统提示词均由 dsh 插件提供。');
    }

    renderSkillSelect();
    renderSkillMeta();
    renderResults();
    renderModelNote();
    setBusy(false); // 初始按钮是禁用的"初始化中…"；无论成败都要还原，否则离线时会永远卡住
  }

  function restoreSelection() {
    state.modelText = store.get('cp.model.text') ?? '';
    state.modelVision = store.get('cp.model.vision') ?? '';
    state.skillKey = store.get('cp.skill') ?? '';
    state.mode = store.get('cp.mode') === 'image' ? 'image' : 'text';

    const inputText = el('input-text');
    inputText.value = store.get('cp.input.text') ?? '';
    el('input-image-note').value = store.get('cp.input.image-note') ?? '';
    el('char-count').textContent = `${inputText.value.length} 字`;
  }

  /* ------------------------------------------------------------------ 目录 */

  function renderModelNote() {
    if (disposed) return;
    if (modelsError) {
      el('model-note').textContent = `模型列表获取失败：${modelsError.message}`;
      return;
    }
    el('model-note').textContent = state.models.length
      ? `已从 dsh 获取 ${state.models.length} 个模型；系统提示词与技能由插件统一提供。`
      : '宿主没有返回任何模型，请先在 dsh 中配置 Provider。';
  }

  async function refreshModels({ silent = false } = {}) {
    if (disposed) return;
    const token = ++modelRefreshToken;
    try {
      const { models, imageLimits } = await bridge.models();
      if (disposed || token !== modelRefreshToken) return;
      state.models = models;
      modelsError = null;
      if (imageLimits) {
        state.imageLimits = imageLimits;
        applyImageLimitsHint();
      }
      renderModelSelects();
      renderModelNote();
    } catch (error) {
      if (disposed || token !== modelRefreshToken) return;
      modelsError = toTaskError(error);
      renderModelNote();
      if (!silent) showError(modelsError);
    }
  }

  async function refreshSkills() {
    if (disposed) return;
    const token = ++skillRefreshToken;
    const payload = await bridge.skills();
    if (disposed || token !== skillRefreshToken) return;
    state.skills = payload.skills;
    renderSkillSelect();
    renderSkillMeta();
    renderSkillHint(payload.hint);
  }

  function renderModelSelects() {
    const textSelect = el('model-text');
    const visionSelect = el('model-vision');
    const previousText = state.modelText;
    const previousVision = state.modelVision;

    textSelect.innerHTML = '';
    if (!state.models.length) textSelect.append(new Option('（无可用模型）', ''));
    for (const model of state.models) {
      const suffix = model.vision ? ' · 支持图片' : '';
      textSelect.append(new Option(`${model.label}${suffix}`, model.id));
    }
    const textChoice = state.models.some((model) => model.id === previousText)
      ? previousText
      : state.models[0]?.id ?? '';
    textSelect.value = textChoice;
    state.modelText = textChoice;

    visionSelect.innerHTML = '';
    const visionModels = state.models.filter((model) => model.vision);
    if (!visionModels.length) visionSelect.append(new Option('（没有声明支持图片的模型）', ''));
    for (const model of visionModels) visionSelect.append(new Option(model.label, model.id));
    // 未手动选过图片模型时，优先跟随文本模型所在的 Provider；
    // 避免默认落到另一个余额/限流不可用的 Provider。
    const providerOf = (id) => String(id).split('::')[0];
    const sameProviderVision = visionModels.find((model) => providerOf(model.id) === providerOf(textChoice));
    const visionChoice = visionModels.some((model) => model.id === previousVision)
      ? previousVision
      : sameProviderVision?.id ?? visionModels[0]?.id ?? '';
    visionSelect.value = visionChoice;
    state.modelVision = visionChoice;
  }

  function renderSkillSelect() {
    const select = el('skill-select');
    select.innerHTML = '';
    if (!state.skills.length) select.append(new Option('（没有可用技能）', ''));
    for (const skill of state.skills) {
      const option = new Option(skill.name, skill.name);
      option.title = skill.description || skill.name;
      select.append(option);
    }
    if (!state.skills.length) {
      state.skillKey = '';
    } else if (!state.skills.some((skill) => skill.name === state.skillKey)) {
      state.skillKey = state.skills[0].name;
    }
    select.value = state.skillKey;
    el('skill-count').textContent = `${state.skills.length} 个技能`;
  }

  function currentSkill() {
    return state.skills.find((skill) => skill.name === state.skillKey) ?? null;
  }

  function renderSkillMeta() {
    const skill = currentSkill();
    const box = el('skill-meta');
    box.replaceChildren();
    if (!skill) {
      const badge = document.createElement('span');
      badge.className = 'badge inferred';
      badge.textContent = '无可用技能';
      box.append(badge, document.createTextNode(' 缺少技能时不允许执行生成任务。'));
      return;
    }
    const code = document.createElement('code');
    code.textContent = skill.name;
    box.append('ID ', code);
    if (skill.description) {
      box.append(document.createElement('br'), skill.description);
    }
    box.append(document.createElement('br'), '来源：本仓库原生技能（dsh 发现）');
  }

  /** 目录为空时服务端会给出排查提示 */
  function renderSkillHint(hint) {
    const box = el('skill-errors');
    box.replaceChildren();
    if (!hint) return;
    const div = document.createElement('div');
    div.className = 'item';
    div.textContent = hint;
    box.append(div);
  }

  /* ------------------------------------------------------------------ 模式 */

  function updateMode() {
    const isText = state.mode === 'text';
    el('text-input-wrap').hidden = !isText;
    el('image-input-wrap').hidden = isText;
    el('vision-model-field').hidden = isText;
    el('mode-hint').textContent = isText ? '文本模式' : '图片反推模式';
    el('mode-text').setAttribute('aria-selected', String(isText));
    el('mode-image').setAttribute('aria-selected', String(!isText));
  }

  function switchMode(mode) {
    if (disposed || state.busy) return;
    state.mode = mode;
    store.set('cp.mode', state.mode);
    updateMode();
  }

  /* ------------------------------------------------------------------ 输入 */

  function openFilePicker(id) {
    if (disposed) return;
    const input = el(id);
    input.value = '';
    input.click();
  }

  function bindEvents() {
    el('mode-text').addEventListener('click', () => switchMode('text'));
    el('mode-image').addEventListener('click', () => switchMode('image'));

    const inputText = el('input-text');
    inputText.addEventListener('input', () => {
      if (disposed) return;
      el('char-count').textContent = `${inputText.value.length} 字`;
      store.set('cp.input.text', inputText.value);
    });
    const imageNote = el('input-image-note');
    imageNote.addEventListener('input', () => {
      if (!disposed) store.set('cp.input.image-note', imageNote.value);
    });

    el('model-text').addEventListener('change', (event) => {
      state.modelText = event.target.value;
      store.set('cp.model.text', state.modelText);
    });
    el('model-vision').addEventListener('change', (event) => {
      state.modelVision = event.target.value;
      store.set('cp.model.vision', state.modelVision);
    });
    el('refresh-models').addEventListener('click', () => {
      refreshModels();
      refreshSkills().catch((error) => {
        if (!disposed) showError(toTaskError(error));
      });
    });
    el('skill-select').addEventListener('change', (event) => {
      state.skillKey = event.target.value;
      store.set('cp.skill', state.skillKey);
      renderSkillMeta();
    });

    el('generate').addEventListener('click', generate);
    el('cancel').addEventListener('click', cancel);
    el('retry').addEventListener('click', () => {
      hideError();
      generate();
    });

    el('dropzone').addEventListener('click', () => openFilePicker('image-file'));
    el('dropzone').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') openFilePicker('image-file');
    });
    el('dropzone').addEventListener('dragover', (event) => {
      event.preventDefault();
      el('dropzone').classList.add('dragover');
    });
    el('dropzone').addEventListener('dragleave', () => el('dropzone').classList.remove('dragover'));
    el('dropzone').addEventListener('drop', (event) => {
      event.preventDefault();
      el('dropzone').classList.remove('dragover');
      void handleImageFile(event.dataTransfer?.files?.[0]);
    });
    el('image-file').addEventListener('change', (event) => {
      void handleImageFile(event.target.files?.[0]);
    });
    el('clear-image').addEventListener('click', () => {
      if (disposed) return;
      imageReadToken += 1;
      state.image = null;
      el('image-preview-wrap').hidden = true;
      el('image-preview').removeAttribute('src');
      el('image-file').value = '';
    });

    el('copy-prompt').addEventListener('click', () => copyResult('prompt'));
    el('copy-translation').addEventListener('click', () => copyResult('translation'));
  }

  async function handleImageFile(file) {
    if (disposed) return;
    const token = ++imageReadToken;
    if (!file) return;
    if (!supportedImageTypes().includes(file.type)) {
      showError(new TaskError('INPUT_IMAGE_FORMAT', {
        message: `不支持的图片格式：${file.type || file.name}`,
        details: [`宿主接受：${supportedImageTypes().join('、')}`],
      }));
      return;
    }
    const maxBytes = imageMaxBytes();
    if (file.size > maxBytes) {
      showError(new TaskError('INPUT_IMAGE_FORMAT', {
        message: `图片过大（${formatBytes(file.size)}，上限 ${formatBytes(maxBytes)}）`,
        hint: '请压缩后再选择；该上限来自 Harness 的附件服务。',
      }));
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (disposed || token !== imageReadToken) return;
      state.image = { dataUrl, mimeType: file.type, name: file.name, size: file.size };
      el('image-preview').src = dataUrl;
      el('image-preview-wrap').hidden = false;
      el('image-meta').textContent = `${file.name} · ${file.type} · ${formatBytes(file.size)}`;
      hideError();
    } catch (error) {
      if (disposed || token !== imageReadToken || error?.name === 'AbortError') return;
      showError(new TaskError('HOST_ERROR', {
        stage: 'input',
        message: `图片读取失败：${error?.message ?? String(error)}`,
        hint: '请确认文件仍可访问，然后重新选择图片。',
      }));
    }
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('浏览器无法读取该文件'));
      reader.readAsDataURL(file);
    });
  }

  /* ------------------------------------------------------------------ 生成 */

  async function generate() {
    if (disposed || state.busy) return;
    const skill = currentSkill();
    if (!skill) {
      showError(new TaskError('NO_SKILL'));
      return;
    }
    const modelId = state.mode === 'text' ? state.modelText : state.modelVision;
    if (!modelId) {
      showError(new TaskError('MODEL_REQUIRED'));
      return;
    }
    if (state.mode === 'image') {
      if (!state.image) {
        showError(new TaskError('INPUT_EMPTY', {
          message: '尚未选择图片',
          hint: '请选择本地图片后再生成。',
        }));
        return;
      }
      if (!state.models.find((item) => item.id === modelId)?.vision) {
        showError(new TaskError('VISION_UNSUPPORTED'));
        return;
      }
    }

    const text = state.mode === 'text' ? el('input-text').value : el('input-image-note').value;
    if (state.mode === 'text' && !text.trim()) {
      showError(new TaskError('INPUT_EMPTY'));
      return;
    }

    clearTransient();
    setBusy(true);
    clearStatus();
    hideError();
    showStatus('正在调用模型改写提示词…');

    const controller = new AbortController();
    activeController = controller;
    try {
      const output = await bridge.generate({
        mode: state.mode,
        text,
        image: state.mode === 'image' ? state.image : null,
        modelId,
        skillName: skill.name,
      }, controller.signal);
      if (disposed) return;
      state.result = output.result;
      state.meta = output.meta;
      renderResults();
      clearStatus();
    } catch (error) {
      if (disposed) return;
      showError(toTaskError(error));
      clearStatus();
    } finally {
      if (activeController === controller) activeController = null;
      if (!disposed) setBusy(false);
    }
  }

  function cancel() {
    if (disposed || !state.busy) return;
    clearTransient();
    activeController?.abort();
    showStatus('正在取消，已保留输入与上一次有效结果…');
  }

  function setBusy(busy) {
    if (disposed) return;
    state.busy = busy;
    el('generate').disabled = busy;
    el('generate').textContent = busy ? '生成中…' : '生成提示词';
    el('cancel').hidden = !busy;
  }

  function showStatus(text) {
    if (disposed) return;
    el('status-line').hidden = false;
    el('status-text').textContent = text;
  }

  function clearStatus() {
    if (disposed) return;
    el('status-line').hidden = true;
    el('status-text').textContent = '';
  }

  /* ------------------------------------------------------------------ 结果 */

  function renderResults() {
    const result = state.result;
    const promptEl = el('result-prompt-en');
    const transEl = el('result-translation');
    const notesBlock = el('notes-block');
    const notesEl = el('result-notes');
    const meta = el('result-meta');

    if (!result) {
      promptEl.textContent = '尚未生成';
      promptEl.classList.add('empty');
      transEl.textContent = '尚未生成';
      transEl.classList.add('empty');
      notesBlock.hidden = true;
      meta.textContent = '无';
      return;
    }

    promptEl.textContent = result.prompt_en;
    promptEl.classList.remove('empty');
    transEl.textContent = result.translation_zh || '（模型未提供中文翻译）';
    transEl.classList.toggle('empty', !result.translation_zh);

    if (result.notes) {
      notesEl.textContent = result.notes;
      notesBlock.hidden = false;
    } else {
      notesEl.textContent = '';
      notesBlock.hidden = true;
    }

    meta.textContent = [
      state.meta?.skillName,
      state.meta?.modelId,
      state.meta?.durationMs !== undefined ? `${state.meta.durationMs} ms` : null,
    ].filter(Boolean).join(' · ') || '无';
  }

  async function copyResult(kind) {
    if (disposed) return;
    const result = state.result;
    if (!result) {
      showTransient('还没有可复制的结果');
      return;
    }
    const text = kind === 'translation' ? result.translation_zh : result.prompt_en;
    if (!text) {
      showTransient('没有可复制的内容');
      return;
    }
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else fallbackCopy(text);
      if (!disposed) showTransient('已复制到剪贴板');
    } catch {
      if (disposed) return;
      fallbackCopy(text);
      showTransient('已复制（降级方式）');
    }
  }

  function fallbackCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      document.execCommand('copy');
    } finally {
      area.remove();
    }
  }

  /* ------------------------------------------------------------------ 错误 */

  function showError(error) {
    if (disposed) return;
    // TaskError 构造时已对 message / hint / details 脱敏
    const err = toTaskError(error);
    el('error-box').hidden = false;
    el('err-stage').textContent = err.stageLabel;
    el('err-message').textContent = err.message;
    el('err-hint').textContent = err.hint;
    el('err-details').replaceChildren(...err.details.map((detail) => {
      const li = document.createElement('li');
      li.textContent = detail;
      return li;
    }));
  }

  function hideError() {
    if (!disposed) el('error-box').hidden = true;
  }

  function showTransient(text) {
    if (disposed) return;
    clearTransient();
    showStatus(text);
    transientTimer = setTimeout(() => {
      if (disposed) return;
      transientTimer = null;
      clearStatus();
    }, 2600);
  }

  /* ------------------------------------------------------------------ 挂载 */

  async function mountInstance() {
    if (disposed) throw abortError();
    container.classList.add('cp-root');
    ensureStyles();

    const response = await fetch(PANEL_URL, { signal });
    if (disposed) throw abortError();
    if (!response.ok) throw new Error(`界面片段加载失败：HTTP ${response.status}`);
    const html = await response.text();
    if (disposed) throw abortError();
    container.innerHTML = html;

    if (embedded) el('host-status').hidden = true;

    try {
      await init();
    } catch (error) {
      if (disposed || error?.name === 'AbortError') throw error;
      showError(toTaskError(error));
      setHostStatus('offline', '初始化失败');
      setBusy(false);
    }
    if (disposed) throw abortError();
    return dispose;
  }

  return { mount: mountInstance, dispose };
}

export async function mount(container, options = {}) {
  return createAppInstance(container, options).mount();
}
