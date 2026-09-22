# Design System 产品规格

更新：2026-09-23。最新用户决定优先；这是目标规格，不是完成证明。

## Problem Statement

用户需要一眼看全真实 Token 和组件组合，并能安全调整源参数。
长条罗列、调试文案、不完整样本和来源不明的编辑，使展示难读且可能改错对象。

## Solution

从当前 Package snapshot 动态生成原生 DS 画布：左侧简洁 Token 分块，右侧组件多维矩阵。
全部有效组合同时展开，不再提供 DS 悬浮组合切换器。只展示 Token 与组件，不展示 Pages。

## User Stories

1. 作为设计者，我希望所有 Token 按类型展开，以便直接理解设计系统。
2. 作为设计者，我希望颜色、圆角、间距等展示真实效果，以便直观比较数值。
3. 作为设计者，我希望字体只集中展示 Typography，以免六类底层属性重复占位。
4. 作为设计者，我希望所有真实组件及有效组合都出现，以免漏看未使用或无文字组件。
5. 作为设计者，我希望组件按有意义的行列与分组排列，以免画布无限长或宽。
6. 作为设计者，我希望标题、值和状态说明简洁清晰，以免被内部参数淹没。
7. 作为设计者，我希望在 DS 修改 Token，以便同步更新真实使用者。
8. 作为设计者，我希望支持的组件属性能准确回写，以免改错主定义或嵌套实例。
9. 作为设计者，我希望结构修改引导到源页，以免在生成页添加刷新即丢的内容。
10. 作为设计者，我希望源新增组件自动出现，以便不用维护第二份展台。
11. 作为设计者，我希望保存、撤销、重做及刷新一致，以便信任编辑结果。
12. 作为设计者，我希望失败、冲突和只读资源明确提示，以免假成功或卡住队列。
13. 作为设计者，我希望更新保留视口和选择，以便连续编辑。
14. 作为设计者，我希望 Token 管理超宽时仍可滚动和添加变量，以免操作被遮挡。

## Implementation Decisions

### D1 · 原生投影与隔离

- 使用原生 workspace 的 shapes、图层、选择、属性、渲染、历史与提交链；不另建 SVG 编辑器、iframe 或截图展台。
- 生成页、白底、标题、标尺、caption、矩阵布局不写 canonical，不计入普通 Pages、导出、缩略图或原型。
- 普通源页面保留且照常编辑；DS 不再铺 Pages、页面组合或未注册 Header。
- 按 canonical 独立清单核对 owner/identity/variant/occurrence/revision，不能从投影结果反推预期。
- 同名不同 owner、未使用/未激活、alias、无文字、纯白/透明、located 及只读来源不得静默遗漏。
- 展示身份稳定且区别于源身份；父子关系一致，无重复 children、悬空引用或循环展开。
- 展示坐标不回写源 x/y；bounds、selrect、points、transform、命中和测量一致，测量簿记不产生源历史。

### D2 · Token 展示

canonical 共 20 类型：boolean、border-radius、color、dimensions、font-family、font-size、
font-weight、letter-spacing、number、opacity、other、rotation、shadow、sizing、spacing、
string、stroke-width、text-case、text-decoration、typography。dimension 归一为 dimensions，不另计类型。

主画布 14 分区：六种单字段字体类型不单列，合为 Typography 视觉展示；Token 管理仍保留全部 20 类型。
类型数、Cell 数与组合样本数分别统计，空分区保留简洁空态，不造假数据。

| 类型 | 展示契约 |
| --- | --- |
| color | 真实小色块；白色边框、透明底纹 |
| border-radius | 同尺寸矩形展示圆角；显示钳制不改源值 |
| spacing | 两块间距，标尺端点准确落在被测边缘 |
| sizing / dimensions | 基础几何与真实宽高标尺，不测外壳冒充 Token |
| stroke-width | 真实线宽与数值，可通过正常属性协议往返 |
| typography | 实际字体、字重、字号、行高、字距，说明缺字体/fallback |
| shadow | 真实颜色、offset、blur、spread，不压成统一灰影 |
| opacity / rotation | 矩形透明度、有方向的旋转样本 |
| boolean / number / string / other | 清晰值卡，复杂值有摘要和完整详情入口 |

- 各类型全部 Cell 与有效组合稳定排列；不再造 Gap/Padding/Margin 三套复杂演示。
- 画布只放短名称、视觉与值；owner、路径、literal/alias、active/archived 等放详情。
- 零值、极值、长文本、空集合不重叠；缩放/钳制说明清楚，不改源、不误标单位。
- 标题和说明使用可读字号与语义前景色，不继承黄色调试文字。

### D3 · 组件多维矩阵

- 右侧白底，Primitive 在前、Composite 按依赖层级在后；缺失/循环依赖局部诊断。
- 读取声明的 state、size、style、content、icon/media、position、slot 等轴；不按名字猜，不造 canonical variants。
- 组件属性轴与 Theme/Token 轴分开；展开实际有效组合，不盲目生成无效笛卡尔积。
- 差异明显的轴作行列，其余分为有标题的小矩阵；按数量与实际 bounds 平衡二维、三维、四维及更多轴。
- 全量存在且分块换行，不靠分页/折叠/切换/抽样隐藏；宽组件保持实际尺寸，长标签仍可区分。
- 样本覆盖 Button 前/后图标、纯图标、纯文字、透明及其他声明样式/状态；常用例有 Title、Input、Badge、Card、Dialog。
- 示例包提供定义，产品不得硬编码名称/数量；真实树、媒体、路径、布局、绑定和嵌套 override 均保留。
- 源创建/修改/删除及 Undo/Redo 自动反映；失败不留幽灵组件，零数量不能使源创建入口消失。

### D4 · 编辑边界与目标

| 对象/动作 | 规则 |
| --- | --- |
| Token | 写明确 owner/set/Cell/field；复合值只改选定字段 |
| definition / variant / node 属性 | 写对应真实源，不按名称、排序猜目标 |
| 嵌套实例属性 | 写支持的 occurrence override，不误改共享主定义 |
| alias / 继承 | 区分引用表达式、引用源、当前覆盖与显式 literal |
| 只读/歧义/未支持字段 | 提交前解释并拒绝，不假成功 |
| 背景/标题/标尺/矩阵壳 | 生成装饰，不允许作为源编辑 |
| 加框/字/图、粘贴、删除、编组、移动及结构布局重排 | 到源页操作；DS 前端提前拒绝，后端独立校验 |

- 上下文固定 revision、owner、family/variant、node、occurrence path、field；可查来源与影响范围，切选择不能偷换目标。
- 保留选择、深选、图层定位、平移缩放及支持属性编辑，不把 DS 全锁只读；普通页不受限。
- 绘制快捷键、拖图、粘贴和批量 change 共用策略；非法操作不进本地 commit/Undo/保存队列，也不先上传再拒绝。
- 使用原生文本、填充、描边、圆角、尺寸、透明度、效果控件；未接通字段明确列缺口，出现控件不等于支持。
- alias 表达式与解析预览分开；循环/缺引用/类型错误/非法值拒绝；unset 不等于零，不能误解除其他绑定。
- 多选同源去重；冲突值或无法原子完成的跨 owner 编辑整批拒绝，后续独立合法动作可继续。

### D5 · 保存、历史与更新

- 单一原生 changes → source adapter → canonical/session → 历史/重投影链，不二次保存生成页。
- 一次用户动作一个撤销步骤；取消零写入，复合值保留未编辑字段，源确认成功才显示 saved。
- 区分 clean/draft/invalid/submitting/saved/error/stale；失败恢复乐观态并保留可恢复输入，旧 revision 不覆盖新源。
- 外部更新刷新受影响内容；切包释放订阅、拒绝迟到响应；目标消失清选择并提示，不整体崩溃。
- 所有依赖样本及普通页同步，保留稳定身份/选择/视口，优先增量更新，不以隐藏样本换性能。
- 首次合理 fit，随后尊重用户视口；定位、fit selection 和长距离导航保持可用。

### D6 · Token 管理

- 与 DS 展台分工，保留全部类型和项目主题管理；这不是 DS 悬浮切换器。
- 分类栏、数值表超宽可横向滚动到末尾，添加变量/右侧操作固定可达。
- 菜单不被滚动容器裁切，滚动关闭过期位置菜单；窄窗口和键盘操作仍可达。

## Testing Decisions

- 复用现有 DS 编辑门禁、投影、组件样本及端到端流程；统一遵循 [验收规格](ACCEPTANCE-SPEC.md)。
- 独立源清单逐身份核对；覆盖空类型、同名 owner、白色/透明/alias、无文字、located、只读及坏依赖。
- 每种支持编辑通过真实控件 → source diff → Undo → Redo → 刷新；共享联动且其他组合/硬编码对象不误改。
- 两层以上嵌套分别验证 master 和 override；从源新建组件后进入 DS 编辑，检查身份与持久化。
- 校验画布/图层选择与实际 bounds、换行/多矩阵/超宽样本完整性。
- 非法结构动作零源写入，普通页同动作有效；覆盖失败、stale、外部更新、切包、目标删除、迟到响应。
- 至少 500 Token、100 variants；Web/Desktop 分别报告，不能拿旧截图/总测试数宣称通过。

## Out of Scope

- DS 内结构创建和编辑、Pages 展台、专属悬浮组合切换器、独立编辑器、静态副本均不交付。
- 本次不新增双视口功能；也不把历史双栏方案默认为已取消或已完成。

## Further Notes

待完成/验证：组件全部字段尤其嵌套非白名单写回、纯组件修改所有副本及增量更新、
失败回滚/队列恢复、源新建到 DS 编辑 UI 生命周期、大规模性能、Desktop、缺失的 CLJS lint/format。

历史双原生视口方案保留待确认：若恢复，必须共源/revision/历史，独立观察组合/视口且只有一个明确活动编辑目标。
Dark override 不误改 Light/base；Mobile/Desktop 按真实布局约束求值，不能用 CSS 缩放或竞争 store 替代。

旧编号与需求变更见 [来源导航](SPEC-MIGRATION.md)。旧测试若断言 Pages/悬浮切换器/DS 结构编辑，应按本规格改验收，不能只删断言。
