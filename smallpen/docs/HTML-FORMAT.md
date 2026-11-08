# SmallPen HTML 存储格式

更新：2026-11-07。状态：实施中，决定见第 15 节，进度见第 16 节。

## 1. 目标

- `.smallpen` 目录里的文件改成 HTML 子集，外加一个 `tokens.css`。旧 JSON 格式废弃，不做兼容和迁移。
- AI 直接读写这些文件，不再通过 CLI 写入命令。
- CLI 只做三件事：`check` 检查格式和规则；`view`/`export` 渲染预览；`changes` 报告改动。
- 渲染仍用 App 的 WASM 渲染器。子集同时要保证以后能在浏览器里直接显示（配一份生成的样式表和一小段脚本）。

## 2. 总规则

1. 页面和组件文件里只有 class：没有 `style` 属性，没有 `<style>`，没有 `<script>`。
2. CSS 只出现在 `tokens.css`，只能声明 Token、主题和字体。
3. SmallPen 专用信息放在 `data-*` 属性或 `sp-*` 自定义元素上，标准 HTML 解析器都能读。
4. 每样东西只有一种写法。检查器拒绝其他写法，并说明该怎么写。
5. 名字就是身份，文件里不出现 ID。
6. 能推导的不存：弹性布局里的位置和尺寸、文字尺寸、ID、画布坐标都在读取时计算。文件只存设计意图。

## 3. 包结构

```
product.smallpen/
  index.html                          包入口：包名、包 ID、主题默认值
  tokens.css                          Token、主题、字体
  components/*.html                   组件，一个文件可放多个，一个组件一个文件最好找
  pages/<模块>/<页面>[.<平台>].html     页面
  assets/                             图片
  assets/fonts/                       字体文件（TTF、OTF、WOFF）
```

- 路径决定模块和页面名：`pages/Tasks/Board.html` 是 `Tasks / Board`；模块文件夹可以省略，`pages/Home.html` 就是 `Home`。
- 平台写在后缀：无后缀是 desktop，另有 `.mobile`、`.tablet`。同一页面的几个平台版本是同名的几个文件。
- 其他位置的文件，check 给出 warning 并忽略。

### index.html

```html
<!doctype html>
<html data-mode="light" data-language="zh-cn">
<head>
  <meta charset="utf-8">
  <title>Flowboard</title>
  <meta name="smallpen:package-id" content="pkg_7f3a91c2">
</head>
<body></body>
</html>
```

- `<title>` 是包名。
- 可选 `<meta name="smallpen:default-page" content="Tasks/Board">` 指定默认页面；不写时用第一个流程起点，再不行用第一个页面。
- `<html>` 上的 `data-<组>` 是该主题组的项目默认选项。没写的组用名为 `default` 的选项，没有就用第一个。
- `package-id` 由 `project init` 生成，AI 不用管。
- `<body>` 留给以后的浏览器目录页，CLI 读取时忽略。

## 4. Token 与主题：tokens.css

```css
:root {
  --color-brand: #2563eb;
  --color-on-brand: #ffffff;
  --color-primary: var(--color-brand);
  --spacing-4: 16px;
  --radius-md: 8px;
  --type-label: 600 14px/1.4 "Source Sans Pro";
  --type-label--tracking: 0.5px;
  --shadow-card: 0 2px 8px 0 #00000033;
  --string-save: "保存";
  --flag-show-badge: true;
}

:root[data-mode="dark"] {
  --color-brand: #93c5fd;
}

:root[data-language="en"] {
  --string-save: "Save";
}

@font-face {
  font-family: "Noto Sans SC";
  src: url("assets/fonts/NotoSansSC-Regular.otf");
  font-weight: 400;
  font-style: normal;
}
```

- `:root` 块是基础值。每个 `:root[data-<组>="<选项>"]` 块是一个主题选项，只写它要改的 Token；空块也算声明了这个选项。
- 主题组和选项从这些选择器里读出来，不另外登记。组名和选项名用小写字母、数字和横线。
- App 里新建或导入的 Token 常用 `color.brand` 这种名字。写回时改成 tokens.css 的名字：转小写，其他字符换成横线，缺类型前缀就补上（`core.color.Brand` → `--color-core-color-brand`），别名跟着改；主题组和选项同样转小写加横线。id 不变，绑定不受影响。
- Token 名就是变量名去掉 `--`。前缀决定类型和能用在哪些 class 上：

| 前缀 | 类型 | 值 | class |
|---|---|---|---|
| `--color-` | color | `#rgb`、`#rrggbb`、`#rrggbbaa` | `bg-` `text-` `border-` `fill-` `stroke-` |
| `--spacing-` | spacing | `16px` | `p-` `px-` `py-` `pt-` `pr-` `pb-` `pl-` `m-` `mx-` `my-` `mt-` `mr-` `mb-` `ml-` `gap-` `gap-x-` `gap-y-` |
| `--size-` | sizing | `48px` | `w-` `h-` `min-w-` `max-w-` `min-h-` `max-h-` |
| `--radius-` | border-radius | `8px` | `rounded-` `rounded-tl-` `rounded-tr-` `rounded-br-` `rounded-bl-` |
| `--border-` | stroke-width | `1px` | `border-` |
| `--shadow-` | shadow | CSS `box-shadow` 写法，可多层 | `shadow-` |
| `--opacity-` | opacity | `0` 到 `1` | `opacity-` |
| `--type-` | typography | CSS `font` 简写；字距另写 `--type-<名>--tracking` | `type-` |
| `--font-` | font-family | `"Family"` | `font-` |
| `--font-weight-` | font-weight | `100` 到 `950` | `font-` |
| `--text-` | font-size | `14px` | `text-` |
| `--tracking-` | letter-spacing | `0.5px` | `tracking-` |
| `--string-` | string | `"文字"` | `data-text` |
| `--flag-` | boolean | `true` 或 `false` | `data-visible` |

- class 名是「class 前缀 + 去掉类型前缀的 Token 名」：`--color-brand` 对应 `bg-brand`，`--spacing-4` 对应 `p-4`。两个 Token 生成同一个 class（如 `--color-sm` 和 `--text-sm` 都生成 `text-sm`）时报错。
- 别名用 `var(--另一个 Token)`，类型必须相同。不允许 `calc()` 等其他函数。
- 长度只用 `px`，`0` 可以不写单位。
- 颜色的透明度写在 8 位十六进制里（`#2563ebb3`）。App 设的透明度是整数百分比，每个百分比对应唯一的字节，所以读回时还原成那个百分比（`b3` 读作 0.7）。
- 行高没有单独的 Token 类型（Penpot 没有），写在 typography Token 里，或用 `leading-[1.4]`。
- `@font-face` 的 `src` 只能指向 `assets/fonts/` 里的一个 TTF、OTF 或 WOFF 文件，每个字重和字形写一条。只用内置的 Source Sans Pro 时不用写。

## 5. 元素

| 写法 | 节点 | 说明 |
|---|---|---|
| `<body>` | 页面根 | 默认尺寸：desktop 1440×900，mobile 390×844，tablet 834×1194 |
| `<div>` | FRAME | 容器 |
| `<div data-shape="rectangle">` | RECTANGLE | 不能有子元素 |
| `<div data-shape="ellipse">` | ELLIPSE | 只能用在页面里 |
| `<div data-shape="group">` | GROUP | 只能用在页面里 |
| `<div data-shape="mask">` | GROUP（蒙版） | 第一个子元素（最底层）是蒙版形状，按它的轮廓裁切其余子元素，和 App 的 Ctrl+M 一样。蒙版组的大小取自蒙版形状，不写 `w-` `h-`；蒙版形状放在 `left-[0px] top-[0px]`，移动整组时改组的 `left` `top`。只能用在页面里 |
| `<p>` | TEXT | 内容是文字，里面可以有 `<span>`（分段样式）和 `<br>` |
| `<img src="…">` | IMAGE | `src` 指向 `assets/` 里的文件 |
| `<svg viewBox="…"><path d="…"/></svg>` | PATH | 一个 `<svg>` 只放一个 `<path>`；只能用在页面里 |
| `<sp-use component="…">` | INSTANCE | 见第 7 节 |

`section`、`button`、`h1`、`a`、单独的 `span` 等其他标签都报 `unknown_element`，并提示该用哪个。

通用属性：

| 属性 | 含义 |
|---|---|
| `data-name` | 名字。同一父元素下不能重名（不分大小写）；App 存出重名时，写回自动编号为「名字 2」。省略时文字用内容，其他用类型名，重复的加序号。要被连线、覆盖或跟踪改动的元素应写名字 |
| `data-click` `data-press` `data-hover` `data-mouse-enter` `data-mouse-leave` `data-after-delay` | 原型交互：点击、按下时、悬停时、鼠标移入、鼠标移出、延时后，见第 8 节 |
| `data-text` | 绑定 string Token：`data-text="save"` 绑定 `--string-save`；写了它，元素里的文字只作说明，不参与显示 |
| `data-visible` | 绑定 boolean Token：`data-visible="badge"` 绑定 `--flag-badge` |
| `class` | 全部样式和布局 |

子元素按书写顺序显示；重叠时后写的在上面。

## 6. class 词汇表

写法沿用 Tailwind 的习惯，但只认下表，也不依赖 Tailwind 编译器。值有三种：Token（`bg-brand`）、方括号里的字面值（`bg-[#ff0000]`、`w-[240px]`，空格写成 `_`）、固定关键字（`w-full`）。

### 布局

| class | 含义 |
|---|---|
| `flex` 加 `flex-row`、`flex-col`、`flex-row-reverse` 或 `flex-col-reverse` | 弹性布局。不写 `flex` 或 `grid` 的容器按 `left-*`、`top-*` 放子元素（Penpot 的无布局画板） |
| `grid` 加 `grid-cols-3` 或 `grid-cols-[240px_1fr_auto_25%]`，`grid-rows-*` 同理 | 网格布局。轨道：`px` 固定，`fr` 分剩余空间，`auto` 随内容，`%` 占网格的比例。不写 `grid-cols` 时是一列 `1fr`；行按子元素需要自动加 `auto` 行。`grid-flow-col` 改为按列排，这时自动加的是列 |
| `col-start-N` `row-start-N` `col-span-N` `row-span-N` | 网格子元素的位置和跨度。子元素按书写顺序放：写了起始线的放到那里，没写的放进按行顺序第一个放得下的空格；格子已被前面的子元素占了就报 `grid_cell_taken` |
| `justify-items-*`、`justify-self-*`、`content-*` | 网格里格子内的水平对齐（整体、单个），以及轨道整体的垂直分布；`items-*`、`self-*` 是垂直对齐，`justify-*` 是轨道整体的水平分布 |
| `flex-wrap` | 换行 |
| `items-start` `items-center` `items-end` `items-stretch` | 交叉轴对齐。和 CSS 不同，App 里 `items-stretch` 不拉伸子元素，只按 `items-start` 摆放；要拉伸就给子元素写 `h-full`（行）或 `w-full`（列），没写时 check 给出 `stretch_not_in_app` 警告 |
| `justify-start` `justify-center` `justify-end` `justify-between` `justify-around` `justify-evenly` | 主轴分布 |
| `self-start` `self-center` `self-end` `self-stretch` | 单个子元素的对齐 |
| `gap-*` `p-*` `m-*` 等 | 间距、内边距、外边距 |
| `absolute` 加 `left-*`、`top-*` | 弹性布局里的子元素不参加排版，按坐标放 |
| `z-[n]` | 层级 |
| `pin-x-left` `pin-x-right` `pin-x-stretch` `pin-x-center` `pin-x-scale`，`pin-y-*` 同理 | 父元素缩放时怎么跟随（Penpot constraints） |

### 尺寸

| class | 含义 |
|---|---|
| `w-[240px]`、`w-<size Token>` | 固定宽度 |
| `w-fit` | 随内容（hug），只用于弹性或网格容器、组件副本和文字 |
| `w-full` | 填满（fill），只用于弹性或网格布局里的子元素；在主轴上平分剩余空间，在交叉轴上和网格格子里撑满 |
| `min-w-*` `max-w-*` | 只用于 `w-full` 的元素 |

`h-*` 同理。省略时，弹性容器和文字默认随内容，组件副本和组件一样大，其他元素必须写尺寸。`flex-1`、`w-auto` 和百分比都不接受，改用 `w-full` 或 `w-fit`。

等高卡片：CSS 网格默认把一行的卡片拉成一样高，App 不会。随内容的行只按不填满的子元素算高度，所以一行里可以让最高的卡片随内容、其他写 `h-full`；更稳的写法是给行定高（`grid-rows-[160px_160px]`）再让卡片 `h-full`，或者所有卡片用同一个高度。

### 外观

| class | 含义 |
|---|---|
| `bg-*` | 填充：颜色，或渐变 `bg-[linear-gradient(from_0.5_0_to_0.5_1,#2563eb_0%,#93c5fd_100%)]`、`bg-[radial-gradient(from_0.5_0.5_to_1_1_width_0.8,…)]`（起点、终点是相对元素的 0–1 坐标，和 Penpot 一致），或图片 `bg-[url(../assets/photo.webp)]`（后面可跟透明度 `_0.8`）|
| `bg-[层,层,…]` | 多层填充，和 CSS `background` 一样最上层写在最前：`bg-[url(../assets/photo.webp)_0.8,linear-gradient(…),var(--color-brand)]`。列表里用 `var(--color-*)` 绑定颜色 Token；`url()` 里的下划线保留原样，文件名里的空格写成 `%20` |
| `border`、`border-*` | 描边宽度或颜色，按 Token 类型或字面值区分；`border` 等于 `border-[1px]`，`border-0` 是 0 |
| `border-[描边,描边,…]` | 多条描边，最上面的写在最前：每条写宽度、颜色，可选样式（`solid` `dashed` `dotted` `mixed`）和位置（`inside` `center` `outside`），例如 `border-[1px_#e5e7eb,2px_dashed_var(--color-brand)_outside]` |
| `border-t` `border-b-0` `border-b-*` 等 | 单边宽度，`t` `r` `b` `l` 四边；不带数值是 1px；没写的边用 `border` 的宽度，没写 `border` 时是 0，和 CSS 一样：`border-b border-outline` 只画底边 |
| `border-solid` `border-dashed` `border-dotted` | 描边样式 |
| `border-inside`（默认）`border-center` `border-outside` | 描边位置 |
| `border-hidden`、`border-shown` | 保留描边但不画出来，相当于 App 描边旁的眼睛按钮；`border-shown` 用在变体里恢复。描边列表里给单条描边加 `hidden`：`border-[1px_#e5e7eb_hidden,2px_#111111]`；`<svg>` 上写 `stroke-hidden` |
| `rounded-*` `rounded-tl-*` 等 | 圆角；`rounded-full` 是胶囊或圆形（9999px），有 `--radius-full` Token 时用 Token |
| `shadow-*` | 阴影；在某一层末尾加 `hidden` 保留但不画：`shadow-[0_2px_8px_0_#00000033_hidden,inset_0_1px_0_0_#ffffff]` |
| `opacity-*` | 不透明度 |
| `blur-[4px]` `backdrop-blur-[8px]` | 图层模糊、背景模糊；`blur-[4px_hidden]` 保留但不生效；`blur-none`、`backdrop-blur-none` 去掉 |
| `mix-blend-*` | 混合模式 |
| `rotate-[45deg]` `flip-x` `flip-y` | 旋转、翻转 |
| `overflow-visible` | 不裁剪子元素（默认裁剪，同 Penpot） |
| `hidden`、`shown` | 隐藏、显示；`shown` 用在变体或覆盖里恢复显示 |
| `fill-*` `stroke-*` `stroke-[2px]` | 只用于 `<svg>` 路径 |

### 文字

| class | 含义 |
|---|---|
| `type-*` | 字体样式 Token：字体、字号、字重、行高、字距一起设 |
| `font-*` | 字体或字重 |
| `text-*` | 字号或颜色；`text-left` `text-center` `text-right` `text-justify` 是对齐 |
| `leading-*` `tracking-*` | 行高倍数、字距 |
| `italic` `uppercase` `lowercase` `capitalize` `underline` `line-through` | 字形、大小写、装饰 |
| `align-top` `align-middle` `align-bottom` | 文字在框内的垂直位置 |

文字默认宽高都随内容；定宽（`w-[…]` 或 `w-full`）时高度随内容；宽高都固定就是固定文本框。

## 7. 组件、变体、实例

### 定义

```html
<sp-component name="Button" props="Style: primary | secondary; Size: sm | md">
  <div class="flex flex-row items-center px-4 py-2 bg-brand rounded-md">
    <p data-name="Label" class="type-label text-on-brand">Button</p>
  </div>
  <sp-variant when="Style: secondary" class="bg-surface border border-brand">
    <p data-name="Label" class="text-brand"></p>
  </sp-variant>
  <sp-variant when="Size: md" class="px-6 py-3"></sp-variant>
</sp-component>
```

- `<sp-component>` 里第一个元素是组件本体，所有变体共用。
- `props` 列出属性和取值，第一个取值是默认值，每种组合都是一个变体。没有 `props` 就只有一个变体。
- `<sp-variant when="…">` 写符合条件的变体相对本体的改动，按书写顺序叠加：
  - 它自己的 class 改本体的根；
  - 它的子元素按 `data-name` 找本体里的部件，改那个部件；中间层级照原结构写出，不写 class 就是不改；
  - 同一属性的 class，后写的覆盖先写的（`bg-surface` 覆盖 `bg-brand`）；
  - 部件里写了文字或 `data-text` 就替换本体的文字或字符串 Token，都没写就不改：`<p data-name="Status" data-text="done"></p>`；
  - 部件上只能写 `data-name`、`class`、`data-text`（`<p>`）和 `props`（`<sp-use>`）；连线、`data-visible` 等其他属性所有变体相同，写在本体上，写在规则里会报 `override_not_allowed`；
  - 变体之间结构不同时，本体放全部部件，用 `hidden` 和 `shown` 控制。App 只给某些变体加了图层时，写回也是这样：图层写进本体并隐藏，有它的变体规则里写 `shown`。
  - 规则里写 `<sp-use data-name="…" props="…">` 会重写这个副本：它的 `props` 和子元素整体替换本体里那个副本的属性和覆盖。
- 组件里不能用 ELLIPSE、GROUP、PATH，图标用 `<img>`。

### 实例

```html
<sp-use component="Button" props="Style: secondary" data-name="Cancel" class="w-full">
  <p data-name="Label">取消</p>
</sp-use>
```

- `props` 选变体，没写的属性用默认值。
- 实例自己的 class 改实例的根，例如尺寸和填充。不写 `w-`/`h-` 时和组件一样大：组件定高 44px，副本也是 44px；组件随内容，副本也随内容。要让副本随内容就写 `w-fit`/`h-fit`。
- 子元素是覆盖，规则同变体：按名字找部件，改文字或 class。不能加新子元素，实例没有任意内容插槽。
- 给嵌套实例换变体：`<sp-use data-name="Icon" props="Size: lg"></sp-use>`，不写 `component`。
- 可覆盖的字段同现在：文字、可见性、填充、描边、圆角、阴影、不透明度、尺寸、字体样式、Token 绑定、变体、连线。

## 8. 页面、原型、画布

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Board</title>
  <link rel="stylesheet" href="../../tokens.css">
</head>
<body data-flow="main" class="flex flex-row bg-canvas">
  <div data-name="Sidebar" class="w-[240px] h-full p-4">
    <p data-name="Logo" class="type-title">Flowboard</p>
  </div>
  <div data-name="Content" class="flex flex-col w-full h-full p-6 gap-4">
    <sp-use component="Button" data-name="New task" data-click="Tasks/New">
      <p data-name="Label">新建任务</p>
    </sp-use>
  </div>
</body>
</html>
```

- `<head>` 里只能有 `meta`、`title` 和指向 `tokens.css` 的 `link`。CLI 只读 `<body>`。
- 每种触发方式一个属性：`data-click` 点击，`data-press` 按下时，`data-hover` 悬停时，`data-mouse-enter` 鼠标移入，`data-mouse-leave` 鼠标移出，`data-after-delay` 延时后（只用于画板和组件副本）。
- 属性值先写动作：`Tasks/Detail` 跳到同一平台版本的那个页面，那个页面没有这个平台的版本时跳到它的桌面版；`back` 回上一页；`overlay:Dialogs/Confirm` 把另一个页面作为浮层打开；`toggle-overlay:PAGE` 打开或关闭；`close-overlay` 关闭当前浮层，`close-overlay:PAGE` 关闭指定的；`https://…`、`mailto:…`、`tel:…` 打开链接。
- 动作后用 `;` 写选项：`delay: 1500ms`（延时，默认 600ms）；`animation: slide in left 300ms ease-out offset`（`dissolve`、`slide`、`push`，`push` 只用于跳页面；默认 300ms、`linear`）；浮层的 `position: center`（默认）、`top-left` … `bottom-right` 或 `manual 20px 40px`，`relative-to: self`（这个元素；写在副本内部元素上时指这个副本）、`page` 或外层画板、副本的名字（只用于页面；写错时报错会列出能用的名字），`manual` 不写 `relative-to` 时相对 `self`，`close-outside`（点外面关闭），`backdrop`（加背景遮罩）；跳页面的 `preserve-scroll`。
- 例：`<div data-name="Menu button" data-hover="overlay:Menus/Main; position: top-right; close-outside; animation: dissolve 200ms ease-out">`。
- `<body data-flow="main">` 表示这个页面是原型流程 `main` 的起点。
- `<body data-canvas="onboarding">` 把页面放到另一个画布。默认所有页面在同一个画布上，因为跨画布不能连线。页面在画布上的位置由 CLI 计算。
- App 里新建、还没有页面的画布，写在 `index.html`：`<meta name="smallpen:canvas" content="画布名">`。画布有了页面后，这行由页面的 `data-canvas` 代替。

## 9. 身份和推导

- 页面的身份是模块、页面名和平台（来自路径）；组件是 `name`；元素是从根到它的名字路径；主题选项是组和选项；Token 是变量名。
- 读取时由这些身份生成稳定的内部 ID，同样的内容每次读出同样的 ID。
- 改名等于删掉旧的、新建一个：App 里对它的覆盖和连线会丢；指向旧名字的连线由 check 报 `unknown_link_target`。
- 读取时计算：弹性布局里的位置和尺寸、文字尺寸（用包里的字体测量）、hug 和 fill 的结果、页面在画布上的位置。
- 版本号（revision）是包内全部文件路径和内容的哈希。

## 10. 改动记录

- 不再有写入批次。`changes --since REVISION` 拿两份快照按名字比较，报告方式同现在。
- AI 拿到的每个 revision 都来自某次 CLI 调用，那次调用把快照存进现在的系统缓存目录，容量和过期规则不变。
- App 内的撤销照旧。CLI 不提供撤销，AI 用 Git 或直接改回去。

## 11. check

命令：`smallpen check PACKAGE [--revert [--file PATH]…] [--render] [--json]`。分三层，前两层不渲染：

1. **语法**：HTML 和 CSS 能否解析；有没有子集外的元素、属性、class、CSS 规则；字面值的格式。
2. **规则**：Token、组件、属性、部件、页面、资源是否存在；Token 类型和 class 是否相配；名字是否重复；尺寸和布局是否符合 App 的规则（fill 只在弹性布局里，hug 只用于弹性容器和文字，min/max 只配 fill）。
3. **渲染**：`--render` 时排版并绘制页面和组件，报文字溢出、越界、重叠和对比度问题。渲染问题只是提示，不让 check 失败。

### 闸门：接受和回退

AI 直接改文件，可能一次改很多个，`check` 同时是闸门：

- 每次 check 通过（或 App 保存成功、`init` 建包），这时的文件就是**已接受版本**，存在包外的缓存里（文本全文，图片和字体按内容哈希存字节）。
- check 有错误时，逐个看改过的文件：不出错的改动照样接受，已接受版本随之更新；出错的文件标为 `rejected`，文件本身先不动。
- 错误出在没改过的文件里时（比如删了一个页面还在用的 Token），按 `tokens.css`、`index.html`、`components/`、`assets/`、页面的顺序找出是哪个改动引起的，只拒绝它。报错文件自己的改动只有在退回后它的错误确实变少时才算有问题。
- `check --revert` 把被拒绝的文件恢复成已接受版本，被拒绝的新文件删掉，然后重新检查。几个 AI 同时改一个包时，用 `--revert --file PATH` 只退回自己改的文件。
- 回退在包的写锁里进行，不会和 App 保存交错。还没有已接受版本时（包从没通过过 check），check 会说明无处可退。

每个问题一行：

```
pages/Tasks/Board.html:14:9 error unknown_token bg-brnd：没有 --color-brnd，最接近的是 --color-brand
```

`--json` 输出同样内容的结构化结果。有 error 时退出码非 0，warning 不影响退出码。

第一批问题代码：

| 层 | 代码 | 何时报 |
|---|---|---|
| 语法 | `html_parse_error` `css_parse_error` | 解析失败 |
| 语法 | `html_too_deep` | 元素嵌套超过 256 层（更深的部分不读，避免栈溢出） |
| 语法 | `unknown_element` `unknown_attribute` | 子集外的标签或属性 |
| 语法 | `inline_style_forbidden` `script_forbidden` | 写了 `style`、`<style>` 或 `<script>` |
| 语法 | `unknown_class` | 不在词汇表里 |
| 语法 | `invalid_literal` | 方括号里的值格式不对，或单位不是 px |
| 语法 | `unsupported_css_rule` `invalid_token_name` | tokens.css 里出现允许以外的规则，或变量名没有已知前缀 |
| 规则 | `unknown_token` | class 用的 Token 不存在，附最接近的名字 |
| 规则 | `token_type_mismatch` | 例如 `bg-` 用了 spacing Token |
| 规则 | `token_class_collision` | 两个 Token 生成同一个 class |
| 规则 | `token_alias_missing` `token_alias_cycle` `invalid_token_value` | 别名或值有问题 |
| 规则 | `unknown_theme_option` | index.html 的默认值指向不存在的选项 |
| 规则 | `duplicate_name` | 同级元素、页面或组件重名 |
| 规则 | `layout_required` | 写了 gap、padding、方向或对齐，却没写 `flex` |
| 规则 | `layout_not_in_app` | 尺寸组合是 App 不允许的：`w-full` 不在弹性或网格布局里；弹性行随内容宽度时子元素 `w-full`（列同理是 `h-full`）；随内容的方向上所有子元素都填满，这时它没有尺寸；`w-fit` 用在不能随内容的元素上 |
| 警告 | `stretch_not_in_app` | `items-stretch` 或 `justify-items-stretch` 遇到不填满的子元素，App 不会拉伸它 |
| 规则 | `invalid_size_limit` | `min-*`、`max-*` 用在不是 `w-full`/`h-full` 的元素上 |
| 规则 | `size_required` | 不能随内容的元素没写尺寸 |
| 规则 | `text_style_on_container` `text_outside_p` `empty_text` `invalid_text_size` | 文字类写在容器上、文字没放进 `<p>`、空文字、只给高度不给宽度 |
| 规则 | `page_only_element` | 组件里用了椭圆、分组或路径 |
| 规则 | `missing_name` `component_cycle` | 覆盖或变体里的元素没写 `data-name`；组件里放了自己的副本 |
| 规则 | `unknown_component` `unknown_prop` `invalid_prop_value` `unknown_part` `override_not_allowed` | 组件和实例的问题 |
| 规则 | `invalid_variant_rule` | `when` 用了不存在的属性或取值 |
| 规则 | `unknown_link_target` | 跳转目标页面不存在，附最接近的名字；目标页面没有这个平台的版本时跳到它的桌面版，不报错 |
| 规则 | `missing_asset` `font_not_declared` `unsupported_font_conversion` | 资源和字体的问题 |
| 警告 | `literal_matches_token` | 颜色、间距、圆角、描边宽度的字面值正好等于某个 Token 的值（在 `:root` 或某个主题选项里），附跟随它的写法；宽高和纯黑纯白不报 |
| 警告 | `part_named_by_text` | 变体规则或副本覆盖按文字找到的部件（没写 `data-name` 的 `<p>`），文字一改就找不到 |
| 警告 | `rule_has_no_effect` | 变体规则改的部件在它适用的每个变体里都隐藏，改动不显示；每个组件合成一条 |
| 警告 | `missing_theme_value` | 没有 `:root` 值的 Token 在同组某个选项里漏了，这个选项下会显示别的选项的值 |
| 警告 | `missing_translation` | 某个主题选项给了部分字符串、漏了这一条（默认选项除外），这个选项下显示 `:root` 的文字 |
| 警告 | `large_asset` | `assets/` 里的文件超过 10 MB，每次打开包都要读 |
| 渲染 | `clipped_by_parent` | `check --render`：外描边、居中描边或阴影超出了会裁剪内容的父画板 |
| 渲染 | `low_ui_contrast` | `check --render`：48px 以内只靠描边显示的控件（空心复选框、单选圈），描边和背景对比不到 3:1 |
| 渲染 | `font_render_fallback` `font_weight_substituted` | `check --render`：字体或字重缺失，用内置字体或最近的字重绘制并测量，每种合成一条 |

`check --render` 默认只在默认主题选项下检查，文字输出写明是哪些；`--all-themes` 检查所有组合，每条问题前写组合名。门控部分接受时输出 `accepted revision`（JSON 里是 `acceptedRevision`），`changes --since` 可以从它开始。`check` 的汇总行还写出有几个 Token 没被任何页面或组件用到（`token list --unused` 列出它们，可能是留给代码用的）。

## 12. CLI 变化

| | 命令 |
|---|---|
| 保留 | `check`、`view`、`export`、`validate`、`changes`、`project init`（生成空白包）、`help`、`version` |
| 删除 | `token`、`component`、`page`、`flow`、`canvas`、`asset`、`advanced` 的全部命令 |
| 改动 | `schema` 改为输出本规范的元素、属性和 class 词汇表；问题位置指向文件的行和列 |

## 13. 实现边界

- 只换存盘这一层。读取时把 HTML 和 CSS 编译成现有的内存模型；校验、投影、渲染、App 和写入批次都不变。代码在 `packages/core/src/html-format/`。
- 解析器是自己写的严格子集读取器：零依赖，Node、浏览器、Electron 通用，给出行列位置。同样内容下比 `JSON.parse` 快约 3 倍，比 parse5 快约 6 倍；文件只有原 JSON 的 13% 左右。
- 文本（页面、组件、`index.html`、`tokens.css`）整个读进内存。字体和图片只看 stat，哈希、尺寸存在按 stat 对应的缓存里，字节等渲染用到时才读。
- 进程内缓存：文件 stat 不变时，直接复用上次解码好的结果。
- 写入先在内存里完成：新状态编码成文件、再解码核对，通过后才原子地写盘；写盘后内存缓存直接换成新状态。只重写语义变了的文件，其他文件保留作者的排版；格式之外的文件从不删除。
- ID：文件里不存。读取时由名字推导；系统缓存里的对照表保证 App 改名或写回后 ID 不变。
- revision 是全部文本加素材内容哈希的哈希，任何人改文件都会变。`changes --since` 用缓存里的旧版本文件对比，所以直接改文件也能报出改动。

实测（100 页、约 1.2 万节点、1.2 MB HTML、一个 12 MB 字体）：冷启动约 300 ms，缓存命中约 95 ms，打开时不读字体字节。

## 14. 首版不包含（待确认）

| 内容 | 替代 |
|---|---|
| Foundation/Product 双包、远程库 | 单包 |
| 把页面上的元素直接做成组件（App 的 Create component） | 在 `components/*.html` 里定义组件；App 这样做时写回报错，不写盘 |
| Context、Scenario、Requirements | Context 用主题组代替；场景和需求放在包外文档 |
| Figma Draft 导入 | 无 |
| App 独立的颜色和字体样式（Styles） | Token |
| DTCG Token 文件、Token sets 的自由组合 | 一个选项一个块 |
| 组件属性的角色（configuration/state） | 无 |
| text-case、text-decoration、number、rotation、other 类型的 Token | 用 class 字面值 |
| 锁定、比例锁、参考线、导出设置等编辑器状态 | 首版不存 |

## 15. 已定

1. App 写回第一期就做：App 保存时按标准格式重写改动了的文件。
2. 变体用「本体加改动块」。写回时先找多数变体共有的改动写成单属性规则，例外写成完整组合规则。
3. 第 14 节的删减清单照做，不兼容旧 JSON 包。
4. 名字就是身份；系统缓存的 ID 对照表让 App 里的改名不丢 ID。直接改文件改名，等于新建。
5. 主题组名和选项名用小写。

## 16. 进度

已完成：编解码、`check`、存储层切换（读写、revision、ID 对照表、修订快照、懒加载素材、进程缓存）、`project init`、`changes --since`；删除 CLI 写入命令、Draft 导入、远程库、Foundation/Product、Context/Scenario 的公开入口；测试夹具和示例包转成 HTML；help、schema 和 Skill 改成“改文件 → check”的流程；App 打开、编辑、写回 HTML 已在真实 App 里验证；库对话框改为说明“包是独立的”；CLI 里旧写命令的契约、帮助和 schema 主题已删除。测试 821 个全部通过。

已补上：多层填充、图片填充、多条描边、Grid 布局（轨道、跨度、对齐）、全部原型触发和动作（浮层、链接、动画、延时）、蒙版、描边/阴影/模糊的隐藏（App 的眼睛按钮）。App 里加第二层填充、把画板转成 Grid、编辑交互都能写回文件（已在真实 App 里验证）；App 里改过的阴影按 Penpot 原样存的记录也能写回。

已知限制：Penpot 渲染引擎画图片填充时不处理它的透明度，透明度存进了文件和 App，但 PNG 里图片按不透明画；文字的填充、`<svg>` 路径的填充和描边仍是一层；`relative-to` 只用于页面里的元素。
