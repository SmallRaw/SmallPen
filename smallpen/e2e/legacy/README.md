# Legacy e2e — 旧独立画布预览（DSC 时代）

本目录的测试描述并守护 **旧独立 SVG 画布入口**（`canvas.cljs` +
`canvas-renderer.js`，路由 `#/design-system` 挂 `canvas-page*`），即
DSC-009/010/011/012 的历史交付。当前契约见
[Design System SPEC](../../docs/DESIGN-SYSTEM-SPEC.md)。

它们 **不是** Design System Editor（DSE）的验收入口：

- `design-system-canvas.mjs:87-88` 曾断言 `viewport` 数量为 0（“编辑器必须离
  开本路由”）——这与 DSE 的目标（普通原生编辑器挂载系统页）方向相反。
- 通过这些测试只能证明旧 SVG 路径可用，不能作为任何 DSE 卡的通过依据。

当前 DSE 验收入口是 [../design-system-editor.mjs](../design-system-editor.mjs)。

这些文件保留原断言不动，作为历史行为基线；待 DSE-029（旧入口退役）执行时
一并归档或删除。
