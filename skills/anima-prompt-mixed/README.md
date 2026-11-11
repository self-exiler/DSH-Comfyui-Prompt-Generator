# anima-prompt-mixed

一个 Agent Skill，把任意输入转成 [Anima](https://huggingface.co/circlestone-labs/Anima) / Anima3 的**「标签 + 自然语言」混合英文提示词**。

**输入不限语言与形态**——中文场景描述、纯标签组、其他模型（SD / Danbooru / Pony 等）的提示词都可以，一律解析后按 Anima3 槽位重组。

## 输出形态

每次输出**两个独立代码块**（正面 / 负面），可直接复制：

- **正面**：仅 1 行。tag 链为主体，按固定槽位顺序排列；**自然语言短句统一放在所有 tag 之后**（prompt 末尾）
- **负面**：5~12 项，按「必需层 / 按需层 / 可选层」三层结构组装
- 不输出 Params

```
[count/gender] → [character/series] → [@画师名?] → [appearance] → [clothing/state]
→ [pose/action/sex] → [expression/reaction] → [camera/shot] → [scene/environment]
→ [detail/mood] → [自然语言补充]
```

## 安装

把本仓库放到你的 skill 目录下：

```
<skills-dir>/anima-prompt-mixed/
├── SKILL.md
└── assets/
    └── 模板.txt          # Anima3 提示词模板 v3.0（规则框架 + 标签库，2134 行）
```

核心要求是 `SKILL.md` 位于 skill 根目录，且其 YAML frontmatter 中的 `name` / `description` 被框架识别。

`assets/模板.txt` 是标签库来源，**按需读取**——SKILL.md 里标注了各章节的行号，读到哪一节取哪一节的词库即可。

## 它做什么

| 步骤 | 内容 |
|---|---|
| 1 | 解析输入：提取人数、角色、服装、动作、体位、场景、视角、特殊主题、画师名 |
| 2 | 剥离丢弃：质量词、权重语法 `(tag:1.2)`、光线/光影/色调标签、负面词段 |
| 3 | 匹配场景类型（§5 决策树），确定槽位侧重与镜头推荐 |
| 4 | 特殊主题命中 §14 时，先读模板对应章节取跨槽位配方 |
| 5 | 按槽位顺序填 tag，缺失槽按规则补 |
| 6 | 判定末尾自然语言（多人归属 / 复杂构图 / 特殊姿势 / 分镜 / 剧情性观众关系） |
| 7 | 互斥检查 → 7 项自检 → 输出 |

## 关键设计

- **混合协议（H-1~H-4）**：tag 为主体，自然语言**仅在 tag 无法准确表达时**使用——角色间动作关系、复杂构图、特殊姿势组合、分镜关系、多角色归属。NL 与 tag 不重复、不矛盾
- **画师名处理**：输入含 `@画师名` 或明确画师名时保留（放在 character/series 槽之后）；输入中没有则不输出
- **明确禁令**：不输出质量词、权重语法、光线/光影/色调标签（允许环境天气如 rain/snow/fog/steam）
- **互斥表**：视角 / 身份 / 服装 / 动作 / 细节过度五类冲突逐项排除
- **数量控制**：单人 16-30、双人 22-38、复杂 30-48（自然语言短句不计入）

## 目录结构

```
SKILL.md              工作流 + 槽位顺序 + 混合协议 + 互斥表 + 自检清单 + 输出示例
assets/模板.txt        Anima3 提示词模板 v3.0（§0 快速开始 ~ §15 EXAMPLES）
```

模板章节：`§1 ROLE` / `§2 OUTPUT PROTOCOL` / `§3 自检` / `§3.1 互斥表` / `§4 槽位顺序` / `§5 决策树` / `§6 COUNT & IDENTITY` / `§7 APPEARANCE` / `§8 CLOTHING & STATE` / `§9 POSE & ACTION & SEX` / `§10 EXPRESSION` / `§11 CAMERA & SHOT` / `§12 SCENE` / `§13 DETAIL & MOOD` / `§14 SPECIAL THEME` / `§15 EXAMPLES`

> `§15 EXAMPLES` 目前是占位章，待补充跑图验证过的完整案例。

## 相关 skill

- **anima-lora-config** —— Anima LoRA 训练配置生成（含《Anima LoRA 调参指南》）
- **anima-style-lora-caption** —— LoRA 数据集打标 / 洗标（含《Anima 打标指南》）

## 许可

MIT，见 [LICENSE](LICENSE)。
