# CLI 与场景 Skill

SmallPen 是通用设计画布和素材工具。设计包是一组 HTML 文件，AI 直接编辑；CLI 负责检查、查看、导出和报告改动，Skill 提供场景里的使用规则。

## CLI

AI 不安装 Skill，也能通过 `help` → `help OBJECT` → `help OBJECT ACTION` → 返回的 schema 查询独立学会 CLI。文件格式由 `help rules format`（文件、元素、属性、尺寸）和 `help rules classes`（Token 变量和 class）说明，完整规范见 [HTML-FORMAT.md](HTML-FORMAT.md)。

`init PATH` 创建空白包：`index.html` 和 `tokens.css`，没有 Token、组件和页面。拒绝已存在的目标。公开入口不收集业务问卷。

每次改完文件运行 `smallpen check PACKAGE`：每个问题一行，带文件、行、列和改法；有错误时退出码为 1。`check` 同时是闸门：通过的版本被接受；有错误时，不出错的改动照样接受，出错的文件被拒绝，`check --revert` 把它们恢复成已接受版本（多个 AI 并发时用 `--file PATH` 只退回自己的文件）。`--render` 再加上渲染检查。`check` 报出的 revision 会被记住，之后可用 `changes --since` 问这之后改了什么，包括人在 App 里的修改。

现在的 CLI：`init`、`check`、`view`、`export`、`changes`、`token list|export`、`help`、`schema`、`version`。查页面、组件、素材、连线，AI 直接读文件。

`help rules` 按需说明主题、Token、组件、目标、输出、文件和检查的技术规则。旧 `help workflow` 查询同一组规则。

主题组和选项写在 `tokens.css`（`:root[data-GROUP="option"]`），项目默认值写在 `index.html` 的 `<html data-GROUP="option">`。省略 `--theme` 使用默认值，`--theme` 只覆盖本次调用的指定组；查询不保存组合，也不改 App 当前选择。

查询从小数据开始，输出紧凑 JSON。大结果放入可搜索的结果文件；文字描述和线稿先行，PNG 明确请求。文件名随机且格式固定，半小时前的旧临时文件按现有规则清理；正式交付用 `--output`。

`export PACKAGE --format html --canvas NAME --output DIR` 从包内真实页面、版本与原型入口生成离线评审网页，含模块分组、搜索、原生 PNG、可见节点的实际热区、前进返回及本地规格/证据链接。`--page NAME` 导出该页全部版本，`--platform` 可缩小到一个版本；省略页面/画布只允许唯一画布，多个画布必须明示。主题只导出本次一组组合。PNG、规格、线稿和证据共享同次 native solve，manifest 记录 revision、hash、页数和连线覆盖。

网页只执行已声明的 click/navigate（所选页面根）和 click/prev-screen；overlay、其他触发、同一源多动作、范围外目标、隐藏源和缺失 native geometry 都明确 unresolved，不猜热区，不模拟录音、保存或真实业务。输出目录必须在源包之外且为新建/空目录，不清空旧内容；全部产物完成后最后写入 index。网页及静态资源可直接离线打开，无外部服务请求。这是 CLI 的通用导出能力，Skill 无需维护手写页面目录或业务模拟器。

## 生成与安装

`help rules start` 给出常用路线：改文件、check、按名字查看、`check --render`，App 改过后用 `changes --since` 接续。
路线与技术规则由 CLI 源码生成到 Skill；完整命令仍按任务发现。
不要求先建完整 Token 或组件库。

共同基础维护在 `skill-src/base.md`，应用规则维护在 `skill-src/ui-design.md`。`npm run build:skills` 从源码取得可变技术规则，组合成独立可安装的 `skills/smallpen-ui-design/SKILL.md`，并复制到 npm CLI 包内。`npm run check:skills` 检查仓库内的正本；发布打包和 `build:cli` 都先生成再附带成品。

`help skills --json` 返回 Skill 的实际文件路径和安装目录，适用于源码、独立 CLI 和 npm CLI。AI 可按该路径读取，也可通过宿主的 Skill 安装机制安装后使用。附带文件、安装成功和本轮实际加载是三件事；Skill 的验收必须让独立 AI 读取交付材料并实际执行任务。

共同基础不复制全部命令或 schema，具体操作仍通过 CLI 查询。以后增加场景时内嵌同一份基础并追加自己的流程。

## 应用设计

1. 首次确认软件用途、用户、主要任务、预计平台和首个交付端。信息完整时直接继续；关键缺项先问，一般视觉细节由 AI 决定并记录。
2. 使用项目既有设计入口；没有时维护一份 `DESIGN.md`，记录规格链接、假设、设计规则、结构差异和验收结果。业务规格可来自设计包或仓库文档，每条规则保留一份正文；Skill 引导读取，设计入口不复制正文。
3. 先复用/定义 Token（`tokens.css`），再制作组件及变体（`components/*.html`），最后组装页面（`pages/`）。AI 在制作时用 Token class 完成绑定，避免交给开发补绑定。
4. 同一业务内容优先共用页面，通过 Token 组合改变宽高、间距、字体和样式；局部结构差异优先变体；整体结构或交互确实差异很大才增加配置或页面，记录理由。缩小视口不允许默默删减能力。
5. 使用同一目标及组合查看、检查和导出，核对实际绑定、组件引用、业务能力和检查覆盖。按需要连接元素触发和目标，验证具体导航步骤。
6. 交付可编辑设计文件、需要的导出和检查说明。原型跳转不等于真实输入、数据保存或应用代码。

同一份 Skill 覆盖两种用法，也允许混用：

- **完整稿和流程**：保存页面及状态，设置起点、触发元素和目标；在页面文件里查 `data-flow` 和 `data-click` 核对要求的分支。实际在 App 中走过的导航另行记录，不能用连线存在代替交互验证。
- **组件系统和内容预览**：先交付 Token、组件、变体和通用页面部件；AI 再写一个用这些组件的样例页面，用 `view`/`export` 获取原生 PNG、规格、线稿和证据。只要求预览时，样例页面写在包的副本里，不留在源包。

预览应记录源包版本、组合、布局 hash 和实际检查结果。保存稿按需进行 App 验收；若要在 App 中看未定的候选，使用独立审阅副本。

当前 Token 能改变已绑定数值，string/boolean Token 可绑定文字和可见性；Token 不能切换布局方向、节点树或组件变体。通用页面结构可由共享部件围绕业务内容组装，当前实例 API 没有任意内容插槽。Skill 要如实报告工具缺口，不假定缺失能力或用整页复制代替复用。

## 后续场景

动画素材主要供 HyperFrames 使用；具体流程和风格统一需求后续细化。漫剧角色设定是多素材、多角度、多动作画板，不要求 Token，暂按用户从外部生成素材后导入组织的流程考虑。这两项的草稿放在 `skill-src/drafts/`，不作为可安装成品。

## 验收

用现有 CLI 黑盒入口验证空白建包、参数发现、直接写文件、check、改动报告和导出；用生成/检查命令验证确定输出及过期检测。已有主题默认、组合覆盖、App 矩阵和投影规则继续使用同一逻辑。自动检查有效不代表视觉或业务验收通过。

安装说明见 [Skill 目录](../skills/README.md)。
