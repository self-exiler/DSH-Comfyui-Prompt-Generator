# ComfyUI 提示词整合工具

DeepSeek Harness（dsh）插件：把碎片文本或图片整理成可直接粘贴进图像模型的英文提示词。面板嵌入 dsh 工作区，模型、附件和凭据全部由宿主提供。

```text
碎片文本 / 图片
  -> 插件系统提示词 + 仓库原生技能（SKILL.md）+ 资源清单 + 用户输入
  -> 后台受限 Agent（只读工具 read_file / list_files）
  -> 宿主 Agent 工具循环 + 模型
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

重启 `dsh web`，从侧栏打开「ComfyUI 提示词」。需要改挂载前缀、根目录或系统提示词时，按行 id `comfyui-prompt-tool` 在 profile patch 中覆盖 `config`（`prefix`、`root`、`systemPrompt`，见[系统提示词](#系统提示词)）。生成引擎和工具行为也可在同一 `config` 中覆盖：

```yaml
config:
  engine: agent        # agent（默认）| direct
  agentTimeoutMs: 180000
```

`engine: direct` 强制回到无工具的一次直出。工具只包含技能目录内的只读文件/知识查询，脚本类工具不会注册也不会执行。

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

`api/generate` 由服务端完成输入与图片校验、技能解析、消息组装、生成和三段 JSON 解析。默认走后台受限 Agent：每次请求创建一个临时 Agent 会话，只注册技能目录内的读取工具，并拒绝宿主全部全局工具；生成结束立即释放。宿主缺少 `agents`、`tools` 或 `systemPrompt` 服务时自动回退到一次 `ctx.llm.stream()` 直出。客户端断开时 AbortSignal 会传给宿主取消调用。

未手动选择图片模型时，图片模型下拉会优先跟随当前文本模型所在的 Provider；如果该 Provider 没有视觉模型，再回退到第一个可用视觉模型。

## 系统提示词

系统提示词有两个来源，插件配置优先：

1. `~/.dsh/profiles/web/cordis.patch.yml` 中 `comfyui-prompt-tool` 的 `config.systemPrompt`；
2. 未配置时读取 `prompts/system.md`（跟随 `config.root`）。

提示词只在服务端使用，浏览器不会读取或提交系统提示词。

## 原生技能

- 技能是 `skills/<name>/SKILL.md`，frontmatter 必须包含 `name` 与 `description`；
- 插件向 `ctx.skills` 注册 `comfyui-repo` provider；面板直接读该 provider，只扫描本仓库 `skills/`，不受宿主同名技能遮蔽；
- 其他项目、用户或 Agent preset 中的技能不会进入本面板，也不会被用于生成；
- provider 的 `get` 会再次校验最终文件路径位于 `skills/` 下。

技能正文以 dsh 内核形状的 `<skill_content>` 注入，并附带 `<skill_resources>` 资源清单。后台 Agent 可调用：

- `list_files`：列出技能目录内的文件与大小；
- `read_file`：按行窗口读取技能目录内的文本，路径经 `realpath` 限制在技能目录内。

因此 Anima 的 `assets/模板.txt` 可以按章节读取，MOSS 的 `references/layout.md` 也可以读取。技能 `scripts/` 下的脚本不会执行；MOSS 的 Layout 需要模型按 `layout.md` 的规则直接产出坐标。

脚本类工具已从运行时移除，只保留文件/知识查询能力；其他项目、用户或 Agent preset 中的技能仍然不会进入本面板。

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
  prompt.js          系统契约 + 技能 + 用户消息组装（含 Agent 技能资源块与图片格式白名单）
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
  lib/agent-engine.js 后台受限 Agent：临时会话、scoped 工具、事件收集
  lib/skill-resources.js 技能资源清单、read_file/list_files（只读）
  lib/client.js      dsh 侧栏入口与工作区挂载
tests/               node:test
tools/
  check-syntax.js    语法检查
```

依赖方向：`ui -> host -> HTTP`；服务端直接复用 `core`。

## 已知限制

- Agent 引擎依赖宿主提供 `agents`、`tools`、`systemPrompt`，并要求所选模型支持工具调用；缺失时自动回退到一次直出，也可用 `config.engine: direct` 强制回退；
- 每次生成会创建一个 `origin=subagent` 的临时 Agent 会话，不设置 `cwd`，结束后 `dispose()`；生成期间它可能短暂出现在宿主会话列表中，冷列表不会保留；若宿主启用了会话持久化，仍可能留下内部会话文件；
- 只保留文件/知识读取工具，技能 `scripts/` 下的脚本不会执行；MOSS 的坐标编译需要模型按 `layout.md` 直接产出，或由用户另行运行脚本；
- Provider 额度不足或限流时不会自动跨 Provider 回退；错误提示会建议切换模型，识图请选择支持图片且可用的 Provider；
- 技能自带的正负面、参数和自检并入 `notes`，不是一一对应；`prompt_en` 仍是唯一直接交付的正文；
- 文本、图片补充说明与模式通过 `localStorage` 尽力持久化，图片本体不保存。

## 致谢

- Moss技能来源：[github.com/OpenMOSS/MOSS-Image](https://github.com/OpenMOSS/MOSS-Image)
- Anima技能来源：[github.com/Nana7mi0721/anima-prompt-mixed](https://github.com/Nana7mi0721/anima-prompt-mixed/)
