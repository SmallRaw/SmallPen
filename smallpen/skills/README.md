# SmallPen Skills

CLI 的 help/schema 足以独立学习操作。Skill 提供场景里的问询、制作顺序和验收规则。

可安装：[应用设计 smallpen-ui-design](smallpen-ui-design/SKILL.md)。它既能指导完整页面和交互流程，也能指导组件、变体和通用页面部件的制作，以及 AI 填内容后的原生预览。它交付 SmallPen 设计材料，不生成应用代码。动画素材和漫剧角色设定仍是内部草稿。

从仓库生成：

```sh
cd smallpen
npm run build:skills
npm run check:skills
```

编辑 `skill-src/base.md` 和 `skill-src/ui-design.md`，不要直接编辑生成的 `SKILL.md`。生成器从 CLI 契约取得版本、默认/覆盖规则、输出预算和临时文件规则；每个场景都内嵌同一份基础，不依赖另一个 Skill。`build:cli` 和发布打包会重新生成并附带成品；npm CLI 也包含 `skills/`。

已安装 CLI 时，用 `smallpen help skills --json` 查到实际的 `SKILL.md` 路径及所在目录。可直接让 AI 读取，或按宿主的 Skill 安装方式安装该目录。安装不会自动证明当前任务已经加载了 Skill。

本地安装：

```sh
npx skills add ./smallpen/skills --skill smallpen-ui-design
```

使用外部安装器时，按其版本的安装说明操作。本地生成和 CLI 打包不会发布远端仓库，也不会更改用户的全局 Skill 配置。

使用示例：

```text
用 $smallpen-ui-design 设计任务管理应用，需要桌面端和手机端。

用 $smallpen-ui-design 只制作任务系统的组件、变体和通用页头，不保存业务页面。

用 $smallpen-ui-design 复用现有组件填入这批任务内容，生成宽窄两种预览，保留 intent 和图片，不保存到源包。
```

AI 根据请求选择交付范围，已有答案不重复问。读取项目规格并维护同一份设计入口，先复用 Token、组件和变体，再按需要组装页面或未保存的候选。完整稿核对起点和导航分支；内容预览核对配置、长内容、尺寸和主题。检查结果和仍未验证的部分随交付材料保留。

职责和能力边界见 [CLI 与 Skill](../docs/CLI-SKILLS.md)。
