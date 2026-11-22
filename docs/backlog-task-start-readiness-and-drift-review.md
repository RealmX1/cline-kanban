# Backlog 开启条件与漂移复核

Backlog 开启复核覆盖显式开启条件、创建基线之后的需求漂移，以及原目标和授权内的剩余工作。需要复核的卡片在通过前保留 Backlog。复核期间显示“启动前复核”。

无显式开启条件的任务在创建时申请启动，或在建卡后不足 24 小时启动，直接进入常规启动。运行时按原启动请求受理时的年龄判断，恢复等待时间不计入。直接启动无需读取漂移证据、访问辅助 AI 或生成复核报告。达到 24 小时才启动的普通 Backlog，以及声明了开启条件的任务，进入复核。

## 创建、编辑与查询

共享创建／编辑器中的 `backlogTaskStartReadinessConditionsText` 是可选自然语言字段，沿用现有草稿、批量创建和跨项目编辑流程。条件文本是判断材料，不是执行命令或追加权限。

服务端建卡时保存 `backlogTaskCreationRepositoryBaseline`，包含仓库归属、所选本地 `baseRef`、解析出的 commit 与采集时间。它用于比较历史，不钉住未来工作树的启动版本。普通更新不会给旧任务伪造创建基线；迁移保留原基线，并明确标注与当前仓库不一致的历史覆盖范围。

CLI 入口：

```sh
kanban task create --title '实现功能' --prompt '原始需求' \
  --backlog-task-start-readiness-conditions-text '依赖接口已落地' \
  --project-path /path/to/repository
kanban task update --task-id <id> \
  --backlog-task-start-readiness-conditions-text '更新后的开启条件' \
  --project-path /path/to/repository
kanban task assess-backlog-start-readiness --task-id <id> --project-path /path/to/repository
kanban task get-backlog-start-readiness-report --task-id <id> --project-path /path/to/repository
kanban task start --task-id <id> --project-path /path/to/repository
```

`assess-backlog-start-readiness` 只评估，不新增启动意图。`start` 在复核未通过时返回 `started: false` 与已受理的启动状态，不把受理写成成功。条件未满足时，卡片报告提供带原因的显式覆盖；CLI 的覆盖参数须同时指定当前 operation ID 与原因，不能覆盖 Stop、权限或身份门禁。

## 证据与结论

复核比较任务年龄、创建后的提交、文件范围、当前工作区与相关任务摘要。任务所在列不证明代码已经合入；需要时定向检查相关任务的提交、工作树及与当前 base 的关系。批量中的相同仓库比较材料可复用，仅深入读取相关任务。

历史缺失、commit 不可读、分叉或切换 `baseRef` 都保留未知覆盖，不解释成“没有漂移”。大量无关文件导致采集覆盖不完整时仍可通过当前代码和定向证据判断，不能把采集上限变成不可恢复的启动禁令。

独立复核可用完整无漂移证据作出结论。需要进一步判断时复用辅助 AI 主备路由，最多三轮受限只读补证，每轮最多六项。仅允许固定的文件读取、字面文本搜索和任务查询。主备失败或证据不足返回机器等待。只有用户声明了开启条件，复核才可判为条件未满足。

| 结论 | 后续行为 |
| --- | --- |
| `ready` | 通过复核后开启 |
| `revise_remaining_work` | 在原目标与授权内更新名称、简介和执行说明后开启 |
| `conditions_not_met` | 留在 Backlog，展示理由；允许针对当前证据显式覆盖 |
| `no_remaining_work` | 展示证据，清除原启动意图；不启动、不自动结案 |
| `human_decision_required` | 展示涉及目标、权限或人独有信息的具体决策 |
| `waiting_for_evidence` | 保留已受理意图和重验条件，等待机器补证 |

原始 Prompt 始终保留。修订记录包含 operation ID、评估时间和当前执行说明；首发同时提供原始需求与“启动前复核修订”来源。报告保存修订前内容及建议的修订内容，卡片仅保存简短投影。旧客户端整板写入不能覆盖服务端基线、报告投影或绕过 Backlog 启动门禁。

## 持久恢复与并发边界

操作按 workspace、task、incarnation 完整身份保存于运行时 HOME 下的 `backlog-task-start-readiness-operations/`。报告、补证次数、原请求及行动者、覆盖原因、失败历史和启动边界记录独立于高频会话状态。

恢复器每 15 秒检查已受理且未终止的启动意图，并发上限为二。同一依赖最多三次评估、三轮补证，重启不重置计数；任务、仓库、已引用的定向证据或模型配置／可用性发生变化后才获得新预算。它不会轮询所有 Backlog 并自行创建启动请求。

移列与 spawn 前均核对任务身份、当前启动输入、Stop、搁置及关闭状态。需要复核的启动另行重验仓库指纹和相关证据。尚未进入 spawn 的旧请求可按原受理时间进入直接启动，历史报告继续可查。Stop 保留为撤销，运行时正常关闭保留可恢复等待，真正启动失败仍显示为失败。跨项目恢复沿原 incarnation 核对迁移关系和原归属 Stop。

spawn 前先持久记录启动可能开始的边界。回执不明时读取原代次的摘要和投递记录。Codex 摘要缺少正文摘要时，可用持久启动记录中的正文摘要和时刻核对同代次原生转录。证据无法确认时保留等待，避免重复发送 Initial Prompt。

All Projects 和 Focus View 中显示启动进度的卡片可打开原任务的进度详情。打开详情只导航，启动仍由已受理的请求驱动。普通 Backlog 卡片继续原地打开编辑器。

## 部署前验收

根测试必须走 `test:guarded`，Web 测试走独立配置。相关回归覆盖字段三态与创建基线、无漂移、旧历史缺证／分叉／base 变化、无关大变更、条件覆盖、部分／全部完成、并发编辑、Stop、关闭恢复、补证预算和启动回执去重。

```sh
npm run typecheck
npm run web:typecheck
npm run test:guarded -- --project precommit-safe --project runtime-integration \
  test/runtime/core/backlog-task-start-readiness-fields.test.ts \
  test/runtime/core/backlog-task-start-readiness-protected-board-state.test.ts \
  test/runtime/backlog-task-start-readiness-assessment.test.ts \
  test/runtime/trpc/task-card-action-api.test.ts \
  test/runtime/commands/task-cli-write-verbs-delegate-to-task-card-action-procedures.test.ts \
  test/runtime/task-board-mutations.test.ts \
  test/runtime/core/task-session-start-request-from-board-card.test.ts \
  test/runtime/core/task-card-field-patch-resolution.test.ts \
  test/runtime/model-provider-access/task-assistance-model-provider-routing.test.ts \
  test/integration/backlog-task-start-readiness-through-runtime.integration.test.ts \
  test/integration/task-card-action-commands-through-runtime-procedure.integration.test.ts
npm run web:test -- src/hooks/use-task-editor.test.tsx \
  src/hooks/use-board-interactions.test.tsx src/hooks/task-edit-drafts.test.ts \
  src/state/task-card-action-command-execution.test.ts src/state/board-state.test.ts \
  src/components/task-editor-dialog.interaction.test.tsx \
  src/components/task-editor-dialog.dirty.test.ts \
  src/hooks/use-task-editor-session-lifecycle.test.tsx
```

打包验收先隔离 `dist` 与 `web-ui/dist`，显式设置 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY`。本任务使用 Node 22；任务私有的 `better-sqlite3` 已针对当前 ABI 构建，共享依赖及主仓库产物未变更。

浏览器用打包 runtime、Chromium、本机 HTTP 模型 fixture 与真实 PTY 中的替身 Agent，隔离 HOME、Codex 存储和关系账本。它检查共享创建／编辑条件、CLI 仅评估、条件未满足留 Backlog、编辑后跨 runtime 重启自动复核、原始需求与修订说明到达 Agent、重复开始无第二次首发，以及 Focus View／手机展示。

```sh
PLAYWRIGHT_BROWSERS_PATH=/Users/bominzhang/Library/Caches/ms-playwright \
KANBAN_BACKLOG_START_READINESS_PACKAGED_CLI_PATH="$PWD/dist/cli.js" \
KANBAN_TASK_EDITOR_CREATION_BROWSER_EVIDENCE_DIRECTORY=/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/e1690/backlog-readiness-browser-verification \
npm run test:guarded -- --project runtime-integration \
  test/integration/backlog-task-start-readiness-real-browser.integration.test.ts
```

持久证据目录：`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/e1690/`。浏览器截图、runtime 日志及 Agent 启动／输入记录位于 `backlog-readiness-browser-verification/`。

最终验收结果：

| 检查 | 结果 | 持久日志 |
| --- | --- | --- |
| 根 guarded 回归 | 11 个文件、163 项通过 | `final-core.log` |
| Web 回归 | 8 个文件、278 项通过 | `final-web.log` |
| 打包浏览器 | 1 项通过；手机展开后条件和报告可见，重启后首发一次 | `final-browser.log` |
| 根／Web 类型检查 | 均通过 | `final-root-typecheck.log`、`final-web-typecheck.log` |
| 隔离构建 | 通过，产物仅写入本任务目录 | `final-isolated-build.log` |
| 改动文件 Biome、`git diff --check` | 通过 | 无全仓库格式化 |

截图：`backlog-readiness-browser-verification/backlog-readiness-held-desktop.png` 与 `backlog-readiness-browser-verification/backlog-readiness-mobile.png`。这是一组针对本次改动的验证，不代表运行了全仓库测试。

浏览器 fixture 预置隔离项目归属。调查发现既有 `parseProjectAddRequest` 丢弃项目注册的 authorization／previewFingerprint；它与本次 Backlog 实施无关，未扩张修改。

## 真实实例待验与清理

已注册两项 PDV，均未勾选；未部署或在真实实例执行任务启动测试。浏览器替身模型／Agent 不代替真实服务商与真实 Agent 的自然使用验证。

| 行为 | 部署前已覆盖 | 真实实例待验 | 类型与 UUID |
| --- | --- | --- | --- |
| 当前绑定 CLI 的条件字段、覆盖参数及报告查询 | 类型、CLI 委托测试与打包浏览器 | 部署后 CLI 合同；旧任务无报告返回明确原因 | automated：`8dcde16f-2f71-42bc-a971-18d38b54bf6d` |
| 原始需求和有来源的剩余说明到达 Agent，重启不重复首发 | 隔离 runtime 重启、真 PTY 替身 Agent 输入日志与首发计数 | 自然开启的真实 Agent 及后续自然重启观察 | guided：`c8bf0ec5-58cb-4bfd-9010-394b9b79a341` |

脚本及附属资源位于 `/Users/bominzhang/.cline/kanban/verifications/<UUID>/`。自动项入口为 `verify-live-cli-backlog-readiness-contract.mjs`，仅查询 CLI 合同，不造真实任务或修改配置；人工项无脚本。两项 cleanup 策略均为 `automatic`，未添加仓库 instrumentation。

自动脚本已对尚未部署的实例 dry-run：约定返回非零，并明确指出“运行实例 CLI 尚不包含开启条件参数”；无超时、崩溃或残留。该结果证明部署前失败提示有效，不代表 PDV 通过。登记后已回读确认仅两项，预计面板挂载一项自动、一项引导验证。兜底清理：

```sh
kanban verification cleanup --verification-id 8dcde16f-2f71-42bc-a971-18d38b54bf6d
kanban verification cleanup --verification-id c8bf0ec5-58cb-4bfd-9010-394b9b79a341
```

本任务不提交、不推送、不吸收 base、不部署、不移动到 Done。未来真实验证通过后，由验证面板正常记录结果。
