# ComfyUI 提示词整合工具

DeepSeek Harness（dsh）插件：把碎片文本或图片整理成可直接粘贴进图像模型的英文提示词。面板嵌入 dsh 工作区，模型、附件和凭据全部由宿主提供。

```text
碎片文本 / 图片
  -> 插件系统提示词 + 仓库原生技能（SKILL.md）+ 用户输入
  -> ctx.llm 单次调用
  -> 服务端解析 { prompt_en, translation_zh, notes }
  -> UI 显示英文提示词 / 中文翻译 / 补充说明
```

生成、技能加载、提示词组装和结果校验都在插件服务端；浏览器只负责输入、目录展示和渲染。未连接 dsh 时面板会明确报错，没有独立演示模式或模拟模型输出。

## 安装

要求 DSH `0.2.2-rc.1` 及以上、`0.3` 以下（见 `package.json` 的 `engines.dsh`），并确保 `pnpm` 在 `PATH` 中（`dsh plugin` 会把参数转发给 pnpm）。插件以 Git 依赖安装，不需要克隆仓库：

```bash
dsh plugin --profile web add "git+https://github.com/self-exiler/DSH-Comfyui-Prompt-Generator.git"
```

仓库根是一个 dsh 组合包（`package.json` 的 `dsh.bundle`）：安装成功后 dsh 自动把 `comfyui-prompt-harness-plugin` 加入 `dsh.profile.bundles`，再由根目录的 `cordis.patch.yml` 插入插件行；浏览器半边由 `plugins/comfyui-prompt` 的 `dsh.client` 声明提供。无需手工编辑 `~/.dsh/profiles/web/cordis.patch.yml`。

重启 `dsh web`，从侧栏打开「ComfyUI 提示词」。需要改挂载前缀、根目录或系统提示词时，按行 id `comfyui-prompt-tool` 在 profile patch 中覆盖 `config`（`prefix`、`root`、`systemPrompt`，见[系统提示词](#系统提示词)）。

升级时先移除再安装（Git 依赖不跟随版本号）：

```bash
dsh plugin --profile web remove comfyui-prompt-harness-plugin
dsh plugin --profile web add "git+https://github.com/self-exiler/DSH-Comfyui-Prompt-Generator.git"
```

本地开发把仓库本身链接进 profile，改完代码重启 `dsh web` 生效：

```bash
dsh plugin --profile web add "link:<仓库绝对路径>"
```

## 插件路由

```text
GET  <mount>/api/models    模型目录（ctx.llm）
GET  <mount>/api/skills    仓库原生技能目录（仅名称与简介，正文不下发浏览器）
POST <mount>/api/generate  输入 + modelId + skillName -> 三段结果
GET  <mount>/src/*         面板静态资源（仅 src/ 目录）
```

`api/generate` 由服务端完成输入与图片校验、技能解析、消息组装、单次 `ctx.llm.stream()`、三段 JSON 解析和错误阶段映射。客户端断开时 AbortSignal 会传给宿主取消调用。

## 系统提示词

系统提示词有两个来源，插件配置优先：

1. `~/.dsh/profiles/web/cordis.patch.yml` 中 `comfyui-prompt-tool` 的 `config.systemPrompt`；
2. 未配置时读取 `prompts/system.md`（跟随 `config.root`）。

提示词只在服务端使用，浏览器不会读取或提交系统提示词。

## 原生技能

- 技能是 `skills/<name>/SKILL.md`，frontmatter 必须包含 `name` 与 `description`；
- 插件向 `ctx.skills` 注册 `comfyui-repo` provider，只扫描本仓库 `skills/`；
- 其他项目、用户或 Agent preset 中的技能不会进入本面板，也不会被用于生成；
- `/api/skills` 和生成入口都会再次校验最终文件路径位于 `skills/` 下。

技能正文原样注入；Anima 的本地模板读取和 MOSS 的坐标编译不会执行，要求技能在无工具条件下仅依赖 `SKILL.md` 内的规则。

## 开发

```bash
npm test            # node:test 单元测试（无需宿主）
npm run check       # 全仓 JS 语法检查
```

运行时要求 Node >=20、DSH >=0.2.2-rc.1（见 package.json `engines`）。

## 目录结构

```text
package.json         dsh 组合包声明（dsh.bundle）与开发脚本
cordis.patch.yml     组合包补丁：插入 comfyui-prompt-tool 插件行
src/core/
  errors.js          错误码、TaskError、脱敏
  prompt.js          系统契约 + 技能 + 用户消息组装（含图片格式白名单）
  task.js            三段 JSON 解析与校验
src/host/
  http-bridge.js     浏览器 -> 插件的唯一通道
src/ui/
  index.html         同源整页入口（联调使用）
  panel.html         工作区面板片段
  app.js             面板状态、目录、输入、结果渲染
  styles.css         dsh token 作用域的样式
prompts/system.md    默认系统提示词
skills/              仓库原生技能
plugins/comfyui-prompt/
  lib/plugin.js      dsh 服务端：静态资源 + API + 生成
  lib/repo-skills.js ctx.skills provider（仅仓库 skills/）
  lib/client.js      dsh 侧栏入口与工作区挂载
tests/               node:test
tools/
  check-syntax.js    语法检查
```

依赖方向：`ui -> host -> HTTP`；服务端直接复用 `core`。

## 已知限制

- 一次直出、无工具：原生技能中“按需读文件 / 运行编译器”的步骤无法执行；
- 技能自带的正负面、参数和自检并入 `notes`，不是一一对应；
- 文本、图片补充说明与模式通过 `localStorage` 尽力持久化，图片本体不保存。

## 致谢

- Moss技能来源：[github.com/OpenMOSS/MOSS-Image](https://github.com/OpenMOSS/MOSS-Image)
- Anima技能来源：[github.com/Nana7mi0721/anima-prompt-mixed](https://github.com/Nana7mi0721/anima-prompt-mixed/)
