# SmallPen 验收规格

更新：2026-09-23。验证契约，不是测试执行报告。

## Problem Statement

单测通过、截图存在或接口成功，不能证明用户改对对象、保存成功或重开仍正确。
需要精简重复测试，同时保留能发现实际回归的场景。

## Solution

主验收链：公开 UI/CLI 操作 → canonical 来源与视觉结果 → 撤销/重做 → 刷新重开。
成功路径配关键反例，日志与截图不写进规格正文。

## User Stories

1. 作为评审者，我希望知道实际修改的源对象，以免把视觉变化误当正确写回。
2. 作为评审者，我希望撤销、重做与重开一致，以便确认持久化链路。
3. 作为评审者，我希望测试使用真实入口，以免绕过产品缺陷。
4. 作为评审者，我希望视觉比较输入一致、差异有依据，以免漏报或误报。
5. 作为维护者，我希望验证错误、并发与外部更新，以免只覆盖顺利路径。
6. 作为维护者，我希望去除重复用例但保留不同失败模式，以便降低维护成本。
7. 作为使用者，我希望发布包和 Desktop 单独验证，以免源码 smoke 冒充交付验收。
8. 作为评审者，我希望区分失败与未运行，以免沿用过期结论。

## Implementation Decisions

### A1 · 证据与隔离

- 记录构建/源码版本、包 revision、目标身份、环境与入口；使用用户包隔离副本，原包 hash 不变。
- UI 测试实际触发控件/快捷键/手势；直接写底层数据只可准备 fixture，不能证明 UI 通过。
- 写操作检查目标 source diff 和不应变化的对象；失败零部分写入，之后合法操作仍成功。
- 运行态测量与 DS 装饰不算源修改；取消、无变化失焦、只读预演均零 revision。
- 保存确认后检查重开；外部更新涵盖空闲、pending edit、持久化窗口，不靠任意延时掩盖竞态。

### A2 · 核心场景矩阵

| 能力 | 必测行为与反例 |
| --- | --- |
| 普通页面 | 图层增删、改名、移动、重排，原子保存及逆操作、重开一致 |
| 样式布局 | fill/stroke/radius/opacity/text/effect/layout，同 revision 同目标 Web/CLI 对照 |
| Token | 绑定/清除/Context；DTCG 警告、只导入选中子集、重开不扩写 |
| 组件 | UI 创建 → Assets 手势放置 → 至少两种合法 variant → 嵌套 override → 主定义更新 → 重开 |
| Library | 多本地库 link/unlink 引用保护；远程真实刷新、离线、重开、失败恢复 |
| Media/Font | 真实 blob、放置/crop；字体 family/weight/style 及改名/删除一致 |
| 历史 | 样式/文本/几何/组件/Token 撤销重做后源与画布一致，无幽灵对象 |
| 多端编辑 | 两标签均实际编辑；外部 CLI 更新与 pending 冲突恢复，无串包迟到响应 |
| 无效源 | 有/无 pending 两种 Repair，保留有效视图，恢复仅执行一次有效重载 |
| Viewer | 无 position-data 缓存文字仍可见且零写源；正反导航、固定滚动、约束 resize |
| 场景隔离 | editor locked/visible、viewer 隐藏、export fill 隐藏各自生效 |
| DS | 独立清单核对全量组合、准确来源写回、结构前置拒绝，遵守 DS 规格 |
| 发布 | 打包 CLI、Node 版本及平台入口；Desktop 启动/打开/退出与子进程回收 |

### A3 · 视觉正确性

- 对比固定 source revision、目标、字体、主题、viewport、DPR、zoom；HTTP 成功或截图张数不是证据。
- 覆盖线宽/cap/join/圆角/裁切、glyph/字重/基线/换行/行高/字距、几何/光学校准及前后图标间距。
- 覆盖图片比例/crop/alpha、本地和远程 SVG、嵌套布局 bounds/gap/padding/order/fill/resize。
- 覆盖 rotation/gradient/shadow/layer blur/background blur，定位差异区域并说明原因。
- 负控发现移动 1px、描边 1→2、粗体→常规、头像旁文字移动 1px；不能统一以抗锯齿搪塞。

### A4 · 测试精简边界

- 同入口、契约、失败模式可参数化；不同来源、格式边界、事务失败或手势不能因名字相似删除。
- 保留正式 fixture、源码和最小复现；一次性截图、日志、临时包不作为长期需求文档。
- 复用端到端、source adapter 往返和渲染测试；内部 mock 不替代公开行为验收。
- 临时数据使用隔离目录，不在正式 fixture 旁生成时间戳副本；运行当前构建，不使用过期 dist。
- 测试输出先落日志再读，保留退出码；编译不能替代 lint、format 或 UI 验收。

## Testing Decisions

- 分别报告实现情况、自动测试、真实 UI 验收；结论用 PASS/FAIL/NOT RUN，注明证据版本。
- 至少 500 Token、100 variants 验证 DS 性能，记录设备、生成/更新耗时与可交互性；普通页回归可用 20 页。
- 不能用隐藏组合、极小字或空白画布提升指标；不臆造尚未约定的耗时通过阈值。
- Web、发布 CLI、Desktop 分别报告，CLI smoke 不等于 Desktop 通过，未运行须解释。

## Out of Scope

- 不把旧 Done 转成 PASS，不照搬旧卡每个步骤，不把运行日志或截图塞回规格。
- 文档整理不代表已精简测试代码、补齐验证或修复产品。

## Further Notes

待验证/待完成项不得因文档清理而关闭：

- DS 全组件属性写回，尤其嵌套非白名单 override；纯组件变更的全部副本更新和增量行为。
- 保存失败乐观回滚与队列恢复；源新建组件到 DS 编辑的完整 UI 生命周期。
- Assets 实际放置手势、合法 ComponentSet UI、原型反向 C→B 导航。
- 大规模性能、Desktop 实际运行、缺失的 CLJS lint/format 检查。

规则见 [产品规格](PRODUCT-SPEC.md)、[DS 规格](DESIGN-SYSTEM-SPEC.md)；旧编号见 [来源导航](SPEC-MIGRATION.md)。
