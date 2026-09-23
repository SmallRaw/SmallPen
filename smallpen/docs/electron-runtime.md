# SmallPen 最小 Electron 运行时

核对日期：2026-09-23。本文记录实现选择与测量方法，不承诺尚未测得的性能收益。

当前验证边界：构建工具锁文件已生成，固定 `@electron/packager@20.3.0`
和 `@electron/fuses@2.1.3`，共 49 个直接及传递依赖，来源均为 npm 官方
registry。生成时 npm 报告 0 个已知漏洞。依赖预检要求继续审查可执行入口
和平台相关依赖；这不是完整安全放行。尚未在本机执行这些新构建工具或
Electron 44.4.5，也没有 Windows/macOS 实包通过记录。CI 的构建及冒烟
测试是发版前仍需通过的关卡。

## 运行边界

Windows 与 macOS 共用同一套 Electron main 和现有纯 Web UI。主进程只负责窗口、菜单和生命周期；一个共享 `utilityProcess` 承载现有 Node HTTP 服务，各窗口继续加载自己的本机页面。Electron 支持 main、renderer 与 utility process；utility process 提供 Node 环境，并且必须等 `app` ready 后启动。因此不再打包独立 Node 可执行文件，也不为每个窗口复制服务。这是本项目的结构选择，实际内存差值必须测量。[Process model](https://www.electronjs.org/docs/latest/tutorial/process-model) [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)

纯网页无须调用 Electron API 时，省去 preload。显式保留 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true` 与 `webSecurity: true`；限制导航、新窗口和权限。已有回环 HTTP 服务仍需自己的鉴权与来源检查，renderer sandbox 不会替代服务器检查。[Security checklist](https://www.electronjs.org/docs/latest/tutorial/security)

## 性能取舍

Electron 仍包含 Chromium 与 Node，并沿用 Chromium 的多进程结构。精简 JS 壳不能移除这部分运行时成本；不接受“几个启动参数便接近原生 WebView 内存或包体”的结论。不要使用 `--single-process`、`--no-sandbox` 或禁用 GPU 来追求进程数下降；进程数不是性能目标，画布体验和隔离边界需要保留。[Process model](https://www.electronjs.org/docs/latest/tutorial/process-model) [Security checklist](https://www.electronjs.org/docs/latest/tutorial/security)

优先减少应用自身工作：主进程不做同步磁盘扫描或重计算；延迟非必需模块；只载入当前窗口需要的内容；关闭不再使用的服务和计时器。Electron 官方建议先 profile，再优化最重的工作。上述选择不意味着任何确定的启动毫秒数或内存百分比收益。[Performance](https://www.electronjs.org/docs/latest/tutorial/performance)

## 打包边界

先生成一个按允许清单复制的 staging 目录，再交给 Packager：只含桌面入口、服务模块、所需运行时依赖、前端产物及必要许可证。排除测试、缓存、示例、旧原生壳、独立 Node 和开发工具。构建工具放在单独的 `apps/desktop/tools` 包，不进入运行时。当前 staging 手动复制完整运行时依赖，根清单不声明 npm 依赖，所以使用 `prune: false`，避免 Packager 删除这些模块；必须用产物测试核验清单。按平台和架构生成产物。[Packager options](https://electron.github.io/packager/main/interfaces/Options.html)

启用 ASAR 收纳代码；ASAR 是归档格式，不是压缩算法、加密或减少 Chromium 体积的办法。必须按真实磁盘路径访问的资源放在受控的 unpack/extraResource 范围，并测试打包后路径；不要假设开发目录中能打开就代表包内可用。[ASAR archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives) [Packager ASAR options](https://electron.github.io/packager/main/interfaces/Options.html#asar)

发布时在签名前配置 fuses：禁用 `RunAsNode`、`EnableNodeOptionsEnvironmentVariable` 和 `EnableNodeCliInspectArguments`；启用 `OnlyLoadAppFromAsar`，并在构建链生成完整性数据后启用 `EnableEmbeddedAsarIntegrityValidation`。前者会令依赖 `ELECTRON_RUN_AS_NODE` 的 `child_process.fork` 失效，所以服务应使用 utility process。fuses 收紧功能边界，不代表删除对应二进制代码或降低内存。[Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)

## 验证记录

以下是项目测量方案，不是官方性能承诺。分别记录 Windows 与 macOS、CPU 架构、Electron 版本、发布构建及同一测试文件。比较同一机器上的基线与改动，至少重复五次，并分开冷启动与暖启动；不要拿不同系统的内存口径直接排序。Electron 提供 `app.getAppMetrics()` 获取进程 CPU 和内存信息，可与系统工具交叉核对。[app.getAppMetrics](https://www.electronjs.org/docs/latest/api/app#appgetappmetrics)

| 指标 | 记录方式 |
| --- | --- |
| 启动 | 启动到 Host ready、首窗出现、画布可交互，分别记时间 |
| 内存 | 记录全部所属进程及进程类型；说明 RSS/working set/private 等口径与共享页重复统计限制 |
| 空闲 CPU | 打开固定文件后稳定等待，连续采样 60 秒；同时记录窗口数量和后台活动 |
| 包体 | 分别记录下载归档字节、解包后字节、app.asar 和额外资源字节 |
| 使用与退出 | 验证编辑、保存、多窗口、服务崩溃及退出后无残留服务 |

在这些数据产出前，只能说结构减少了重复打包和服务启动路径，不能声称应用已快多少、少用多少内存或达到某个包体上限。
