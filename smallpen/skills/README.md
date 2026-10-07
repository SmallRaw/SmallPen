# SmallPen Skills

CLI 的 help/schema 足以独立学习操作。Skill 提供场景里的问询、制作顺序和验收规则。

本轮可安装：[应用设计 smallpen-ui-design](smallpen-ui-design/SKILL.md)。它交付 SmallPen 设计文件，不生成应用代码。动画素材和漫剧角色设定仍是内部草稿，后续再定流程。

从仓库生成：

```sh
cd smallpen
npm run build:skills
npm run check:skills
```

编辑 `skill-src/base.md` 和 `skill-src/ui-design.md`，不要直接编辑生成的 `SKILL.md`。生成器从 CLI 契约取得版本、默认/覆盖规则、输出预算和临时文件规则；每个场景都内嵌同一份基础，不依赖另一个 Skill。`build:cli` 会重新生成并把成品放进 CLI 产物的 `skills/`。

本地安装：

```sh
npx skills add ./smallpen/skills --skill smallpen-ui-design
```

文件发布到远端仓库后，也可安装：

```sh
npx skills add SmallRaw/pen --skill smallpen-ui-design
```

安装表达见 [Skills CLI](https://github.com/vercel-labs/skills)。这里没有执行安装或发布。

使用示例：

```text
用 $smallpen-ui-design 设计任务管理应用，需要桌面端和手机端。
```

AI 先确认软件用途、主要流程、预计平台和首个交付端，已有答案不重复问。维护一份项目规范，先 Token、组件和变体，再组装页面。同一内容优先通过明确的 Token 组合查看、检查和导出；结构差异确实很大才另做配置或页面。

职责和能力边界见 [CLI 与 Skill](../docs/CLI-SKILLS.md)。
