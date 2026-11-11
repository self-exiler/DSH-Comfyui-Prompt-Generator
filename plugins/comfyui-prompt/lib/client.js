/*
 * comfyui-prompt-tool 的浏览器半边（dsh client plugin）。
 *
 * 格式与官方 bundle 一致（lazy-CJS）：执行只注册工厂，物化时工厂体才运行。
 * 宿主 client-modules 扫到本包 package.json 的 dsh.client 声明 + exports["./client"]，
 * 把它编入浏览器启动图；浏览器侧 cordis 树读取 exports.{inject,apply} 挂载。
 *
 * 只做两件事（对照 dsh-client-ui-plugin-manager 的注册形状）：
 *   1. sidebar.panellist 注册一个侧栏入口（图标 + 文案），id 与 main 面板键一致；
 *      点击由侧栏壳统一调 ctx.layout.selectPanel(id)，无需自写。
 *   2. main keyed 插槽注册工作区面板 ComfyPage：一个 React 壳，在同文档里挂载
 *      src/ui 的原生 ESM 应用（动态 import 静态路由产物并调用 mount）。
 *      同文档挂载 → 自动继承宿主 body 上的 --dsw-* 主题 token（字体/配色/暗色）。
 *
 * 服务端半边（lib/plugin.js）的 /comfyui-prompt/api/* 桥接不变；壳组件同源 fetch 即可。
 * 本文件手写、无构建步骤；只用基线共享模块 react，故无需 dsh.client.external。
 */

window.__ModuleLoader__.load({
  id: "comfyui-prompt-tool",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");

    /** 侧栏入口 id，同时是 main 面板的键 */
    const PANEL_ID = "comfyui-prompt";
    const DEFAULT_PREFIX = "/comfyui-prompt";
    let appUrl = `${DEFAULT_PREFIX}/src/ui/app.js`;

    /** 侧栏图标：图片 glyph，颜色用 currentColor 以跟随侧栏选中/未选中态 */
    function ComfyIcon({ size }) {
      const edge = size ?? 20;
      return react.createElement(
        "svg",
        {
          width: edge,
          height: edge,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        react.createElement("rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }),
        react.createElement("circle", { cx: 8.5, cy: 10, r: 1.5 }),
        react.createElement("path", { d: "M21 15l-5-5L5 21" }),
      );
    }

    /** 工作区面板：同文档挂载原生 UI，继承宿主主题 */
    function ComfyPage() {
      const ref = react.useRef(null);
      react.useEffect(() => {
        const container = ref.current;
        if (!container) return undefined;
        let cancelled = false;
        let dispose = null;
        const controller = new AbortController();
        container.textContent = "正在加载 ComfyUI 提示词工具…";
        (async () => {
          try {
            const mod = await import(appUrl);
            if (cancelled) return;
            container.textContent = "";
            dispose = await mod.mount(container, { embedded: true, signal: controller.signal });
            if (cancelled) {
              dispose?.();
              dispose = null;
            }
          } catch (error) {
            if (!cancelled) {
              container.textContent = `ComfyUI 提示词工具加载失败：${error?.message ?? error}`;
            }
          }
        })();
        return () => {
          cancelled = true;
          controller.abort();
          dispose?.();
          dispose = null;
        };
      }, []);
      return react.createElement("div", {
        ref,
        className: "comfyui-prompt-panel",
        // 不要在这里写 overflow：mount() 会把 cp-root 类加到本 div，
        // 内联 overflow 会压过 .cp-root 的 overflow:auto，导致内容被裁且无滚动条。
        style: { height: "100%", minHeight: 0 },
      });
    }

    const inject = ["slots"];

    function apply(ctx, config = {}) {
      const prefix = `/${(config.prefix ?? DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "")}`;
      appUrl = `${prefix}/src/ui/app.js`;
      ctx.slots.inject("main", function* () {
        yield ctx.slots.register({ name: "main", key: PANEL_ID }, ComfyPage);
      });
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: 10,
            label: () => "ComfyUI 提示词",
          },
          ComfyIcon,
        ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});