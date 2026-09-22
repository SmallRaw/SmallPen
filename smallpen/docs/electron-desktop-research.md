# SmallPen Electron Desktop 调研

调研日期：2026-09-04

## 结论

SmallPen 可以用 Electron 取代当前 macOS 专用的 Swift/Cocoa/WKWebView 壳，而且不需要重写 Penpot UI、Background 或 Web Server。最小迁移应当是：

1. Electron 主进程只管理应用生命周期、菜单、文件选择和窗口。
2. 用一个 Electron `utilityProcess` 运行现有 `startDesktopHost`，继续把 Background 和 Web 绑定在回环地址的随机端口。
3. 每个 Package 使用一个顶层 `BrowserWindow`，直接加载现有 Local Web Host URL；不要再套一层 HTML，也不要使用 Electron `<webview>` 标签。
4. 使用 Electron Forge 打包；Alpha 先产出 macOS universal ZIP 和 Windows x64 ZIP，继续人工下载和替换，不做自动更新。
5. Electron 已内嵌 Node.js，因此移除当前 App 内重复捆绑的独立 Node 可执行文件。

Electron 官方把它定义为内嵌 Chromium 和 Node.js 的跨平台运行时；最终用户运行打包后的 App 不依赖其系统 Node.js。[Electron prerequisites](https://www.electronjs.org/docs/latest/tutorial/tutorial-prerequisites) 当前 Electron 44 内嵌 Node 24，正好满足 SmallPen 现有的 Node 24 运行要求；Electron 44 同时只支持 64 位 x64/arm64，macOS 最低为 13。[Electron 44 release](https://www.electronjs.org/blog/electron-44-0)

这次迁移的代码量不大，但不能理解为“换一个 WebView 打包按钮就结束”。需要专门处理：Windows 上的目录 Package、进程退出、窗口崩溃、下载、权限、资源路径、不同架构产物和真实安装环境测试。

## 当前实现不是 Electron

当前 Desktop 是一个 Swift 原生 App：Cocoa 管窗口和菜单，WKWebView 加载本机页面，Swift `Process` 再启动 App 内附带的 Node。相关实现见 [`SmallPenDesktop.swift`](../apps/desktop/native/macos/SmallPenDesktop.swift) 和 [`build-macos.mjs`](../apps/desktop/scripts/build-macos.mjs)。

现有边界值得保留：

- UI 仍然是编译后的 Penpot 前端。
- Desktop 只加载 SmallPen 自己启动的回环地址。
- 一个 Desktop Host 管理多个独立 Package session 和窗口。
- `.smallpen` 仍然是目录 Package，不改 Canonical Package 格式。
- Desktop 不安装数据库、MCP 或外部 Node。

## 推荐的最小运行结构

```text
Electron main process
├── Menu / Open / New / app lifecycle
├── one utilityProcess: existing SmallPen Desktop Host
│   ├── Background server: 127.0.0.1:<ephemeral>/<random-session>
│   └── Web server:        127.0.0.1:<ephemeral>
└── BrowserWindow per open Package
    └── existing Penpot SmallPen workspace URL
```

Electron 的主进程本身运行在 Node 环境，`BrowserWindow` 为每个窗口建立独立 renderer；当需要 Node 子进程时，Electron 官方建议优先使用 `utilityProcess`，它提供与 `child_process.fork` 类似的能力，但使用 Chromium Services，并支持受控的消息通道。[Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model) [`utilityProcess.fork`](https://www.electronjs.org/docs/latest/api/utility-process) 只能在 `app` ready 后调用，所以启动次序应为：取得单实例锁 → 注册文件打开事件 → `app.whenReady()` → 启动 Host → 收到 ready URL → 创建窗口。

推荐继续保持“一个 Host、多个窗口”，而不是每个窗口复制一套服务器。现有 Host 已经支持打开/关闭多个 Package session；迁移时可以直接复用。Host 异常退出时，所有窗口应显示同一个可恢复错误页，允许重启 Host 并重新打开原 locators，而不是让整个 Electron 主进程直接退出。

### 为什么不用 `<webview>`

这里需要的是一个顶层应用页面，直接用 `BrowserWindow.loadURL()` 即可。“Electron WebView”在口语上可以理解为这个窗口，但实现上不应使用 `<webview>` 标签。Electron 官方明确建议避免 `<webview>`，因为其底层架构变化会影响稳定性、导航和事件路由。[Electron `<webview>` warning](https://www.electronjs.org/docs/latest/api/webview-tag)

### Renderer 权限

`BrowserWindow` 显式设置：

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- `webviewTag: false`

默认值虽然已经趋向安全，仍应显式声明并通过测试锁住。Electron 官方安全清单要求 renderer 不暴露 Node、保持 context isolation 和 sandbox、限制导航/新窗口、设置权限处理器并验证所有 IPC sender。[Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) SmallPen 的文件打开、新建和菜单都由主进程完成；除非出现确切需求，不增加 preload，也不向 Penpot 页面暴露通用 Electron API。

## Electron 版本与系统范围

建议在 `package-lock.json` 中精确锁定一个受支持的 Electron 44 patch，而不是使用 `latest` 或宽松主版本。Electron 44 内嵌 Node 24，并支持：

- macOS x64：Intel Mac
- macOS arm64：Apple Silicon
- Windows x64：本轮目标 Windows
- Windows arm64：Electron 有产物，但不在本轮承诺范围

Electron 44 要求 macOS 13+，Windows 10+；44 及以上不再提供 Windows 32 位版本。[Electron 44 release](https://www.electronjs.org/blog/electron-44-0) [Electron Windows support change](https://www.electronjs.org/docs/latest/breaking-changes/) Electron 只正式支持最新三个稳定主版本，且约每八周发布一个主版本，因此 Desktop 需要一个定期升级和回归测试节奏，不能长期冻结 Chromium。[Electron release timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)

## 打包工具选择

### 推荐：Electron Forge

Electron 官方推荐 Electron Forge；Forge 将 `@electron/packager`、平台 Maker、签名和发布工具统一在一个生命周期里。[Electron application packaging](https://www.electronjs.org/docs/latest/tutorial/application-distribution) [Electron Forge overview](https://www.electronjs.org/docs/latest/tutorial/forge-overview)

SmallPen 当前不做自动更新，也没有 native Node addon，因此 Forge 足够，且更接近 Electron 官方维护路径。推荐配置方向：

- `packagerConfig.asar: true`
- `packagerConfig.extraResource`: 复制经过筛选的 Penpot frontend 到 `resources/frontend`
- macOS `--arch=universal`
- macOS Alpha：ZIP Maker
- Windows Alpha：ZIP Maker
- 以后面向普通用户时：macOS DMG Maker、Windows Squirrel Maker

Forge 的 `packagerConfig` 直接映射到 `@electron/packager`；平台和架构通过 Forge CLI 参数选择。[Forge configuration](https://www.electronforge.io/config/configuration) ZIP Maker 没有平台专属构建依赖，适合当前人工替换的 Alpha 分发。[Forge ZIP Maker](https://www.electronforge.io/config/makers/zip) Squirrel.Windows 能生成无管理员安装器，但必须在 Windows，或安装 Mono/Wine 的 Linux 上构建，并且还要处理 Squirrel 的安装/卸载启动参数。[Forge Squirrel.Windows Maker](https://www.electronforge.io/config/makers/squirrel.windows)

### 为什么暂不选 electron-builder

`electron-builder` 对 NSIS、文件关联、多架构和自动更新提供了更集中、更声明式的配置，确实可用；但 Electron 官方说明它是社区工具而非 Electron 官方支持工具，并且用自己的更新方案替代部分官方组件。[Electron Forge alternatives](https://www.electronjs.org/docs/latest/tutorial/forge-overview) 当前 Alpha 不做自动更新，Windows 的目录 Package 也无法被普通“文件扩展名关联”真正解决，因此它相对 Forge 的优势暂时不关键。

如果未来明确选择 NSIS、私有更新服务器或大量 Windows 安装器定制，再单独评估迁移到 electron-builder；不要同时维护 Forge 和 builder 两套打包配置。

## 产物与 CI

推荐 Alpha 产物：

| 平台        | 架构                     | 产物                                    | 构建机         |
| ----------- | ------------------------ | --------------------------------------- | -------------- |
| macOS 13+   | universal（x64 + arm64） | `SmallPen-macOS-universal-unsigned.zip` | macOS runner   |
| Windows 10+ | x64                      | `SmallPen-Windows-x64-unsigned.zip`     | Windows runner |

`@electron/packager`支持 macOS universal、x64/arm64 和 Windows x64/arm64，并允许把资源复制到统一的 `process.resourcesPath`。[Packager options](https://electron.github.io/packager/main/interfaces/Options.html) 不建议在一台机器上假设能可靠地产出并验证所有平台；即使打包工具能交叉生成部分产物，macOS 签名只能在 macOS 完成，native 依赖也通常必须在目标平台编译。[electron-builder multi-platform build](https://www.electron.build/docs/features/multi-platform-build/)

所以 CI 应按操作系统拆成两个 job，并在对应操作系统真正启动 App：

- macOS job 构建 universal，分别在 Apple Silicon 和 Intel 环境至少完成一轮发布候选 smoke；CI 没有 Intel runner 时，发布前在真实 Intel Mac 手测。
- Windows job 在 Windows x64 构建并启动 App，不能只验证文件存在。
- 每个 job 都验证 App 内不要求系统 Node，打开同一 fixture 后 revision 与 CLI 一致。

## ASAR、Resources 与体积

建议的 packaged layout：

```text
resources/
├── app.asar                 # Electron main/utility entry + SmallPen JS modules
└── frontend/                # Penpot compiled static assets
```

Electron 的 Node `fs` 和 `require` 能透明读取 ASAR，但 ASAR 是只读的，不能作为工作目录；需要被系统直接执行的二进制和 native addon 应放到 unpacked/extra resources。[Electron ASAR archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives) `@electron/packager` 的 `extraResource` 会把文件复制到平台资源目录，运行时通过 `process.resourcesPath` 定位。[Packager options](https://electron.github.io/packager/main/interfaces/Options.html) SmallPen 的 `.smallpen`、application state、缓存、日志和临时文件必须继续位于用户可写目录，不能写进 `app.asar` 或安装目录。

当前仓库本地测量：

- `frontend/resources/public` 约 376 MiB
- 其中 source map 约 109 MiB
- `images/features` 约 87 MiB
- 当前 Swift App 内重复 Node runtime 约 116 MiB
- 当前完整 Swift App 约 479 MiB

因此 Electron 迁移后的首要体积优化不是“裁 Chromium”，而是：

1. 不再复制独立 Node runtime。
2. Release 不携带 source map；如需崩溃定位，单独保存成 CI artifact。
3. 为 SmallPen Desktop 建立经过 E2E 证明的 Penpot frontend allowlist，排除不可能进入的官网/功能介绍图片；不能凭文件名盲删。
4. 仅打包 production dependencies，启用 ASAR 和默认 prune。
5. 先记录 macOS/Windows 的压缩体积、安装体积、冷启动与空闲内存，再决定是否继续优化。

官方明确指出，一个最小 Electron App 的压缩体积通常已接近对应平台 Electron 预编译包，约 80–100 MB；如果小体积是硬约束，应选择别的技术，而不是尝试手工删除 Chromium 文件。[Why Electron](https://www.electronjs.org/docs/latest/why-electron) [`@electron/packager` size note](https://electron.github.io/packager/main/) Electron 官方也不推荐为了换名字或裁剪而自行编译 Electron，因为构建和维护成本很高。[Electron manual packaging](https://www.electronjs.org/docs/latest/tutorial/application-distribution)

## 本地 HTTP 安全边界

继续使用 Local Web Host 没问题，但必须把它当作一个本机服务，而不是“反正是 localhost 就没有安全问题”。

必须保持：

- Background 和 Web 只监听 `127.0.0.1`/`::1`，绝不监听 `0.0.0.0`。
- 端口由系统分配，Background 路径保留不可猜的 session capability。
- `BrowserWindow` 只允许首次返回的精确 origin；拒绝其他导航和 `window.open`。
- Remote Library URL 只由 Background 下载数据；不得把任意远端 URL导航进 Desktop renderer。
- Permission handler 默认拒绝，只对精确 SmallPen origin 放行实际需要的剪贴板或下载能力。
- 保持 `webSecurity`，不允许 insecure mixed content。
- Background CORS 从当前 `*` 收紧到实际 Web origin，并校验写请求的 Origin/Host 或额外 capability。
- 退出 App 时关闭服务器；异常退出后的残留监听、锁和临时目录进入 smoke tests。

Electron 的安全清单特别要求限制导航、新窗口、权限和外部链接，并明确禁止给远端内容开启 Node integration。[Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) Electron 默认会同意多种权限请求；安全敏感应用应同时设置 `setPermissionRequestHandler` 和 `setPermissionCheckHandler`。[Electron session permissions](https://www.electronjs.org/docs/latest/api/session)

## 打开、新建、多窗口与文件关联

### Electron 事件模型

- 应使用 `app.requestSingleInstanceLock()` 保持一个 Desktop 主进程；Windows 第二次启动时从 `second-instance` 的 command line 取得路径并打开新窗口。
- macOS 在 `ready` 之前就可能发出 `open-file`，必须在主模块顶层尽早注册并暂存路径。
- 每个已打开 locator 只对应一个窗口；重复打开时聚焦已有窗口。
- `Cmd/Ctrl+O` 打开目录选择器；`Cmd/Ctrl+N` 选择父目录和 Package 名后创建目录。

这些平台差异是 Electron 官方 API 的既定行为：macOS 使用 `open-file`，Windows 需要解析 `process.argv`；单实例锁把后续启动参数交给首实例。[Electron `app` API](https://www.electronjs.org/docs/latest/api/app) Windows/Linux 的原生选择器不能同时作为文件和目录选择器，因此打开 `.smallpen` 时应明确使用 `openDirectory` 并在选择后验证后缀和 manifest。[Electron `dialog` API](https://www.electronjs.org/docs/latest/api/dialog)

### 关键限制：Windows 不会把 `.smallpen` 目录当成普通关联文件

macOS 原生支持“document package”：在 `CFBundleDocumentTypes` 中设置 `LSTypeIsPackage`，Finder 会把具有该扩展名的目录显示成一个文档。[Apple Document Packages](https://developer.apple.com/library/archive/documentation/CoreFoundation/Conceptual/CFBundles/DocumentPackages/DocumentPackages.html)

Windows 的普通扩展名关联属于 file type；Shell 对目录使用 `Directory`/`Folder` ProgID，而不是目录名末尾的扩展名。这意味着：**只配置 `.smallpen` 文件关联，不足以让 Windows Explorer 把 `project.smallpen/` 目录当作可双击文档。** 这是根据 Microsoft Shell association model 得出的平台结论。[Microsoft Association Arrays](https://learn.microsoft.com/en-us/windows/win32/shell/fa-associationarray) electron-builder 的 `isPackage` 选项也明确只有 macOS 支持；其普通 Windows association 仅适用于 NSIS/MSI 文件类型。[electron-builder FileAssociation](https://www.electron.build/docs/api/electron-builder.interface.fileassociation/)

Alpha 推荐不改变数据格式：

- macOS：保留 Finder 双击 Package。
- Windows：从 SmallPen Home、File → Open、Recent Files 或拖放目录打开。
- Windows 可选增加“对所有目录显示 Open with SmallPen”的右键 verb，但体验较脏，不建议作为默认方案。
- 如果未来要求 Windows Explorer 像打开 `.fig` 一样双击，就要另立决策：把 `.smallpen` 改成单文件容器/归档，或增加一个指向目录 Package 的小型 launcher file。这不是 Electron 打包配置能自动解决的。

## 下载、崩溃与日志

当前 WKWebView 壳显式管理下载目标；Electron 迁移时不能遗漏。通过 session 的 `will-download` 统一处理 Evidence/导出文件的保存位置、重名、完成和失败状态。[Electron `will-download`](https://www.electronjs.org/docs/latest/api/session) 不允许 renderer 自己传任意绝对保存路径给主进程。

必须处理：

- `webContents` 的 `render-process-gone` 和 `unresponsive`：显示恢复 UI，保留 Package 路径，允许重载。
- `app` 的 `child-process-gone` 和 utility process exit：停止所有窗口写入，重启 Host 后重新建立 session。
- App 正常退出：等待 Host 完成 close，再设超时强制结束。
- 日志写到 `app.getPath('logs')` 或 user data 下；Windows 子进程日志写文件比依赖 stderr 更可靠。[Electron crash events](https://www.electronjs.org/docs/latest/api/web-contents) [Electron logging switches](https://www.electronjs.org/docs/latest/api/command-line-switches)

## 签名、公证和更新

用户已经接受 Alpha 手工允许首次启动和手工替换，所以本轮可以继续 unsigned，但产物名称、README 和应用内 About 必须明确标识 `unsigned Alpha`。

公开分发前的门槛：

- macOS：Developer ID Application 签名、Hardened Runtime、notarization、staple，并用 `spctl`/`codesign` 验证。
- Windows：签名应用与安装器，验证干净 Windows 机器上的 SmartScreen/安装/卸载。
- 签名凭据只放 CI secret，不进入仓库。

Electron 官方说明，Windows 和 macOS 会警告或阻止 unsigned App；macOS 对外发布需要签名再 notarize。[Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing) Forge 在 macOS package 阶段通过 `osxSign`/`osxNotarize` 完成签名和公证，Windows Maker 也支持签名安装器。[Forge macOS signing](https://www.electronforge.io/guides/code-signing/code-signing-macos) [Forge Windows signing](https://www.electronforge.io/guides/code-signing/code-signing-windows)

自动更新保持延期。Electron 官方教程把签名视为自动更新前提；在 Alpha 手工替换阶段先稳定 Package 格式、迁移与发布验收更重要。[Electron packaging tutorial](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging)

## 建议的验收矩阵

迁移只有同时满足下面这些条件，才能称为 Apple Silicon Mac、Intel Mac 和 Windows 支持：

| 场景                                       | macOS arm64  | macOS x64    | Windows x64                    |
| ------------------------------------------ | ------------ | ------------ | ------------------------------ |
| 无系统 Node 时启动                         | 必测         | 必测         | 必测                           |
| Home / New / Open / Recent                 | 必测         | 必测         | 必测                           |
| Finder/Explorer 双击                       | Package 双击 | Package 双击 | 明确显示为不支持，走 Home/Open |
| 同时打开两个 Package                       | 必测         | 必测         | 必测                           |
| CLI 写入后 Desktop 自动刷新                | 必测         | 必测         | 必测                           |
| Desktop 修改后 CLI 读到同 revision         | 必测         | 必测         | 必测                           |
| Token / Library / Component / Font / Image | 必测         | smoke        | 必测                           |
| Evidence/导出下载                          | 必测         | smoke        | 必测                           |
| renderer crash 后恢复                      | 必测         | smoke        | 必测                           |
| Host crash 后恢复或明确只读                | 必测         | smoke        | 必测                           |
| 退出后无残留端口和进程                     | 必测         | 必测         | 必测                           |
| 路径含中文、空格、emoji、超长路径          | 必测         | smoke        | 必测                           |
| Package 位于本机 Git 工作区                | 必测         | smoke        | 必测                           |

还应记录每个发布候选的：Electron 版本、Node/Chromium 版本、目标 OS/arch、SHA-256、压缩体积、安装体积、冷启动时间、空闲内存和已知限制。

## 实施顺序

1. 先做不打包的 Electron main prototype，直接导入现有 Host，证明 BrowserWindow、New/Open、多窗口和退出。
2. 把 Host 放进一个 `utilityProcess`，实现 ready/error/close 协议和崩溃恢复。
3. 加入 Forge，只产出 unpacked app；完成 macOS arm64 和 Windows x64 smoke。
4. 配置 ASAR 和 frontend `extraResource`，建立 frontend allowlist 并跑完整 Web/Desktop E2E。
5. 产出 macOS universal ZIP 与 Windows x64 ZIP，在真实 Intel Mac 和干净 Windows VM 上验收。
6. 删除 Swift 壳和重复 Node runtime 之前，让新旧壳对同一 fixture 通过相同的行为测试。
7. 签名、公证、Windows 安装器和 auto-update 留到 Public Beta，不阻塞当前朋友范围的 Alpha。

## 需要产品层明确记录的一项限制

“Desktop 支持 Windows”与“Windows Explorer 能把 `.smallpen` 目录当文档双击”不是同一个承诺。本轮可以可靠完成前者；后者受 Windows Shell 目录模型限制，需要改变 Package 表达或接受右键/应用内打开。发布说明必须写清楚，不能把它藏成一个打包 bug。
