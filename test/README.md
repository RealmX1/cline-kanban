# 测试执行与 Git 安全契约

测试文件继续留在对应业务领域目录中。文件后缀只区分执行形态，不再为 Git、文件系统和进程能力分别建立命名体系。

| 文件后缀 | Vitest project | 执行约定 |
| --- | --- | --- |
| `*.test.ts` | `precommit-safe` | 普通测试；允许在每个测试独占的临时目录中读写，也允许通过统一 fixture 使用真实 Git。最多两个 workers。 |
| `*.integration.test.ts` | `runtime-integration` | 真实 server、CLI、WebSocket、PTY 或需要完整进程生命周期的测试。单 worker 串行。 |

## Git 测试必须使用统一 fixture

Git repository mutation safety 基础设施集中在 `test/git-repository-mutation-safety/`。真实 Git 测试只能通过 `isolated-git-test-workspace-fixture.ts` 操作仓库；测试文件不得直接执行 literal `git` binary。

fixture 为每个测试创建独立 root、HOME、USERPROFILE、XDG config 和 temp，清除继承的全部 `GIT_*`，禁用 system config、交互和宿主 hooks，并限制 cwd、git-dir、common-dir、worktree、remote、alternates 与 cleanup 都留在 fixture root。integration 子进程需要访问测试仓库时，使用 fixture 的 `createIsolatedChildProcessEnvironment`，不得原样继承 `process.env`。

## 静态策略与宿主仓 canary

`npm run test:policy` 使用轻量 TypeScript AST 检查测试源文件：

- Git fixture 和 repository canary 之外不得直接执行 literal `git`；
- 子进程不得通过 `env: process.env` 或 `{ ...process.env }` 直接继承完整父环境；
- 真实测试 Git 不得使用 production `createGitProcessEnv`。

策略没有注释豁免；需要新的 Git 测试能力时扩展统一 fixture 并补充 fixture 自测。

`npm test`、`npm run test:precommit`、`npm run test:integration` 与 `npm run test:watch` 都通过 invoking-repository mutation canary 启动 Vitest。canary 在测试前后比较 worktree/git-dir/common-dir、symbolic HEAD、HEAD OID、local config、index、porcelain v2 status 与 dirty/untracked 内容 hash。检测到漂移时 fail closed，保存脱敏报告，绝不自动恢复宿主仓库。

## 派生真实 runtime / CLI 的 integration 测试必须收口子进程

启动 helper 超时后只 reject 不 kill，晚到 banner 的 runtime 会变成 ppid=1 的长寿孤儿（单个约 350 MB）。共享收口在 `test/integration/runtime-integration-test-spawned-child-process-lifecycle.ts`：

- spawn 出的每个子进程都登记到本文件的 `createSpawnedChildProcessRegistrySigkilledAfterEachTest()`，并在 `afterEach` 里 SIGKILL 仍在运行的子进程、等到退出；它先于 fixture 的 `onTestFinished` cleanup 执行，顺序天然是「先杀进程、再删隔离 HOME」。
- 等启动 banner 用 `waitForRuntimeServerStartupBannerOrSigkillChild`（失败分支先 SIGKILL 并等退出再 reject）；判退出用 `hasChildProcessExited`（被信号结束的进程 `exitCode` 为 null）。启动等待放宽后，用例超时用 `computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts` 按冷启动次数计算，并挂在 `describe(name, { timeout }, fn)` 上——给 `it(title, fn, <标识符>)` 传非数字字面量会让 biome 放弃 test-call 排版、重缩进整个用例体。
- `test/integration/shutdown-ipc-hook.cjs` 把 IPC 断开（vitest worker 被杀）当作父进程死亡：已装 SIGINT 处理器则发一次 SIGINT 走优雅关停并设兜底退出，仍在启动则立即退出。

## 手机后台 Codex 首发的真实浏览器检查

手机后台 Codex 首发的真实浏览器检查按需启用，会调用真实模型。它通过隔离 Git fixture、HOME 和 Codex 配置覆盖
All Projects 的同项目／跨项目创建，以及单项目对照；不打开任务详情，以原生转录验收完整正文、唯一首发及 Plan Mode。
先设置下列环境变量，再运行 guarded 用例（证据目录须为持久路径；凭据文件只读，测试不打印其内容）：

```sh
export PLAYWRIGHT_BROWSERS_PATH=/absolute/path/to/playwright-browser-cache
export KANBAN_RUN_MOBILE_CODEX_BACKGROUND_STARTUP_BROWSER_CHECK=1
export KANBAN_MOBILE_CODEX_STARTUP_EVIDENCE_OUTPUT_DIRECTORY=/absolute/persistent/codex-startup-evidence
export KANBAN_MOBILE_CODEX_STARTUP_AUTHENTICATION_FILE_PATH=/absolute/path/to/codex/auth.json
export KANBAN_MOBILE_CODEX_STARTUP_BINARY_PATH=/absolute/path/to/codex
export KANBAN_MOBILE_CODEX_STARTUP_MODEL_ID=<当前账号可用模型>
npm run test:guarded -- --project runtime-integration test/integration/codex-mobile-background-startup-real-browser.integration.test.ts
```

运行期间不要编辑调用仓库的文件，否则 mutation canary 会把 agent 同时编辑产生的状态变化判为测试污染。
额外设置 `KANBAN_MOBILE_CODEX_STARTUP_USE_PACKAGED_RUNTIME=1` 可验证当前工作区的打包产物；须先在独立的
`dist` 与 `web-ui/dist` 目录完成构建，不能通过指向在线实例的软链接覆盖其构建目录。

## 负载敏感的墙钟 / 资源断言

本机高负载（load 15–33 / 10 核）下，根 `npm run check` 曾因计时与内存阈值断言时绿时红，而产品语义并没有被违反（task df9d8 的分析与两路复核见交接目录 `task-df9d8-load-sensitive-timing-test-two-tier-deadline-plan-independent-validity-reviews-2026-10-04/`）。新增或修改这类断言时按下面的类别处理。

| 类别 | 例子 | 处理 |
| --- | --- | --- |
| A 产品契约 | CLI 硬超时以 124 退出 | 契约特征（exit code、文案）严格断言；计时精度用假时钟单测钉住（`cli-hard-timeout-fires-exit-code-124-with-fake-timers.test.ts`），集成测试里以事件为锚点度量（挂起服务器收到首个请求 → 退出），不从 spawn 起算 |
| B 测试侧等待 | 等 CLI 退出、等浏览器打开桩、等 PTY 输出 | 两档：超过软档只告警，超过硬档才失败。纯「终会发生」的等待（WS 连接、Worker 冷启动、`vi.waitFor`）直接放宽成单档 |
| C 性能绊线 | 洪水输出下的回显延迟、十万条档案首页查询 | 两档，并按 D1-b：GitHub Actions 上超过软档即失败（与改动前一致），本地超过软档只告警 |
| D 资源阈值 | 等待挂起 runtime 时 CLI 的 RSS | 以事件为锚点按阶段采样、设最低有效样本数；数值两档 |
| E 反向断言 | 等 N ms 后断言「没发生」 | 不放宽。负载下只会漏报、不会误报；改动既有正向又有反向观察的用例时保留观察屏障 |
| F 就绪竞态 | 第一次采样时子进程还没 fork 出来 | 改成显式等待就绪条件 |
| 行为契约写成了计时 | 「不空等沉降窗」「send 不等整轮完成」 | 改成确定性断言（假时钟、结构断言、顺序断言），不进两档 |

**共享设施**：`test/utilities/load-sensitive-wall-clock-two-tier-deadline.ts`（`waitForConditionWithinLoadSensitiveTwoTierDeadline` / `judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline`，`now` 与 CI 判定都可注入）；子进程退出用 `runtime-integration-test-spawned-child-process-lifecycle.ts` 的 `waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline`（超过硬档先 SIGKILL 并确认退出再抛错）。

**取值规则**（静态常量，不按负载缩放）：
- 软档保持原值，含义是「未过载机器上的正常上限」；硬档取 max(软档 × 4~6, 负载下实测最坏值 × 2)，并按真实计时锚点落在下一个产品兜底的正确一侧。例：命令型 CLI 从 spawn 起算硬档 45s，产品默认硬超时 35s 从 `run()` 起算；124 用例硬档 30s 低于它的 tRPC 60s，硬超时失效时不会被 tRPC 超时「救」成 exit 1。前提是测试 env 剔除了继承的 `KANBAN_CLI_*_TIMEOUT_MS`。
- CI 与本地用同一套常量，唯一例外是 C 类在 CI 上严格执行软档（`strictAtSoftDeadlineWhenRunningInContinuousIntegration`）。
- 硬档不按 loadavg 拉长。宿主 CPU 争用信号（loadavg、窗口内 `os.cpus()` busy 比例）**只写进 annotation 作诊断，绝不参与判定**：2026-10-05 实测进程内忙循环比值、窗口内 busy 比例、参考子进程定时器迟到都不可靠（同一负载下 busy 比例在 0.47–0.97 之间跳；macOS 定时器合并让参考进程恒迟到约 20ms），拿它们放过失败会制造新的假通过。
- **外层预算必须闭合**：内层等待放宽后，`testTimeout`（15s）与 hook 默认（10s）会先触发。每个用例的超时 = 准备 + 各次等待的硬档 + 清理 + SIGKILL 确认；多次 CLI spawn 按累计预算计（`computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts` 的 `cliChildProcessSpawns`：每次按软档 × 2，外加一个硬档），不按「次数 × 硬档」。超时挂在 `describe` 上，或用 `it(title, fn, <数字字面量>)`：`it(title, { timeout: <表达式> }, fn)` 在首行超过 120 列时同样会让 biome 重缩进整个用例体。

**D1-b 的理由**：本地高负载下，消费端被抢走 CPU 造成的积压与真实退化同一量级，没有可靠信号能区分二者；CI 机器负载可控，保留改动前的全部判别力。回显延迟当年的三个根因另有确定性用例守护（`session-manager-output-fanout.test.ts`、`terminal-output-normalization.test.ts`）。代价：同一份代码本地与 CI 判据不同。

**告警出口**：超过软档时 helper 先 `await context.annotate(..., "load-sensitive-soft-deadline-exceeded")` 再决定是否抛错（失败路径不等未完成的 annotation）。`vitest.config.ts` 显式写了 reporters（`agent`/`default` + CI 上的 `github-actions` + `test/vitest-reporter-load-sensitive-soft-deadline-exceeded-end-of-run-summary.ts`），运行末尾打印至多 20 行的汇总块，分「通过但超过软档」与「失败用例此前的软档告警」两段。命令行传 `--reporter` 会整体替换配置里的 reporters，汇总块随之消失。设置 `KANBAN_TEST_LOAD_SENSITIVE_WALL_CLOCK_MEASUREMENTS_JSONL_OUTPUT_PATH` 时，每次两档判定（含未超软档的）都追加一行 JSON，用于在负载下标定硬档。

**明文承认的代价**：
- CLI RSS 用例的绝对值硬档从 512MiB 放宽到 768MiB（待标定），「基线已高 + 中等增长」（例：450→650MiB）不再判失败；补偿是锚点后基线起算的增长判定（软 64MiB / 硬 256MiB）。
- B 类软档只告警后，命令型 CLI 启动变慢不再在本地失败；补偿是 `cli-entrypoint-static-import-closure-excludes-lazily-loaded-runtime-server-stack.test.ts`，确定性断言 `src/cli.ts` 的静态 import 闭包不含懒加载的 server 栈（25ba59f 类退化）。
- 通过路径变长（RSS 用例 tRPC 800ms→3000ms、两条空转用例补了 bootstrap 各多一次 runtime 冷启动）；真实回归让整批 CLI 都挂到硬档时，CI job 可能撞上 `test.yml` 的 job 上限（20 分钟，正常用时 8–10.5 分钟）被取消，而不是给出红色报告——本地 check 与 RVF 仍会明确失败。
- 残余 flake（要改产品才能修，未处理）：`canReachKanbanServer` 写死 `AbortSignal.timeout(1_500)`（`src/cli.ts`），「opens only for launch invocations」在负载下仍可能因此误判 server 不存在。

## 判读全量套件里「看似无关」的失败

断言一条失败「与本次改动无关」之前，先确认它不是被本次改动所在文件的副作用跨文件触发的（典型形态：某测试文件写 localStorage 后不清理，让另一个文件里毫无关系的用例失败——2026-07 实证）。注意：当时归因的机制解释（vitest setup 的 Map mock 跨文件沿用）在 2026-08 经对照实验未能复现——vitest 4.1.0 + Node 22 下 jsdom 环境每文件重建、Map mock 实际未安装；机制存疑，事件与教训仍成立。基线复跑能证明「改动前就失败」，但证明不了「与改动文件无因果关系」；两者表面同时成立、实际存在因果的情形真实发生过。

## 命令

- `npm run test:policy`：只运行 Git 测试安全策略。
- `npm run test:guarded -- <vitest args>`：在 policy 与宿主仓 canary 下运行指定 Vitest 参数。
- `npm run test:precommit`：运行 `precommit-safe`。
- `npm run test:integration`：运行 `runtime-integration`。
- `npm test`：依次运行两个 projects。
- `npm run test:watch`：在相同保护下启动 watch；退出时执行最终 canary 复查。

pre-commit 保持 Biome → typecheck → tests 的顺序；测试子进程的 Git 环境清洗不会改变 hook 随后的 Git 环境。

### 跨项目卡片动作真实浏览器检查

`cross-project-task-switcher-server-card-actions-real-browser.integration.test.ts` 按需启用：真实 runtime、Vite、Chromium、PTY 与 worktree 都由隔离 fixture 管理；本地 Claude 桩不请求模型。覆盖阶段 3/4 的卡片动作与三种跨项目建卡入口，以及阶段 5 的本体卡、置顶分身、rail 副本截图。普通套件跳过此用例，不要求安装 Chromium。

先确保 `web-ui` 的 Playwright Chromium 已安装。将下面两个路径分别换成该浏览器缓存和持久证据目录；显式浏览器缓存路径可避免 guarded runner 覆写 HOME 后找不到浏览器：

```sh
PLAYWRIGHT_BROWSERS_PATH=/absolute/path/to/playwright-browser-cache \
KANBAN_RUN_ISOLATED_CROSS_PROJECT_CARD_ACTION_REAL_BROWSER_CHECK=1 \
KANBAN_ISOLATED_REAL_BROWSER_CHECK_EVIDENCE_OUTPUT_DIRECTORY=/absolute/persistent/browser-check-evidence \
npm run test:guarded -- --project runtime-integration test/integration/cross-project-task-switcher-server-card-actions-real-browser.integration.test.ts
```

证据目录包含结果 JSON、截图、fixture 请求与隔离进程日志。测试自行分配端口并拒绝 3484，只收口自己派生的进程；CLI、runtime 和 Vite 均登记到现有子进程清理设施，异常路径也会回收。
