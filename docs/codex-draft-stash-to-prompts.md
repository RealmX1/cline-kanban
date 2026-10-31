# Codex 草稿无损暂存到 Prompts

实现合同来源：任务 79d32 中用户批准的《修复 Codex Ctrl+S 无损暂存到 Prompts》计划。

- 能力：Ctrl+S／macOS Cmd+S 将原生编辑器导出的完整文字保存到当前 Task 的 Prompts，写入成功后清框。
- 范围：进程专属编辑器桥接、操作持久化、固定 Prompt ID、只读回执查询、同会话输入与自动投递互斥。
- 非目标：附件存储、已有 Prompts 迁移、自动重启存量会话；Prompt Injection 继续使用原生 `turn/start`。
- 验收：逐字保留空白与折叠粘贴；失败不清框；重复请求只入库一次；换代及新编辑不受旧操作影响；普通 Ctrl+G 与 Claude 暂存保持可用。
- 验证：guarded 单元与隔离原生 Codex／浏览器集成测试、根与 Web 类型检查、局部 lint、隔离构建；真实部署后断言注册到 PDV。

实现分为三个可验证切片：先拦住旧会话的无效 Ctrl+S；再接通持久编辑器导出与幂等写库；最后接入前端回执恢复和隔离端到端验证。

## 启动与输入归属

`prepareCodexDraftStashEditorBridge` 在新建及正常重启时保存原 `VISUAL`／`EDITOR` 以及解析后的 argv，只替换该 Codex 进程的环境。普通 Ctrl+G 从 `writeInput` 的同一输入漏斗登记人工来源；bracketed paste 和终端协议中的 BEL 不会被误认成快捷键。桥接不修改全局配置，也不自动重启旧会话。

存量会话的非 UUID 代际在读取桥接时视作能力未就绪，不能因暂存能力缺失而阻断原生投递和自动故障恢复。新建桥接仍要求 UUID；已有描述中的 workspace、conversation 与 incarnation 必须完整匹配当前身份。

Ctrl+S 创建本代独占预约，再经同一漏斗发送 Ctrl+G。已有人工预约、模态待答、提交确认或不完整附件都会阻止自动导出。无法证明归属时不清框。文字来自 Codex 导出的原生文件，正文不裁剪、不读屏拼装、不回填粘贴占位符。附件标记只用于拒绝不完整导出，绝不据此还原附件。

## 持久协议与恢复

桥接描述位于 `~/.cline/kanban/codex-draft-stash-editor-bridges/<runtimeSessionIncarnationId>/`，操作位于 `~/.cline/kanban/workspaces/<workspaceId>/codex-draft-stash-operations/<operationId>/`。目录权限 0700，操作与捕获文件权限 0600；文件同步后原子 rename，随后同步父目录。

| 证据 | 含义与后续资格 |
| --- | --- |
| `operation.json` | 固定 workspace、Task、conversation、incarnation、操作 ID、Prompt ID 和期限；已有记录只查询，不再次导出 |
| `captured-draft.json` | 原生导出的完整正文；可幂等补写同一个 Prompt ID |
| `prompt-saved.json` | 现有 Prompt Library 写入及读回已完成；重放不覆盖用户后来的编辑或移动 |
| `editor-decision.json` | 有效期限内且身份仍一致才允许返回空文件；失败与超时写拒绝决定 |
| `editor-finished.json` | 辅助程序的退出回执，不单独证明 Codex 已恢复输入 |
| `input-box-clear-confirmed.json` | 同代原生输出在清框授权之后到达，当前 composer 的占位文本和光标确证为空 |
| `input-box-restored-after-editor-failure.json` | 非零退出后，新的原生输出确认输入框已恢复；才允许回放期间抵达的按键 |
| `recovery-progress.json` | 补写失败的次数、下一次重验时间或等待条件；不覆盖原失败历史 |

捕获最多等 10 秒，写库最多另等 10 秒，清框/恢复确认另等 3 秒。编辑器失败时非零退出，Codex 因而保留原始组合和尾部空白；返回原文件并正常退出会触发 Codex 的 `trim_end`，不能用作失败路径。

写入超过等待预算后，迟到的完成只补保存证据，不追补清框。runtime 重建及失败操作收口时会自动核对捕获和固定 Prompt ID；无进展最多重试三次，随后等待 Prompt Library 的实际写入或下一次 runtime 启动重新核验。当前输入框与投递仍由本代身份约束，旧操作不能清下一代会话。

暂存期间只锁当前会话。已在传输途中的按键持久保存到 `terminal-input-retained.bin`，原生输入恢复后回放；回放开始前先固定 `terminal-input-replay-may-have-started.bin`，重启后不因缺失回执重复写入。回放资格未知时保留文件与可见提示。竞争性程序投递重排等待；已进入原生准备但尚未提交的消息等待暂存结束后继续，其他会话照常运行。

## API 与前端回执

现有 `runtime.stashTerminalInputBoxToPromptLibrary` 接受可选 UUID `operationId`。新增只读 `runtime.getTerminalInputBoxStashOperationStatus`，输入为 `{ taskId, operationId }`；查询不启动 agent、不导出、不写 Prompt。

前端先保存操作身份，再提交请求，显示进行中并锁住按键。请求超时或回执丢失后只查询同一个 ID；重连继续查询，既不重新触发导出，也不把“未确认清空”说成“已清空”。旧会话明确返回 `codex_draft_stash_capability_not_ready`，原稿与输入占用跟踪均保留。Claude 路径仍采用原有捕获和原生暂存语义。

失败回执中的 `capturedDraftPromptSaveRecoveryPending` 区分后续写入资格。已捕获正文、或编辑器已声明执行但捕获尚未确认时，继续查询原操作。捕获期限已过且编辑器未声明执行，或编辑器已结束且没有正文时，服务端明确返回 `false`，前端收口这次失败，允许下一次显式快捷键重新暂存。编辑器先独占声明执行再检查期限，查询则先固定期限是否已过，再读取声明与捕获，避免把可能迟到的捕获判成终态。旧版响应缺少此字段时继续保守补证。

前端使用 Web Locks 串行登记同一会话的操作，清理持久身份时核对操作 ID，避免并发败者删除另一标签页的胜者记录。持续未受理的操作在原请求期限后收口；写库超时但仍可能补写的操作继续复用固定 ID。自动故障续跑将暂存识别为软延期，暂存结束后继续，而不是取消恢复 episode。

## 自动化验收入口

- `npm run test:guarded -- --project precommit-safe test/runtime/terminal/codex-draft-stash-editor-bridge.test.ts test/runtime/terminal/session-manager-terminal-input-box-stash.test.ts test/runtime/terminal/session-manager-codex-native-prompt-delivery.test.ts`
- `KANBAN_CODEX_NATIVE_SESSION_TEST_BINARY=/absolute/path/to/codex npm run test:guarded -- --project runtime-integration test/integration/codex-native-prompt-delivery-preserves-composer.integration.test.ts`
- 隔离两处构建输出并构建后，指定 `PLAYWRIGHT_BROWSERS_PATH` 和 `KANBAN_RUN_CODEX_DRAFT_STASH_REAL_BROWSER_CHECK=1`，运行 `npm run test:guarded -- --project runtime-integration test/integration/codex-draft-stash-real-browser.integration.test.ts`。此用例使用产品打包服务、真实浏览器与 PTY，仅替换 Codex TUI；覆盖快捷键、Prompts、丢失回执以及服务两次启动后的只读核对。
- `npm run web:test -- --run src/terminal/terminal-input-box-stash-shortcut.test.ts`、根/Web 类型检查和改动文件的 Biome 检查。

原生回归使用 Codex 0.166.0 与隔离本地模型，逐字核对长折叠粘贴、多行、中英混排、emoji、前后空白和纯空白，并核对暂存期间没有新增 `UserPromptSubmit` 或模型回合。普通 Ctrl+G、Plan 模式、原生注入、提问和权限确认沿同一真实 TUI 回归。

2026-10-31 的首轮实现验证结果：9 个 guarded 文件共 452 项通过，Web 快捷键与回执测试 17 项通过；打包浏览器独立用例通过，包括 Ctrl+S／Cmd+S、HTTP 回执丢失以及同一隔离 HOME 中服务退出并重新启动后的回执与 Prompts 核对。根/Web 类型检查、改动文件 Biome 和隔离构建均通过。

guarded 与原生 Codex 检查使用 Node 22.22.3；打包与浏览器服务使用 Node 24.12.0，匹配本机已有 `better-sqlite3` 的 ABI 137。任务内为 thread graph 依赖恢复锁文件指定的 `5b20a8767ff79d92da33bfec136f4912f76d642a`，未改共享依赖。`dist` 与 `web-ui/dist` 均已脱离主仓库软链，构建显式指定本任务输出目录，没有更新在线实例。

## 独立评审与最终复验

固定基线为 `70e6f381999a9e520f6a216282a7b26ba7052c13`，显式范围为本任务完整净改动。RVF run 位于 `/Users/bominzhang/.rvf/user-local-data/task-snapshot-reviews/task-review-79d32-codex-draft-stash-20261031/`。三路 reviewer 均已完成，9 条发现均已修复，包括同一问题的重复证据；修复涵盖预约释放、持久操作收口、跨标签页身份清理、迟到写入补证、自动续跑软延期及两处重启回放边界。最终浏览器用例另修正初始化及焦点竞态。

RVF 在完整隔离树 `157bbf52437094840fbcd92cf40ab95d7c69eb57` 上通过七组验证，返回 `agent_review_ready`。主会话随后独立复现并补修“未捕获正文的确定失败仍永久占用浏览器操作身份”，补充上述恢复资格字段和过期编辑器回归；这项补修由主会话验证，不冒充原 RVF 快照覆盖。

补修后的最终复验重新执行原七组命令：9 个 guarded 文件共 **457 项**、Web **24 项**、打包浏览器重启用例 **1 项**全部通过，根/Web 类型检查、19 个改动文件的 Biome 和隔离构建通过。回归同时证明过期且未启动的操作可重新暂存、已声明但捕获未确认时继续补证、迟到编辑器非零退出且原稿不变。

主会话审阅与逐项实施证据位于 `/Users/bominzhang/.rvf/user-local-data/task-snapshot-review-inputs/cline-kanban-79d32-codex-draft-stash/primary-agent-review-report.json`，最终命令、退出码和日志位于同目录 `primary-final-verification/attempt-002/validation.json`。此前失败原件保留。上述评审交回时改动未暂存、未提交，也没有同步、推送、部署或移动 Done。RVF 的 `ready_to_commit` 是评审结果，不构成提交授权。

## 后续提交与本地 base 同步

用户随后明确要求 `commit and $base-branch-sync`。本次受控同步先保护任务 WIP，吸收固定本地 `main` 提交 `a31483b57e2d4ec879261ebefdd102dfd91aca98`，完整恢复原改动，完成单向边界核验并释放锁；没有文本冲突。base 新增配置详情查询、thread graph 取消修复及语音设置，与本任务暂存契约保持兼容。任务私有 thread graph 依赖随锁文件更新为 `233d3e765405fd27df0499c6cb4916ee3566d86b`，共享依赖未改。

本阶段在吸收和 WIP 恢复后重新验证当前整合树，再提交并按 Tier 1 交回本地 base。实际命令、提交与落地结果、WIP 核对及未执行事项保存在持久目录 `/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/79d32/commit-and-base-sync-20261031/`，以其中的 `synchronization-progress.json` 为准。任务开始同步时是 detached HEAD，不因此创建或推送新分支；部署后验证仍是待验定义。

整合后的浏览器复验捕获到首启引导异步抢焦点：Ctrl+S 的目标是引导 Close 按钮，没有发出暂存请求。测试改为加载前在隔离浏览器预置 `LocalStorageKey.OnboardingDialogShown`，并保留按键目标、页面状态与暂存 HTTP 回执诊断；原入库、逐字正文、清框、丢回执、重启和无用户提交断言不变，未延长超时。失败原件保留在上述交接目录。

完整提交检查另检出存量代际的恢复回归：固定 base 的自动续跑持久化测试 7 项通过，任务树的桥接读取却对 `old-process` 抛出 UUID 错误。已将无新桥接身份的读取收口为能力未就绪，补充新建严格身份及持久描述代际不匹配的回归；失败、基线对照和后续复验分别保留。

## 部署后验证登记

| 行为 | 部署前已证 | 真实部署后待验 | 类型 |
| --- | --- | --- | --- |
| 只读状态查询 | 打包服务、浏览器和服务重启后的查询 | 当前在线实例确实包含新 procedure，真实 Prompts 查询前后相同 | automated_script |
| 快捷键、清框与原编辑器 | 隔离 Codex 0.166.0、本地模型与 Chromium | 用户正在使用的浏览器和编辑器配置下，提示、正文与原编辑器仍正确 | guided_manual |
| 存量会话与热重启 | 旧会话保护、换代、捕获补写、丢回执、打包服务两次启动 | 真实历史 PTY 在升级/热重启后的归属与新输入保护 | guided_manual |

任务 `79d32` 已注册三项，`verification list` 自查为 `count: 3`（1 automated_script、2 guided_manual）。后续部署记录预计挂载同样三项；本任务没有执行部署或写入核对通过状态。

独立评审与最终补修后已按原 ID 核对这三项定义；新的失败收口判据已由部署前测试覆盖，没有新增只能在真实部署后验证的断言，因此保持原三项，不重复登记。

| verificationId | 资产目录 | cleanup.mode |
| --- | --- | --- |
| `e9069c48-109f-4de6-a189-c2861ac18c2c` | `~/.cline/kanban/verifications/e9069c48-109f-4de6-a189-c2861ac18c2c/` | automatic |
| `5d5a4ca5-5fca-42bb-bbda-098ff071ceae` | `~/.cline/kanban/verifications/5d5a4ca5-5fca-42bb-bbda-098ff071ceae/` | manual |
| `018a8b0f-6c40-4cb9-9de5-fc95b03fa8da` | `~/.cline/kanban/verifications/018a8b0f-6c40-4cb9-9de5-fc95b03fa8da/` | manual |

自动脚本在旧实例 dry-run 受控退出 1：新 procedure 返回 `NOT_FOUND`，符合尚未部署的事实。没有崩溃、超时、临时实体或用户数据写入。脚本与登记资产均在上述持久目录，不依赖任务工作树；没有源码插桩。

兜底清理命令：

```sh
kanban verification cleanup --verification-id e9069c48-109f-4de6-a189-c2861ac18c2c
kanban verification cleanup --verification-id 5d5a4ca5-5fca-42bb-bbda-098ff071ceae
kanban verification cleanup --verification-id 018a8b0f-6c40-4cb9-9de5-fc95b03fa8da
```

两项引导核对仅删除各自标记的临时 Prompt/草稿，保留真实用户内容；没有待移除的 instrumentation tag。
