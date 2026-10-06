# ZCode Feiyu

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode Feiyu" width="128" height="128" />
</div>
<p align="center"><a href="README.md">简体中文</a> | English</p>

ZCode Feiyu is a community fork of [zai-org/ZCode](https://github.com/zai-org/ZCode). It retains the desktop application, Web interface, terminal Agent, and shared runtime, and adds local top-level task collaboration, standard/coordinator/swarm orchestration, persistent project memory and review, controlled proactive work, unified telemetry controls, built-in image generation through fal, and self-hosted RCS remote access with a responsive shared Web interface.

Maintained independently by Feiyu, this repository is separate from official releases. Existing ZCode UI components and interactions are reused; application names remain ZCode / ZCode Preview. The upstream baseline is **v3.14.3, commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`**. Comparisons refer to that public source revision, not future upstream versions.

Improved usability of model provider settings.

## Download installers

Get Feiyu builds from [GitHub Releases](https://github.com/showjiangnan/zcode-feiyu/releases). The first release is [v3.14.3-feiyu.1 (prerelease)](https://github.com/showjiangnan/zcode-feiyu/releases/tag/v3.14.3-feiyu.1). The in-app version remains **3.14.3**, and the installed application is named **ZCode Preview**.

The capabilities described below refer to **current `main` source (3.14.4)**. The older `v3.14.3-feiyu.1` downloads do not include the subsequent memory, orchestration, proactive-work, budget-removal, swarm fixes, or RCS remote services. Build current source with the instructions below to obtain these changes; publishing source does not replace older Release packages.

| Platform                    | Download                                                                                                                                                                                                                                                        | Verification in this release                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS Apple Silicon (arm64) | [DMG installer](https://github.com/showjiangnan/zcode-feiyu/releases/download/v3.14.3-feiyu.1/ZCode-Feiyu-3.14.3-mac-arm64.dmg) · [ZIP archive](https://github.com/showjiangnan/zcode-feiyu/releases/download/v3.14.3-feiyu.1/ZCode-Feiyu-3.14.3-mac-arm64.zip) | Built on Apple Silicon; final archive contents, ad-hoc signatures, bundled Agent startup, and terminal native-module smoke checks passed                                             |
| Windows x64                 | [EXE installer](https://github.com/showjiangnan/zcode-feiyu/releases/download/v3.14.3-feiyu.1/ZCode-Feiyu-3.14.3-win-x64.exe)                                                                                                                                   | Cross-built on the same Mac; NSIS packaging, runtime dependencies, x64 application/PTY binaries, and archive contents checked; **not yet installed or run on a real Windows system** |

[SHA256SUMS.txt](https://github.com/showjiangnan/zcode-feiyu/releases/download/v3.14.3-feiyu.1/SHA256SUMS.txt) contains SHA-256 digests for all three packages. Compare them with `shasum -a 256 <file>` on macOS or `Get-FileHash <file> -Algorithm SHA256` in Windows PowerShell.

- **Install on Mac**: open the DMG, drag ZCode Preview to Applications, and launch it from Applications. ZIP users should extract and copy the app first. This build uses an ad-hoc signature, without an Apple Developer ID certificate or Apple notarization. If macOS blocks it, verify the source and digest, then follow the prompts under System Settings → Privacy & Security.
- **Install on Windows**: run the EXE and choose an installation directory in the wizard. The installer has no Authenticode publisher signature, so Windows may show an unknown-publisher or SmartScreen prompt.
- **Platform differences**: shared production sources do not establish complete feature parity. Windows terminal behavior, task collaboration, fal generation, file permissions, and upgrades still need real-device validation. The optional SSH native accelerator is not usable on Windows in this cross-build; the library's JS/Node crypto fallback passed a local handshake and command-exchange check. No Intel Mac, Windows arm64, or Linux installer is included in this release.
- **Updates**: download a newer package from Feiyu Releases, quit the app, and install over the previous version while retaining its data directory. This repository has no Feiyu automatic-update service. Pulling source changes does not update an installed app, and official installers should not replace the fork.

## Additions and comparison

| Capability                               | Official v3.14.3 baseline                                                    | ZCode Feiyu                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Desktop / Web / CLI, Agent, V4           | Available                                                                    | Retained and reused                                                                              |
| Per-conversation orchestration           | Existing ordinary subagents                                                  | Standard, `coordinator`, and `swarm`; live switching at model-request boundaries                 |
| Workspace memory and review              | Existing conversation and context foundations                                | Workspace isolation, relevant recall, extraction/review, history, diffs, and protected undo      |
| Controlled proactive work                | Existing task runtime                                                        | Application permission plus per-conversation activation, event/timer admission, pause and stop   |
| Consumption-based execution limits       | Existing execution policy                                                    | Removed accumulated consumption stops; usage, compaction, permissions, and cancellation retained |
| Local top-level task application service | Low-level session operations, without this fork's unified task tools/service | Discovery, creation, reading, input delivery, receipt queries, waiting, and lifecycle controls   |
| Automatic prompts from task A to B       | Foundations such as subagent messaging                                       | Same-workspace top-level messaging, preferring guide/steer while busy                            |
| Automatic message attribution            | No source type or label introduced here                                      | Persistent provenance and “Sent automatically from another ZCode task”                           |
| Unified telemetry setting                | No single setting spanning the three paths implemented here                  | Controls ARMS, ZCode events, and desktop/Agent OTLP reporting                                    |
| Packaged dynamic workflows               | Forced on in Preview; Production follows upstream gating                     | `alwaysOn` in both Production and Preview packages                                               |
| Local Session Mailbox                    | Requires `ZCODE_MESSAGE_ENABLED=1/true`                                      | Enabled by default, with an explicit opt-out                                                     |
| Workspace search settings                | Implemented page with hidden navigation                                      | Visible entry for the existing `.zcodeignore` feature                                            |
| Built-in fal image generation            | No settings/tools/image-job pipeline introduced here                         | Provider key, generation/edit models, loading, storage, preview, resume, and cancellation        |
| Self-hosted RCS                          | Existing remote and SSH foundations                                          | Python bridge, responsive shared Web, existing Host attachment, public API/SDK                   |
| Remote Services settings                 | Existing SSH / bot entries                                                   | RCS Service, SSH, Mobile Chat Bots in a third settings group                                     |
| Subagent image spending                  | Not applicable                                                               | Separate permission switch, off by default                                                       |
| Image parameters                         | Not applicable                                                               | One PNG by default; explicit dimensions/count/format validated against model capabilities        |

“App Server capabilities” are implemented using **ZCode's own stdio / V4 / Agent architecture**. This fork does not embed OpenAI Codex or promise compatibility with the external Codex App Server protocol. Existing runtimes retain ownership of sessions, admission ordering, recovery, and image artifacts; there is no second task database.

## Using the added features

### Standard / coordinator / swarm in the current conversation

The orchestration menu beside the permission selector applies to **the current conversation only** and can be changed at any time:

| Mode               | Behavior                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standard (default) | The main Agent uses its normal tools and may dispatch ordinary subagents.                                                                                                                     |
| `coordinator`      | The main Agent decomposes, delegates, observes, and integrates. Its direct tools are limited to reading and task management; child agents perform edits under the existing permission policy. |
| `swarm`            | The main Agent starts named members, maintains a shared board with `TeamTask`, and sends task-local messages with `SendMessage`.                                                              |

Changes during execution take effect at the next model-request boundary. The in-flight request keeps its original configuration. Team messaging stays within that team; top-level conversations use the App Server tools described below. There are at most eight named members, with separate limits for board size, message size, permissions, cancellation, and recovery. Both locales display the exact labels `coordinator` / `swarm` in the menu and trigger.

Current source fixes swarm tool-schema compatibility: providers receive ordinary objects while execution retains strict action-field and permission validation. A prewarmed conversation also avoids writing model-selection entries before its parent exists or reporting a legitimate empty conversation as missing.

### Project memory, automatic review, and proactive work

Configure these in Settings → Agent capabilities:

- **Workspace memory:** off for new configurations. Memory is isolated by workspace identity, with relevant recall, read-only browsing, modification history, diffs, and revision-protected undo.
- **Automatic extraction:** a separate switch, off for new configurations. Extracts reusable information from completed conversations. Turning off memory permission also prevents new extraction and review.
- **Automatic review:** a separate switch, off for new configurations. Reviews existing memory after time and candidate-conversation thresholds are met; manual “Review now” is also available. Progress, actual scope, usage, and cancellation are visible. It does not run after every message.
- **Allow proactive work:** off by default. Application permission must be enabled before proactive work is started in a specific conversation. Conversations can pause or stop it; event and timer triggers use the same task admission path.
- **Memory history scope:** current conversation, workspace, or no history. Existing memory files and history remain readable after memory is disabled.

macOS execution after closing the last window depends on background permission and an available managed Host. **Cmd+Q exits the application and its managed processes.** Background operation does not imply login startup or guaranteed execution during lid closure or system sleep.

### Continued execution and usage

Current source removes execution budgets that forcibly stop work based on accumulated tokens, cost, request counts, total task duration, or default consecutive-turn caps. Main tasks, subagents, goals, and memory maintenance no longer pause because a retired consumption limit was reached. Legacy budget configuration is discarded on read while historical usage remains available.

Usage remains observable, with estimates labeled when provider usage is unavailable. Context capacity and automatic compaction, per-response output limits, concurrency backpressure, network retries, tool timeouts, explicitly requested `maxTurns`, permissions, and cancellation remain active. **Continued execution is still billable and subject to provider account limits.** Models, subagents, and memory maintenance incur their respective provider charges.

### Collaborate across tasks in one workspace

Open a **local workspace** in the desktop app and create two independent top-level tasks, such as “Implementation” and “Review.” Ask one task:

> Find the task named “Review” in this workspace. Send it: Please review the recent changes, focusing on error handling. Then wait for completion and summarize its findings.

The Agent uses `ListWorkspaceTasks`, `SendTaskMessage`, and task reading/waiting tools. Targets are identified by task IDs returned by discovery. The service also supports resume, rename, archive/unarchive, close, compact, stop, cancel input, and fork operations.

- An idle target starts work. A busy target uses guide/steer when its current turn accepts input; otherwise the input is queued and the actual delivery result is returned.
- Manual input retains existing queue/steer controls. Automatic cross-task input has a distinct source marker; the Chinese label is “来自zcode其他任务自动发送”.
- Scope is **top-level tasks in the same local workspace**, not unrestricted cross-workspace or cross-machine control. Subagents and workflow child tasks do not receive the top-level collaboration tools.

### Telemetry, workflows, Mailbox, and search

- **Telemetry:** Settings → General → **Allow telemetry reporting**. Disabling propagates to active local Hosts/Agents; previously queued events are not replayed when reporting is re-enabled. A configuration without explicit consent is treated as disabled.
- **Dynamic workflows:** enabled in packaged builds; use the workflow entry in the automation interface. For source development, set `ZCODE_DYNAMIC_WORKFLOW_MODE=alwaysOn` when needed.
- **Mailbox:** enabled by default. Set `ZCODE_MESSAGE_ENABLED=0` (or `false/off/disabled`) when starting the process to disable the automatically assembled local adapter.
- **Search:** Settings → **Workspace search scope**. Edit ignore rules or sync from `.gitignore`, retaining existing `.zcodeignore` semantics.

### Self-hosted RCS and Remote Services

The companion [showjiangnan/zcode-rcs](https://github.com/showjiangnan/zcode-rcs) project provides a Python 3.12+ bridge, the responsive shared ZCode Web UI, deployment files, protocol schemas, a standalone JavaScript/TypeScript SDK, and an integration example. The bridge authenticates and forwards traffic; your existing desktop Host owns model execution, tools, sessions, memory, and terminals.

1. Deploy the bridge on your own trusted server with a dedicated HTTPS origin, generate your own bridge key, and configure its reverse proxy and persistent volume as described in that repository.
2. In **Settings → Remote Services → RCS Service**, enter the endpoint and key, select allowed workspaces, validate, save, and enable the service. Electron safeStorage protects the saved key. Unselected workspaces cannot be attached.
3. Open that endpoint in another computer or phone browser, enter the same key, and select an online device, window, and workspace. The shared interface attaches to the existing desktop Host.
4. Conversations, orchestration, task messages, memory, images, files/Git, and terminals retain their existing runtime. Refresh and reconnect restore state; Host terminals can resume with the same ID. Offline drafts are never automatically submitted. Keep the desktop app open and the computer reachable.
5. The same settings group includes **SSH**, using the existing native connection wizard, and **Mobile Chat Bots**, now a full settings page. Existing bot records use the original service and persistence; the former conversation sidebar shortcut has been removed.

Remote model settings do not reveal saved API keys or HTTP header values; blank credential edits retain existing secrets. Device-root RCS configuration, OS actions, new SSH connections, and bot device setup remain desktop operations. Remote access does not grant additional embedded-browser or computer-control permissions.

Future mini-programs and native apps can implement clients against the same REST/WebSocket/SDK contract without a platform login. No mini-program or mobile app product is included. See `docs/API.md` in the companion repository for identity, Host generation, capabilities, admission, and recovery contracts.

**Trust boundary:** the relay can see forwarded traffic. HTTPS/WSS protects transport; this version does not provide end-to-end encryption. Deploy on a trusted server. There is no developer-operated device directory, default administrator, or hidden support access. Public deployment requires valid TLS; plaintext HTTP is restricted to explicitly enabled loopback testing. Disabling the service or revoking sessions/keys closes the affected attachments without deleting local sessions.

Export compatible production assets together when updating the companion project:

```bash
pnpm --filter @zcode/web build
node scripts/build-rcs-assets.mjs ../zcode-rcs
```

The exported `web/`, `sdk/`, and `protocol/` directories are shipped runtime assets. The cloud server does not need Node.js or Electron.

### Image generation with fal.ai

Provider links: [fal.ai](https://fal.ai/) · [API Keys](https://fal.ai/dashboard/keys) · [Model catalog](https://fal.ai/models) · [Official documentation](https://docs.fal.ai/). Sign in and configure usable balance. Image generation is billed by fal and its model providers.

Open **Settings → Agent capabilities → Image generation**:

| Field                              | Configuration                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| API URL                            | Default: `https://queue.fal.run`; do not enter a model's website URL                                         |
| API key                            | Create one on the fal API Keys page; saved credentials are hidden, and a blank field preserves the saved key |
| Generation model                   | Refresh the catalog or enter a full endpoint ID, such as `fal-ai/flux/schnell`                               |
| Editing model ID                   | Optional endpoint supporting reference images; follow its model API page                                     |
| Enable image generation            | Save and enable the service, then create a new conversation                                                  |
| Allow subagents to generate images | Off by default; enabling permits image spending by subagents and workflow child tasks                        |

Click **Test connection (no generation)** first. It reads model schemas and validates credentials without submitting paid inference. Custom gateways must implement the fal Queue, catalog, and authentication contracts used here; a generic OpenAI Images-compatible URL is not a direct substitute.

Example prompts in a new conversation:

> Generate one Japanese manga-style image of a kitten resting on grass with a colorful butterfly above its head. 1024×768, PNG.

> Generate two 1024×1024 product concept images in WebP format.

The default is **one PNG**. PNG/JPEG/WebP, explicit dimensions, and count are validated before paid submission. The application allows up to eight images per request, subject to lower model limits. Not every model supports WebP, precise dimensions, or editing; unsupported parameters produce an explicit error.

A loading state remains until results arrive and original files are stored, after which images can be previewed and saved. `GenerateImage` starts generation; `ManageImageGeneration` queries, resumes, or cancels existing jobs. Uncertain submissions are not automatically resubmitted for another charge. Cancellation cannot reverse provider costs already incurred. Disabling the service or clearing its key does not delete locally saved images.

The image service sends the current prompt and explicitly referenced images; it does not automatically upload the repository for image generation. Ordinary coding-model requests can still include relevant code, history, and tool results. Disabling telemetry does not disable model calls, plugins, update checks, or all other network connections.

## Setup and development

Install Git, Node.js **24.14.0**, and pnpm **10.33.2**, as pinned in [mise.toml](mise.toml). Run commands from the repository root.

```bash
git clone https://github.com/showjiangnan/zcode-feiyu.git
cd zcode-feiyu
pnpm bootstrap

# Desktop development with production service configuration
pnpm dev:desktop

# Separate development data directory (macOS / Linux)
ZCODE_DATA_BASE_DIR="$HOME/.zcode-dev-home" pnpm dev:desktop:test

# Web client and local backend
pnpm dev:web

# Agent CLI source entrypoint
pnpm --filter @zcode/cli dev --help
```

`bootstrap` installs dependencies, prepares local desktop assets, and builds. Agent sources are included in `apps/zcode-cli/`; no Git submodule is required. Web development normally serves the client at `http://localhost:5173` and backend at `http://localhost:3030`. Select a workspace with `ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web`.

For SSH/WSL development assets, run `pnpm bootstrap:with-remote`, start the desktop app, and choose local download followed by upload when connecting to a remote project. Existing platform constraints apply; top-level task collaboration remains scoped to a local workspace.

### Configuration

Use [.env.example](.env.example) for service endpoints, and untracked `.env` / `.env.local` files for local overrides. A public OAuth client ID is not an API key.

| Variable                             | Purpose                                                              |
| ------------------------------------ | -------------------------------------------------------------------- |
| `ZCODE_DATA_BASE_DIR`                | Base data directory; data is stored under its `.zcode/` subdirectory |
| `ZCODE_SERVER_WORKSPACE`             | Web backend workspace                                                |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | Custom provider configuration file                                   |
| `ZCODE_DIST_BASE_URL`                | CLI distribution download base URL                                   |

## Packaging, installation, and updates

### Local macOS Apple Silicon build

Use the Preview application identity with production service configuration, and sign during packaging so that the final DMG/ZIP contains the signed application:

```bash
ZCODE_ENV=production \
ZCODE_PREVIEW_IDENTITY=1 \
ZCODE_SKIP_REMOTE_ASSETS=1 \
ZCODE_BOOTSTRAP_WITH_REMOTE=1 \
ZCODE_ENABLE_MAC_SIGN=1 \
CSC_NAME=- \
pnpm bundle:desktop -- --os mac --arch arm64
```

Outputs in `packages/desktop/dist/` include `mac-arm64/ZCode Preview.app`, DMG, and ZIP files. `ZCODE_SKIP_REMOTE_ASSETS=1` skips remote deployment asset preparation for this local desktop build. Remove it and prepare matching assets when producing remote distributions.

Verify the signature after packaging. Quit the old application, then copy the new `.app` into Applications, replacing the same application:

```bash
codesign --verify --deep --strict \
  "packages/desktop/dist/mac-arm64/ZCode Preview.app"
```

An ad-hoc signature is not an Apple Developer ID signature or notarization. Trusted public distribution requires your own Developer ID and notarization setup. Signing an unpacked `.app` after building does not update existing DMG/ZIP files. Preview supports a separate application installation but **does not guarantee isolated user data**; set `ZCODE_DATA_BASE_DIR` for isolation.

To update, preserve local edits, run `git pull --ff-only`, refresh dependencies/build, quit the application, and replace the same `.app`. Source edits do not automatically update an installed application. Preserve its data directory. This repository does not provide a Feiyu automatic-update download service; official installers should not replace a customized fork. Once the new application works, installers and packaging copies in `packages/desktop/dist/` can be deleted.

The Windows x64 cross-build was also completed on this Apple Silicon Mac with:

```bash
ZCODE_ENV=production \
ZCODE_PREVIEW_IDENTITY=1 \
ZCODE_SKIP_REMOTE_ASSETS=1 \
ZCODE_BOOTSTRAP_WITH_REMOTE=1 \
pnpm bundle:desktop -- --os win --arch x64
```

The toolchain downloads Windows Electron, Wine, and NSIS resources as needed and uses the existing Windows prebuilt dependencies. Always prepare the target runtime when switching platforms; do not reuse another platform's native assets. Successful packaging is not a Windows acceptance test. The [electron-builder cross-platform guide](https://www.electron.build/docs/features/multi-platform-build/) also distinguishes prebuilt dependencies from modules requiring compilation on the target platform. See `pnpm bundle:desktop -- --help` for other options.

### CLI distribution

```bash
# Replace this placeholder with your own distribution host
pnpm build:zcode --base-url https://downloads.example.com/zcode/
```

`dist/zcode/` contains a versioned runtime archive, checksums, and an installer. Once installed, `zcode` starts the TUI; `zcode --web --workspace /path/to/project --port 3030 --no-open` starts Web mode. Web listens locally by default; configure authentication and network protection before exposing it to other devices.

## Source layout and publication scope

| Directory                                            | Purpose                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/desktop`                                   | Electron Main, Host, Renderer, and packaging                       |
| `packages/web`, `packages/server`                    | Web client and backend                                             |
| `packages/ui`                                        | Shared React components, hooks, and Zustand state                  |
| `packages/services`                                  | Business services, task/image services, and persistence            |
| `packages/shared`, `packages/rpc`, `packages/client` | Protocols, types, RPC, and Agent SDK                               |
| `apps/zcode-cli`                                     | Agent, CLI, TUI, tools, and bundled skills                         |
| `scripts`, `config`, `patches`, `third-party`        | Build tooling, defaults, dependency patches, and license materials |

This repository includes production sources, required build assets, and Chinese/English READMEs. It excludes the development spec project, tests/fixtures, test reports, local credentials, conversations, and build outputs. Bundled skill Markdown and Browser Use documents are runtime inputs read by the program; native-search archives are required third-party dependencies. Licenses, NOTICE, and third-party notices remain included.

### Verification status

RCS was tested against the installed 3.14.4 application on macOS arm64 with a local Python relay and a real desktop Host: browser model round trips, standard/coordinator/swarm modes, refresh/recovery, the standalone SDK, same-command reconciliation, scope/credential denials, HTTP Range, and same-ID PTY resume. Desktop and 320/390/430px browser interactions passed. Root typecheck, Lint (zero errors, existing warnings), and architecture checks passed. A local model fixture was used. Public cloud TLS, physical-phone keyboards, real SSH hosts, bot platforms, and all third-party models were not validated. Docker deployment files are supplied; no Docker engine was available for a container runtime test.

The current update runs root and CLI type checks, root lint, architecture checks, real Agent/SQLite/stdio integration, and production UI-component checks. Swarm requests cover OpenAI Chat Completions and Anthropic Messages formats, the local board, and both recovery profiles. A local HTTP fixture is not proof that every real model has been tested. Full CLI lint still has existing file-length violations and must not be reported as fully passing.

The macOS arm64 package and local startup have actual verification. Earlier image fixes also verified **real fal connectivity without paid generation**. Paid image output, real CDN failures, and real Windows devices require separate validation. Test sources and test records are excluded from publication.

## License and acknowledgements

Distributed under [Apache License 2.0](LICENSE), retaining upstream and third-party notices in [NOTICE.md](NOTICE.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Fork changes cover task collaboration, memory, orchestration, proactive work, execution policy, telemetry controls, feature activation, and fal image support; modified files identify ZCode Feiyu as the modification source. Existing names and marks belong to their respective owners and do not imply official endorsement.

Thanks to upstream ZCode and its open-source dependencies. Report issues through [this repository's issue tracker](https://github.com/showjiangnan/zcode-feiyu/issues).

The supplementary standalone Desktop Main tsconfig still reports existing repository type errors; passing the defined root typecheck does not imply that every independent TypeScript project passes.
