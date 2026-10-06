# ZCode Feiyu · 飞鱼版

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode Feiyu" width="128" height="128" />
</div>
<p align="center">简体中文 | <a href="README.en.md">English</a></p>

ZCode Feiyu 是基于 [zai-org/ZCode](https://github.com/zai-org/ZCode) 的社区二次开发版本，保留桌面应用、Web 界面、终端 Agent 和共享运行时，增加本地顶层任务协作、标准／coordinator／swarm 编排、持久项目记忆与自动整理、受控主动工作、统一遥测控制、内置 fal 图片生成，以及用户自行部署的 RCS 远程访问能力。

本仓库由飞鱼同学维护，与官方发行版独立。界面和交互复用 ZCode 现有组件；应用内部名称及本地包名称仍为 ZCode / ZCode Preview。上游基线为 **v3.14.3，提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`**。以下对比以该公开源码为准，不代表上游未来版本。

优化模型供应商的操作便捷性。

## 下载安装包

在 [GitHub Releases](https://github.com/showjiangnan/zcode-feiyu/releases) 下载飞鱼版。首个版本为 [v3.14.3-feiyu.1（预发布）](https://github.com/showjiangnan/zcode-feiyu/releases/tag/v3.14.3-feiyu.1)，应用内版本仍为 **3.14.3**，安装后名称为 **ZCode Preview**。

**源码与安装包版本区别：** 当前 `main`（3.14.4）已加入下文的记忆、编排、主动工作、执行预算移除、swarm 请求修复和 RCS 远程服务；`v3.14.3-feiyu.1` 是较早的安装包，不包含这些后续更新。使用当前源码能力请按下文构建；现有下载链接不会自动变成新构建。

| 平台                         | 下载                                                                                                                                                                                                                                                        | 本次验证范围                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| macOS Apple Silicon（arm64） | [DMG 安装包](https://github.com/showjiangnan/zcode-feiyu/releases/download/v3.14.3-feiyu.1/ZCode-Feiyu-3.14.3-mac-arm64.dmg) · [ZIP 压缩包](https://github.com/showjiangnan/zcode-feiyu/releases/download/v3.14.3-feiyu.1/ZCode-Feiyu-3.14.3-mac-arm64.zip) | 在 Apple Silicon Mac 构建；最终归档内容、ad-hoc 签名、内置 Agent 启动及终端原生模块冒烟通过                      |
| Windows x64                  | [EXE 安装包](https://github.com/showjiangnan/zcode-feiyu/releases/download/v3.14.3-feiyu.1/ZCode-Feiyu-3.14.3-win-x64.exe)                                                                                                                                  | 在同一 Mac 交叉构建；NSIS 安装器、运行时依赖、x64 主程序/PTY 及归档内容检查通过；**尚未在 Windows 实机安装运行** |

[SHA256SUMS.txt](https://github.com/showjiangnan/zcode-feiyu/releases/download/v3.14.3-feiyu.1/SHA256SUMS.txt) 提供三个安装包的 SHA-256 摘要。macOS 可用 `shasum -a 256 <文件>`，Windows PowerShell 可用 `Get-FileHash <文件> -Algorithm SHA256`，与校验文件比对。

- **Mac 安装**：打开 DMG，将 ZCode Preview 拖入“应用程序”，再从“应用程序”启动；ZIP 用户先解压再复制。此包为 ad-hoc 签名，未使用 Apple Developer ID，也未经 Apple 公证；若系统拦截，确认下载来源及摘要后按“系统设置 → 隐私与安全性”的提示处理。
- **Windows 安装**：运行 EXE，按向导选择安装目录。安装器没有 Authenticode 发布者签名，系统可能显示未知发布者或 SmartScreen 提示。
- **平台差异**：共用生产源码不代表已证明所有功能跨平台一致。Windows 的终端、任务协作、fal 出图、文件权限及升级仍需实机验收；SSH 的可选原生加速模块不适用于 Windows，本包使用库内置的 JS/Node 加密回退，该路径已在本机完成握手与命令收发验证。此次没有发布 Intel Mac、Windows arm64 或 Linux 安装包。
- **更新**：从飞鱼版 Releases 下载新包，退出应用后覆盖安装并保留数据目录。本仓库尚未提供飞鱼版自动更新服务；源码 `git pull` 不会更新已安装应用，官方版安装包也不应覆盖飞鱼版。

## 新增能力与官方版对比

| 能力                             | 官方基线 v3.14.3                                 | ZCode Feiyu                                                        |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| Desktop / Web / CLI、Agent 与 V4 | 已有                                             | 保留并复用                                                         |
| 当前线程编排                     | 已有普通子 Agent                                 | 标准模式、`coordinator`、`swarm`；请求边界动态切换                 |
| 工作区记忆与整理                 | 已有会话及上下文基础                             | 身份隔离、相关召回、提取/整理、历史、差异及修订保护撤销            |
| 受控主动工作                     | 已有任务运行时                                   | 应用许可加线程启用、事件/计时器准入、暂停及停止                    |
| 消费累计执行限制                 | 原有执行策略                                     | 移除累计消费停工；保留用量、压缩、权限与取消                       |
| 本地顶层任务应用服务             | 已有底层会话操作，没有本版统一任务工具及服务入口 | 增加发现、创建、读取、发送、回执查询、等待及生命周期控制           |
| 顶层任务 A→B 自动发送            | 已有子代理消息等基础机制                         | 同工作区顶层任务互发提示词，忙时优先 guide/steer                   |
| 自动消息来源提示                 | 没有本版来源类型及文案                           | 来源随消息持久化，显示“来自zcode其他任务自动发送”                  |
| 遥测统一设置                     | 没有本版贯穿三个出口的总开关                     | 统一控制 ARMS、ZCode 事件、桌面及 Agent OTLP 上报                  |
| 安装版动态工作流                 | Preview 强制开启，Production 受原有门控约束      | Production / Preview 安装版均注入 `alwaysOn`                       |
| 本地 Session Mailbox             | 需要 `ZCODE_MESSAGE_ENABLED=1/true`              | 默认开启，支持显式关闭                                             |
| 工作区搜索范围设置               | 页面存在，导航入口隐藏                           | 开放入口，继续使用已有 `.zcodeignore` 能力                         |
| fal 内置图片生成                 | 没有本版设置、工具和图片作业链路                 | 可配置 Key、生成模型和编辑模型，支持加载、保存、预览、恢复和取消   |
| 用户自托管 RCS                   | 原有手机远控与 SSH 基础                          | 独立 Python 桥接、响应式完整共享 Web、现有 Host 附着、公共 API/SDK |
| 远程服务设置                     | 原 SSH / 机器人入口                              | 第三分组：RCS服务、SSH、移动聊天机器人，复用既有状态与组件         |
| 子代理图片费用控制               | 不适用                                           | 独立授权开关，默认关闭                                             |
| 图片参数                         | 不适用                                           | 默认一张 PNG，按模型能力校验显式尺寸、数量和格式                   |

这里的“App Server 能力”建立在 **ZCode 自有 stdio / V4 / Agent 架构**上。它没有内嵌 OpenAI Codex 服务，也不承诺兼容 Codex App Server 的外部协议。已有会话、输入顺序、恢复和图片 artifact 仍由原运行时管理，没有建立平行任务数据库。

## 如何使用二开能力

### 当前线程的标准 / coordinator / swarm 编排

输入框权限选择器右侧的编排菜单只控制**当前线程**，可随时切换：

| 模式             | 工作方式                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| 标准模式（默认） | 主 Agent 正常使用工具，也可调用普通子 Agent。                                                      |
| `coordinator`    | 主 Agent 分解、委派、观察和整合；直接工具限制为读取与任务管理，修改交由遵守原权限的子 Agent 执行。 |
| `swarm`          | 主 Agent 创建有名成员，通过 `TeamTask` 维护共享任务板，并用 `SendMessage` 向成员发送任务内消息。   |

运行中切换在下一次模型请求边界生效，当前请求保留原配置。成员消息属于这个团队；跨顶层任务仍使用下文的 App Server 任务工具。团队最多 8 名有名成员，任务板、消息大小、权限、取消及恢复都有独立边界。中英文菜单和触发按钮统一显示 `coordinator` / `swarm`。

当前代码已修复 swarm 工具 schema 的提供商兼容问题：提供商接收普通对象，执行端继续严格检查每个动作的字段和权限。预热新会话也不会在父会话创建之前写入模型选择或把合法空会话误报成丢失任务。

### 项目记忆、自动整理与主动工作

在设置的 Agent 能力页配置：

- **工作区记忆**：新配置默认关闭；开启后按工作区身份隔离记忆，支持相关内容召回、只读查看、修改历史、差异及受修订保护的撤回。
- **自动提取**：独立开关，新配置默认关闭；从完成的会话提取可复用信息。关闭总记忆许可同时阻止新的提取与整理。
- **自动整理**：独立开关，新配置默认关闭；达到时间与候选会话门槛后整理已有记忆，也可手动“立即整理”。界面展示进度、实际范围、用量与取消结果；不会在每次发送后立即运行。
- **允许主动工作**：默认关闭。开启应用许可后，还需在具体线程中启动主动工作；线程可暂停或停止，事件与定时唤醒沿用同一任务 admission。
- **记忆历史范围**：选择当前会话、工作区或不读取历史。关闭记忆后已有文件和历史仍可只读查看。

macOS 的关窗后台执行取决于后台许可与可用的受管 Host；**Cmd+Q 会退出应用及其受管进程**。关窗后台不代表开机自动启动，也不保证合盖或系统休眠期间持续运行。

### 持续执行与用量

当前版本移除了按累计 token、费用、请求次数、任务总时长和默认连续轮次强制终止任务的执行预算。主任务、子 Agent、目标任务和记忆维护不会因旧消费额度达到上限而自动暂停；旧预算设置在读取时兼容丢弃，历史用量保留。

用量仍可观察，缺少提供商 usage 时标记为估算。上下文容量与自动压缩、单次输出限制、并发背压、网络重试、工具超时、用户明确指定的 `maxTurns`、权限和取消仍有效。**持续执行不等于免费或没有提供商额度限制**；模型、子 Agent 和记忆维护仍由相应提供商收费。

### 同工作区任务协作

在桌面端打开一个**本地工作区**，创建两个独立顶层任务，例如“实现”和“审查”。在其中一个任务中明确要求：

> 找到当前工作区名为“审查”的任务，向它发送：请检查刚才的修改，重点关注异常处理。随后等待它完成并汇总结果。

Agent 使用 `ListWorkspaceTasks`、`SendTaskMessage` 及任务读取/等待工具，以发现结果中的任务 ID 定位目标。服务还提供恢复、重命名、归档/取消归档、关闭、压缩、停止、取消输入和分叉等操作。

- B 空闲时开始执行；忙且当前轮允许导入时使用 guide/steer；不可导入时排队，并返回实际投递结果。
- 手动输入保留已有等待/导入交互；跨任务输入显示独立来源标记。
- 范围是**同一本地工作区的顶层任务**，不是任意跨工作区、跨机器控制接口。子代理和工作流子任务不获得顶层协作工具。

### 遥测、工作流、Mailbox 与搜索

- **遥测**：设置 → 常规 → **允许遥测上报**。关闭会传播到活动本地 Host/Agent；旧待发事件不会在重新开启后补传。没有明确开启的配置按关闭处理。
- **动态工作流**：安装版默认开放，在自动化界面使用工作流入口。源码开发时可显式设置 `ZCODE_DYNAMIC_WORKFLOW_MODE=alwaysOn`。
- **Mailbox**：默认启用。启动进程时设置 `ZCODE_MESSAGE_ENABLED=0`（或 `false/off/disabled`）可关闭自动装配的本地 Mailbox。
- **搜索**：设置 → **工作区搜索范围**，编辑忽略规则或从 `.gitignore` 同步，沿用 `.zcodeignore` 语义。

### 用户自托管 RCS 与远程服务

桥接项目：[showjiangnan/zcode-rcs](https://github.com/showjiangnan/zcode-rcs)。后端使用 Python 3.12+，包含响应式共享 ZCode Web、部署文件、协议 JSON Schema、独立 JavaScript/TypeScript SDK 与接入示例。服务器只负责鉴权、目录查询和转发，本机 ZCode 仍负责模型、工具、会话、记忆和终端。

1. 在自己的服务器部署桥接程序，配置独立 HTTPS 域名，生成并保存自己的桥接密钥；按桥接仓库 README 配置反向代理与持久卷。
2. 在桌面 **设置 → 远程服务 → RCS服务** 输入该端点与密钥，选择允许公开的工作区，验证连接后保存并开启。密钥由 Electron safeStorage 保护，不回显；未选择的工作区不能附着。
3. 在另一台电脑或手机浏览器打开同一桥接端点，输入同一密钥，选择在线设备、窗口和工作区，即可使用该桌面 Host 的共享会话界面。
4. 会话、编排、任务间消息、记忆、图片、文件/Git 与终端继续沿用原运行时。浏览器刷新与断线恢复重新附着，Host 终端可按原 ID 续接；离线期间不自动提交草稿。桌面必须保持打开且电脑可联网。
5. 同一设置分组中的 **SSH** 复用原生连接向导；**移动聊天机器人** 使用独立设置页面，已有记录保持原服务持久化，旧会话侧栏图标已移除。

Web 可管理允许的会话及模型设置；模型/API 凭据不会在读取或通知中回显，空输入保留已保存值。RCS 根配置、系统动作、SSH 新连接和机器人设备配置在桌面管理。原生内嵌浏览器与电脑控制权限不会因远控而扩大。

微信小程序/App 可使用同一 REST、WebSocket 和 SDK 合同自行实现客户端，无需微信登录；本仓库没有交付小程序或 App 成品。桥接与桌面使用版本协商和严格 workspace identity/Host generation；API 合同见桥接项目的 `docs/API.md`。

**信任与部署边界**：桥接服务可见转发的数据，采用 HTTPS/WSS 传输保护，当前不提供端到端加密。应部署在自己可信的服务器；没有开发者中心目录、默认管理员或远控后门。公开部署必须使用有效 TLS；明文 HTTP 只允许显式开启的本机 loopback 测试。关闭服务、撤销浏览器或更换密钥会关闭对应 attachment，不删除本地会话。

构建桌面与 Web 后，可同步桥接配套资源：

```bash
pnpm --filter @zcode/web build
node scripts/build-rcs-assets.mjs ../zcode-rcs
```

导出的 `web/`、`sdk/` 和 `protocol/` 是桥接仓库的交付资产，升级时应一起更新；云服务器无需 Node.js 或 Electron。

### 图片生成：fal.ai

平台入口：[fal.ai](https://fal.ai/) · [API Keys](https://fal.ai/dashboard/keys) · [模型目录](https://fal.ai/models) · [官方文档](https://docs.fal.ai/)。注册登录并配置可用额度；实际图片生成由 fal 及其模型提供商计费。

进入 **设置 → Agent 能力 → 图片生成**：

| 字段                        | 填写方式                                                               |
| --------------------------- | ---------------------------------------------------------------------- |
| API 地址                    | 默认 `https://queue.fal.run`，不要填模型网页地址                       |
| API Key                     | 在 fal 的 API Keys 页面创建并填写；保存后不回显，留空保留已存密钥      |
| 生成模型                    | 点击“刷新模型”选择，或输入完整 endpoint ID，例如 `fal-ai/flux/schnell` |
| 编辑模型 ID                 | 可选；填写支持参考图的编辑 endpoint，以模型 API 页面为准               |
| 开启图片生成服务            | 保存配置并开启，然后创建新会话                                         |
| 允许 Subagents 使用图片生成 | 默认关闭；开启后子代理和工作流子任务也可能产生图片费用                 |

先点击 **验证连接（不生成图片）**：读取模型 Schema 并验证凭据，不提交付费生成。自建网关必须实现本项目使用的 fal Queue、模型目录和鉴权协议，不能直接替换成任意 OpenAI Images 兼容接口。

新会话示例：

> 生成一张日本漫画风格的图片：小猫趴在草坪上，彩色蝴蝶停在头顶。1024×768，PNG。

> 生成两张 1024×1024 的产品概念图，WebP 格式。

默认 **1 张 PNG**。PNG/JPEG/WebP、宽高和数量在付费提交前按所选模型校验；应用最多允许单次 8 张，仍受模型更小的限制。不是所有模型都支持 WebP、精确像素或编辑；不支持的参数会明确报错。

生成过程中显示 loading，结果返回并保存原图后展示图片，可预览和保存。`GenerateImage` 发起生成；`ManageImageGeneration` 查询、恢复或取消已有作业。提交结果不确定时不自动重新付费提交；取消不能撤销提供商已产生的费用。关闭服务或清除 Key 不删除已保存的本地图片。

图片服务发送本次提示词和明确引用的图片，不会为了生成图片自动上传整个仓库。代码 Agent 的正常模型请求仍可能包含任务需要的代码、历史和工具结果。关闭遥测不等于关闭模型、插件、更新检查等所有网络请求。

## 初始化与开发

准备 Git、Node.js **24.14.0**、pnpm **10.33.2**，以 [mise.toml](mise.toml) 为准。命令均从仓库根目录执行。

```bash
git clone https://github.com/showjiangnan/zcode-feiyu.git
cd zcode-feiyu
pnpm bootstrap

# 桌面开发：生产服务配置
pnpm dev:desktop

# 独立开发数据目录（macOS / Linux）
ZCODE_DATA_BASE_DIR="$HOME/.zcode-dev-home" pnpm dev:desktop:test

# Web 客户端 + 本地后端
pnpm dev:web

# CLI 源码入口
pnpm --filter @zcode/cli dev --help
```

`bootstrap` 安装依赖、准备本地桌面运行资源并构建。Agent 已包含在 `apps/zcode-cli/`，无需 Git 子模块。Web 开发默认访问 `http://localhost:5173`，后端默认 `http://localhost:3030`；可通过 `ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web` 指定工作区。

SSH/WSL 开发资源按需运行 `pnpm bootstrap:with-remote`，然后启动桌面，连接远程项目时选择“本地下载后上传”。远端能力仍遵循原有平台限制，顶层任务协作范围保持为本地工作区。

### 配置

以 [.env.example](.env.example) 为示例设置服务地址；本机覆盖放入不提交的 `.env` / `.env.local`。公开 OAuth client ID 不是 API Key。

| 配置                                 | 用途                                     |
| ------------------------------------ | ---------------------------------------- |
| `ZCODE_DATA_BASE_DIR`                | 应用数据基目录，数据写入其下的 `.zcode/` |
| `ZCODE_SERVER_WORKSPACE`             | Web 后端工作区                           |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 自定义 Provider 配置路径                 |
| `ZCODE_DIST_BASE_URL`                | CLI 发行包下载根地址                     |

## 打包、安装与后续更新

### macOS Apple Silicon 本地版

使用 Preview 安装身份、生产服务配置，在打包阶段完成 ad-hoc 签名，使最终 DMG/ZIP 包含已签名的应用：

```bash
ZCODE_ENV=production \
ZCODE_PREVIEW_IDENTITY=1 \
ZCODE_SKIP_REMOTE_ASSETS=1 \
ZCODE_BOOTSTRAP_WITH_REMOTE=1 \
ZCODE_ENABLE_MAC_SIGN=1 \
CSC_NAME=- \
pnpm bundle:desktop -- --os mac --arch arm64
```

输出在 `packages/desktop/dist/`，包含 `mac-arm64/ZCode Preview.app` 和 DMG/ZIP。`ZCODE_SKIP_REMOTE_ASSETS=1` 跳过本次本地桌面构建无需准备的远端部署资产；需要远端发行资源时去掉该项并准备相应资产。

打包结束后验证签名，退出旧应用后复制新 `.app` 到“应用程序”覆盖同名应用：

```bash
codesign --verify --deep --strict \
  "packages/desktop/dist/mac-arm64/ZCode Preview.app"
```

ad-hoc 签名不等于 Apple Developer ID 签名或公证。正式可信分发应配置自己的 Developer ID 和公证流程；只在构建后单独签名 `.app` 不会更新已生成的 DMG/ZIP。Preview 身份用于独立安装，**不保证用户数据隔离**；需要隔离时设置 `ZCODE_DATA_BASE_DIR`。

后续更新：保存本地修改，执行 `git pull --ff-only`，刷新依赖并重新构建，退出应用后覆盖同一 `.app`。源码变化不会自动进入已安装应用；更新时保留数据目录。本仓库没有提供飞鱼版自动更新下载服务，不应使用官方安装包覆盖自定义版本。确认新应用可运行后，可删除 `packages/desktop/dist/` 中的安装包和打包副本。

本轮在 Apple Silicon Mac 上实际完成的 Windows x64 交叉打包命令为：

```bash
ZCODE_ENV=production \
ZCODE_PREVIEW_IDENTITY=1 \
ZCODE_SKIP_REMOTE_ASSETS=1 \
ZCODE_BOOTSTRAP_WITH_REMOTE=1 \
pnpm bundle:desktop -- --os win --arch x64
```

工具链按需下载 Windows Electron、Wine 和 NSIS 资源，使用已有 Windows 预编译依赖。切换目标时必须完整准备对应运行时，不能复用另一平台的 native 资产。构建成功不等同于 Windows 实机验收；[electron-builder 跨平台构建说明](https://www.electron.build/docs/features/multi-platform-build/)也明确区分了预编译依赖和必须在目标平台编译的依赖。其他参数见 `pnpm bundle:desktop -- --help`。

### CLI 发行包

```bash
# 将占位地址换成自己的发行包托管地址
pnpm build:zcode --base-url https://downloads.example.com/zcode/
```

`dist/zcode/` 中生成版本运行包、校验摘要和安装脚本。安装后 `zcode` 默认进入 TUI；`zcode --web --workspace /path/to/project --port 3030 --no-open` 启动 Web。Web 默认监听本机，对外部署时配置认证和网络保护。

## 源码结构与发布范围

| 目录                                                 | 内容                                   |
| ---------------------------------------------------- | -------------------------------------- |
| `packages/desktop`                                   | Electron Main、Host、Renderer 与打包   |
| `packages/web`、`packages/server`                    | Web 客户端与后端                       |
| `packages/ui`                                        | 共享 React 组件、hooks 和 Zustand 状态 |
| `packages/services`                                  | 业务服务、任务/图片服务与持久化        |
| `packages/shared`、`packages/rpc`、`packages/client` | 协议、类型、RPC、Agent SDK             |
| `apps/zcode-cli`                                     | Agent、CLI、TUI、工具及内置技能        |
| `scripts`、`config`、`patches`、`third-party`        | 构建脚本、配置、依赖补丁和许可材料     |

本仓库包含生产源码、可构建所需资产及中英文 README，不包含研发 spec 工程、测试用例/夹具、测试报告、本机凭据、会话和构建产物。保留的技能 Markdown、Browser Use 说明是程序读取的运行资产；原生搜索归档是构建所需第三方依赖。许可证、NOTICE 和第三方声明随源码保留。

### 验证状态

RCS 已在 macOS arm64 的 3.14.4 安装版、本地 Python 服务与真实桌面 Host 上完成：浏览器端模型往返、standard/coordinator/swarm、刷新恢复、独立 SDK、同 commandId 对账、授权路径/凭据拒绝、HTTP Range 及同 PTY ID 续接；电脑/320/390/430px 浏览器交互已验收。根 typecheck、Lint（0 errors，存在既有 warnings）与架构检查通过。测试使用本地模型 fixture，不代表所有第三方模型、真实云公网 TLS、实体手机软键盘、远端 SSH 主机或机器人平台均已验证。Docker 部署文件已提供，本轮未在 Docker 引擎上运行。

当前更新已执行根类型检查、CLI 类型检查、根 Lint、架构检查，以及真实 Agent/SQLite/stdio 和生产 UI 组件验证。swarm 请求覆盖 OpenAI Chat Completions 与 Anthropic Messages 两种格式、本地任务板及两种恢复链路；本地 HTTP fixture 不代表所有真实模型均已验证。CLI 全量 Lint 仍有既有大文件超限，不能视为全门禁通过。

macOS arm64 安装包与本机启动有实际验证；较早图片兼容修复还完成了真实 fal 的**无付费连接验证**。实际付费出图、真实 CDN 故障和 Windows 真机仍需独立验收。测试源码和测试记录按发布范围排除。

## 许可与致谢

沿用 [Apache License 2.0](LICENSE)，保留上游及第三方版权，见 [NOTICE.md](NOTICE.md) 和 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。二开修改包括任务协作、记忆、编排、主动工作、执行策略、遥测控制、功能开放和 fal 图片能力，相应修改文件注明 ZCode Feiyu 来源。ZCode 名称和原有标识属于各自权利人，不代表官方背书。

感谢 ZCode 上游和各开源依赖维护者。问题反馈请提交到 [本仓库 Issues](https://github.com/showjiangnan/zcode-feiyu/issues)。

补充检查 Desktop Main 独立 tsconfig 时仍有仓库既有类型错误；根规定的 typecheck 通过不代表每个独立 TypeScript 项目都已通过。
