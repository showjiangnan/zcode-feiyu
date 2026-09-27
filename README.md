# ZCode Feiyu · 飞鱼版

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode Feiyu" width="128" height="128" />
</div>
<p align="center">简体中文 | <a href="README.en.md">English</a></p>

ZCode Feiyu 是基于 [zai-org/ZCode](https://github.com/zai-org/ZCode) 的社区二次开发版本，保留桌面应用、Web 界面、终端 Agent 和共享运行时，增加本地顶层任务协作、统一遥测控制和内置 fal 图片生成等能力。

本仓库由飞鱼同学维护，与官方发行版独立。界面和交互复用 ZCode 现有组件；应用内部名称及本地包名称仍为 ZCode / ZCode Preview。上游基线为 **v3.14.3，提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`**。以下对比以该公开源码为准，不代表上游未来版本。

## 新增能力与官方版对比

| 能力                             | 官方基线 v3.14.3                                 | ZCode Feiyu                                                      |
| -------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| Desktop / Web / CLI、Agent 与 V4 | 已有                                             | 保留并复用                                                       |
| 本地顶层任务应用服务             | 已有底层会话操作，没有本版统一任务工具及服务入口 | 增加发现、创建、读取、发送、回执查询、等待及生命周期控制         |
| 顶层任务 A→B 自动发送            | 已有子代理消息等基础机制                         | 同工作区顶层任务互发提示词，忙时优先 guide/steer                 |
| 自动消息来源提示                 | 没有本版来源类型及文案                           | 来源随消息持久化，显示“来自zcode其他任务自动发送”                |
| 遥测统一设置                     | 没有本版贯穿三个出口的总开关                     | 统一控制 ARMS、ZCode 事件、桌面及 Agent OTLP 上报                |
| 安装版动态工作流                 | Preview 强制开启，Production 受原有门控约束      | Production / Preview 安装版均注入 `alwaysOn`                     |
| 本地 Session Mailbox             | 需要 `ZCODE_MESSAGE_ENABLED=1/true`              | 默认开启，支持显式关闭                                           |
| 工作区搜索范围设置               | 页面存在，导航入口隐藏                           | 开放入口，继续使用已有 `.zcodeignore` 能力                       |
| fal 内置图片生成                 | 没有本版设置、工具和图片作业链路                 | 可配置 Key、生成模型和编辑模型，支持加载、保存、预览、恢复和取消 |
| 子代理图片费用控制               | 不适用                                           | 独立授权开关，默认关闭                                           |
| 图片参数                         | 不适用                                           | 默认一张 PNG，按模型能力校验显式尺寸、数量和格式                 |

这里的“App Server 能力”建立在 **ZCode 自有 stdio / V4 / Agent 架构**上。它没有内嵌 OpenAI Codex 服务，也不承诺兼容 Codex App Server 的外部协议。已有会话、输入顺序、恢复和图片 artifact 仍由原运行时管理，没有建立平行任务数据库。

## 如何使用二开能力

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

使用 Preview 安装身份、生产服务配置：

```bash
ZCODE_ENV=production \
ZCODE_PREVIEW_IDENTITY=1 \
ZCODE_SKIP_REMOTE_ASSETS=1 \
ZCODE_BOOTSTRAP_WITH_REMOTE=1 \
pnpm bundle:desktop -- --os mac --arch arm64
```

输出在 `packages/desktop/dist/`，包含 `mac-arm64/ZCode Preview.app` 和 DMG/ZIP。`ZCODE_SKIP_REMOTE_ASSETS=1` 跳过本次本地桌面构建无需准备的远端部署资产；需要远端发行资源时去掉该项并准备相应资产。

没有 Developer ID 的本机调试构建，可给生成的 `.app` 做 ad-hoc 签名并验证，退出旧应用后复制新 `.app` 到“应用程序”覆盖同名应用：

```bash
codesign --force --deep --sign - \
  --entitlements packages/desktop/build/entitlements.mac.plist \
  "packages/desktop/dist/mac-arm64/ZCode Preview.app"
codesign --verify --deep --strict \
  "packages/desktop/dist/mac-arm64/ZCode Preview.app"
```

ad-hoc 签名不等于 Apple Developer ID 签名或公证；对外分发安装包应配置相应签名流程。上述命令只修改 `.app`，不会回写已生成的 DMG/ZIP。Preview 身份用于独立安装，**不保证用户数据隔离**；需要隔离时设置 `ZCODE_DATA_BASE_DIR`。

后续更新：保存本地修改，执行 `git pull --ff-only`，刷新依赖并重新构建，退出应用后覆盖同一 `.app`。源码变化不会自动进入已安装应用；更新时保留数据目录。本仓库没有提供飞鱼版自动更新下载服务，不应使用官方安装包覆盖自定义版本。确认新应用可运行后，可删除 `packages/desktop/dist/` 中的安装包和打包副本。

其他目标：`pnpm bundle:desktop -- --os win --arch x64`；参数见 `pnpm bundle:desktop -- --help`。原生依赖和签名需要相应平台工具，本版未完成所有系统的安装验收。

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

开发工作区已完成相关类型检查、受控服务/Agent 集成及 UI 验证；最新图片兼容修复有 19 项服务与真实 Agent 进程测试通过。macOS arm64 本地安装及真实 fal 的**无付费连接验证**已通过。实际付费出图、真实 CDN 故障和跨平台安装仍需独立验收，模拟结果不代表提供商实际输出。测试源码按发布范围未包含在本仓库。

## 许可与致谢

沿用 [Apache License 2.0](LICENSE)，保留上游及第三方版权，见 [NOTICE.md](NOTICE.md) 和 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。二开修改包括任务协作、遥测控制、功能开放和 fal 图片能力，相应修改文件注明 ZCode Feiyu 来源。ZCode 名称和原有标识属于各自权利人，不代表官方背书。

感谢 ZCode 上游和各开源依赖维护者。问题反馈请提交到 [本仓库 Issues](https://github.com/showjiangnan/zcode-feiyu/issues)。
