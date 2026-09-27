# ZCode Feiyu

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode Feiyu" width="128" height="128" />
</div>
<p align="center"><a href="README.md">简体中文</a> | English</p>

ZCode Feiyu is a community fork of [zai-org/ZCode](https://github.com/zai-org/ZCode). It retains the desktop application, Web interface, terminal Agent, and shared runtime, and adds local top-level task collaboration, unified telemetry controls, and built-in image generation through fal.

Maintained independently by Feiyu, this repository is separate from official releases. Existing ZCode UI components and interactions are reused; application names remain ZCode / ZCode Preview. The upstream baseline is **v3.14.3, commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`**. Comparisons refer to that public source revision, not future upstream versions.

## Additions and comparison

| Capability                               | Official v3.14.3 baseline                                                    | ZCode Feiyu                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Desktop / Web / CLI, Agent, V4           | Available                                                                    | Retained and reused                                                                            |
| Local top-level task application service | Low-level session operations, without this fork's unified task tools/service | Discovery, creation, reading, input delivery, receipt queries, waiting, and lifecycle controls |
| Automatic prompts from task A to B       | Foundations such as subagent messaging                                       | Same-workspace top-level messaging, preferring guide/steer while busy                          |
| Automatic message attribution            | No source type or label introduced here                                      | Persistent provenance and “Sent automatically from another ZCode task”                         |
| Unified telemetry setting                | No single setting spanning the three paths implemented here                  | Controls ARMS, ZCode events, and desktop/Agent OTLP reporting                                  |
| Packaged dynamic workflows               | Forced on in Preview; Production follows upstream gating                     | `alwaysOn` in both Production and Preview packages                                             |
| Local Session Mailbox                    | Requires `ZCODE_MESSAGE_ENABLED=1/true`                                      | Enabled by default, with an explicit opt-out                                                   |
| Workspace search settings                | Implemented page with hidden navigation                                      | Visible entry for the existing `.zcodeignore` feature                                          |
| Built-in fal image generation            | No settings/tools/image-job pipeline introduced here                         | Provider key, generation/edit models, loading, storage, preview, resume, and cancellation      |
| Subagent image spending                  | Not applicable                                                               | Separate permission switch, off by default                                                     |
| Image parameters                         | Not applicable                                                               | One PNG by default; explicit dimensions/count/format validated against model capabilities      |

“App Server capabilities” are implemented using **ZCode's own stdio / V4 / Agent architecture**. This fork does not embed OpenAI Codex or promise compatibility with the external Codex App Server protocol. Existing runtimes retain ownership of sessions, admission ordering, recovery, and image artifacts; there is no second task database.

## Using the added features

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

Use the Preview application identity with production service configuration:

```bash
ZCODE_ENV=production \
ZCODE_PREVIEW_IDENTITY=1 \
ZCODE_SKIP_REMOTE_ASSETS=1 \
ZCODE_BOOTSTRAP_WITH_REMOTE=1 \
pnpm bundle:desktop -- --os mac --arch arm64
```

Outputs in `packages/desktop/dist/` include `mac-arm64/ZCode Preview.app`, DMG, and ZIP files. `ZCODE_SKIP_REMOTE_ASSETS=1` skips remote deployment asset preparation for this local desktop build. Remove it and prepare matching assets when producing remote distributions.

For local development without a Developer ID, apply and verify an ad-hoc signature on the generated `.app`. Quit the old application, then copy the new `.app` into Applications, replacing the same application:

```bash
codesign --force --deep --sign - \
  --entitlements packages/desktop/build/entitlements.mac.plist \
  "packages/desktop/dist/mac-arm64/ZCode Preview.app"
codesign --verify --deep --strict \
  "packages/desktop/dist/mac-arm64/ZCode Preview.app"
```

Ad-hoc signing is not Apple Developer ID signing or notarization; public installers require your own signing process. These commands modify only the `.app`, not the already generated DMG/ZIP files. Preview supports a separate application installation but **does not guarantee isolated user data**; set `ZCODE_DATA_BASE_DIR` for isolation.

To update, preserve local edits, run `git pull --ff-only`, refresh dependencies/build, quit the application, and replace the same `.app`. Source edits do not automatically update an installed application. Preserve its data directory. This repository does not provide a Feiyu automatic-update download service; official installers should not replace a customized fork. Once the new application works, installers and packaging copies in `packages/desktop/dist/` can be deleted.

Other targets: `pnpm bundle:desktop -- --os win --arch x64`; see `pnpm bundle:desktop -- --help`. Native dependencies and signing require appropriate platform tools. Installation has not been validated on every operating system.

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

The development workspace has completed relevant type checks, controlled service/Agent integration checks, and UI verification. The latest image compatibility fix passed 19 service and real Agent-process tests. A local macOS arm64 installation and **real fal validation without paid generation** were verified. Paid image output, real CDN failures, and cross-platform installation still require separate validation. Fixture output is not evidence of actual provider-generated images. Test sources are excluded from this repository's publication scope.

## License and acknowledgements

Distributed under [Apache License 2.0](LICENSE), retaining upstream and third-party notices in [NOTICE.md](NOTICE.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Fork changes cover task collaboration, telemetry controls, feature activation, and fal image support; modified files identify ZCode Feiyu as the modification source. Existing names and marks belong to their respective owners and do not imply official endorsement.

Thanks to upstream ZCode and its open-source dependencies. Report issues through [this repository's issue tracker](https://github.com/showjiangnan/zcode-feiyu/issues).
