# Cursor Agent 接入指南（终端 harness）

Cursor 的终端 agent：`agentId === "cursor"`，二进制 `cursor-agent`（`~/.local/bin/cursor-agent` → `~/.local/share/cursor-agent/versions/<版本>/`）。本文记录 task 203f3（2026-10-02）查明的**非显然事实**与据此做出的接入设计。这些事实来自 bundle 静态分析与隔离实测，读 Kanban 代码推不出来。

实测证据（脚本、原始 PTY 输出、summary JSON）在持久目录 `~/.cline/validation-evidence/203f3-cursor-agent-chat-identity-isolated-experiments/`，入口是其中的 `README.md`。被测版本 `2026.10.01-14929f9`；版本升级后应先重跑这些脚本，结论不能外推到任意未来版本。

## 1. chat store 布局

```
<chats 根>/<md5(物理 cwd)>/<chatId>/{store.db, store.db-wal, store.db-shm, meta.json}
```

- **chats 根**：`$CURSOR_CONFIG_DIR/chats` ‖ `$XDG_CONFIG_HOME/cursor/chats` ‖ `~/.cursor/chats`。`test:guarded` 会把 `XDG_CONFIG_HOME` 指到隔离目录，测试 fixture 要显式钉 `CURSOR_CONFIG_DIR`。
- **桶 key**：cursor-agent 进程里 `path.resolve(process.cwd())` 的 md5。Kanban 用 `--workspace <cwd>` 启动，cursor 会先 chdir，所以 `process.cwd()` 拿到的是**物理路径**。例如 macOS 上 `/tmp/x` 实际落在 `/private/tmp/x` 的桶。
- **`meta.json`**：`{schemaVersion, createdAtMs, hasConversation, title?, updatedAtMs?, isSubagent?, cwd?}`。
  - `hasConversation` 在**首个检查点**才翻成 true，不是在 prompt 提交时。实测中，agent 先跑 `sleep 30`，34s 后才翻。
  - prompt 提交后约 1s 就会出现 `store.db`；meta 约在 4s 出现，此时仍是 `hasConversation=false`。
- **`--continue` 的「最近一段」**：只算有 `store.db`、非 subagent、已建立的 chat，按 `updatedAtMs` 选。桶为空时输出 `No previous chats found.`，然后 exit 1。
- **在首个检查点之前被 SIGTERM**：cursor 会删掉这个空 chat 目录。
- **读写约束**：Kanban 只读 `meta.json` 并 `stat`，**绝不打开 sqlite**。打开就可能写 `-wal`/`-shm`，等于改了别人的会话。实现在 `src/terminal/cursor-agent-chat-store-location-and-conversation-inspection.ts`。

## 2. 会话选择参数

- **`--resume <id>` 找不到时不报错**：无论 id 不存在还是在别的桶，它都会静默开一段同 id 的**空对话**，看起来就像恢复成功。id 必须是 UUID。
- **`--resume <新 UUID> <prompt>` 可以用来开局**：cursor 以该 id 建 chat，positional prompt 照常自动提交。可与 `--plan` / `--force` / `--trust` / `--model` / `--workspace` 同用。
- **`--continue` 会静默覆盖 `--resume`**：bundle 里是 `continue → resume:"-1"`。实测两者同时出现时，被推进的是既有 chat，新 id 根本没有建出来。
- **`--plan` 在续跑时会把 chat 的 mode 覆写回 plan**：续跑不能重放 plan 起步。
- **`create-chat` 不适合 kanban 调用**：它只是 `randomUUID()` 加打印，不落盘，但**打印后进程永不自行退出**，关掉 stdin 也一样。所以 kanban 在进程内用 `randomUUID()`，代码处留有 `EXPERIMENT_NODE`。

## 3. Workspace Trust

- **弹出条件**：交互模式下，`<CURSOR_DATA_DIR‖~/.cursor>/projects/<slug>/.workspace-trusted` 不存在就会弹 "Workspace Trust Required / Do you trust the contents of this directory?"。prompt **要等应答之后才提交**。
- **跳过方式**：只有 `--trust` 能跳过，`--force` 不行。用 `--trust` 时，标记里会写 `trustMethod: "cli-flag"`。祖先目录的信任会被继承。
- **与 Codex 同句**：Codex 的信任对话框是同一句问话，所以 `hasCursorWorkspaceTrustPrompt`（`src/terminal/cursor-workspace-trust.ts`）只用于 Cursor 会话的状态标注。实录 fixture 在 `test/runtime/terminal/fixtures/`。
- **8ef28 / aa23d / 49a31 的成因**：它们的 cwd 都**没有**信任标记。首轮停在信任对话框上，从未落盘；之后每次续跑都撞上 `No previous chats found.`，连撞 5 次熔断。熔断文案让人手动刷新，可刷新走的还是同一条 `--continue`。
- **与 Claude 一致的处理**：Kanban 对 **task worktree** 一律传 `--trust`（范围同 Claude 的自动信任，见 `kanban-task-worktree-working-directory-path.ts`）。其余 cwd 不替用户做主，交给对话框，并由看门狗当场标出（见 §5）。

## 4. hooks：为什么不用

- **载荷没问题**：Cursor hook 的载荷带 `session_id`（就是 conversation_id），提取不是障碍。
- **安装位置是障碍**：只能写全局 `~/.cursor/hooks.json` 或工作区内的 `.cursor/hooks.json`。前者与 Orca 共用，会影响所有非 kanban 会话，也没有 env 能改指向；后者会弄脏 git 工作区。路径写死为 `homedir()/.cursor/hooks.json`，不受 `CURSOR_CONFIG_DIR` 影响。
- **续跑时 `sessionStart` 不触发**：按 hook 路线，续跑后的身份要等到下一个事件才追得上。
- **旁支**：Cursor 也会加载并执行 `~/.claude/settings.json` 里的 Claude Code hooks。

## 5. Kanban 的接入设计

| 场景 | 行为 | 代码 |
| --- | --- | --- |
| 全新开局 | spawn 前用 `randomUUID()` 分配 id，写 summary，并经 `persistAgentNativeConversationSessionIdentityImmediately` 落盘；再以 `--resume <id> [--trust] [--plan] <prompt>` 启动。身份的 `identityEstablishmentMethod = kanban_assigned_before_agent_launch`。每次全新开局（含崩溃后重发原 prompt 的 auto-restart）都换新 id | `session-manager.ts` `establishKanbanAssignedAgentNativeConversationSessionIdentityBeforeLaunch`；adapter `cursorAdapter` |
| 续跑（refresh / 垃圾桶恢复 / durable 重建 / auto-restart） | 先做预检，只读 chat store：<br>• 能按记录的 id 接上就按 id；<br>• 没记录 id 且桶里**恰好一段**已建立对话、又无同 cwd 竞争会话，就把它钉成身份再按 id；<br>• 桶里 ≥2 段时维持 `--continue`；<br>• 接不上任何东西就**拒绝且不 spawn**，不进熔断，状态标为「从未建立」 | `cursor-agent-chat-id-assignment-and-resume-preflight-before-launch.ts`、`cursor-agent-chat-launch-identity-orchestration.ts` |
| 用户 args 里的 `--continue` / `--resume` | 只要 kanban 按 id 寻址，就先把它们剥掉 | `removeCursorAgentChatSelectionArguments` |
| 首轮看门狗 | 挂在 15s 的卡顿扫描上：<br>• 45s 内分配的 chat 仍无 `store.db`，记为 `first_prompt_not_persisted_within_startup_window`；屏幕上能认出信任对话框时写明原因；<br>• 之后 store 出现就撤销告警，`hasConversation=true` 时记为已建立；<br>• PTY 退出时仍未建立，当场记为 `conversation_never_established_in_agent_native_store` | summary sidecar `agentNativeConversationPersistenceObservation` |
| 建卡播种 / 从既有对话迁入 | 把源 chat 的 sqlite 三件套**复制**进本会话的 cwd 桶，不复制 meta.json，由 cursor 按新 cwd 重建。<br>• 先暂存，再 rename；复制前后核对源文件未变，变了就拒绝；<br>• 已物化的就幂等跳过；<br>• 身份记为种子 id。<br>旧版用软链，新会话会写进源 store | `agent-session-materialization.ts`；迁入入口为 refresh 的 `adoptExistingAgentConversationAsTaskSessionIdentity` |
| 恢复后的续跑守卫 | Cursor 没有可靠的 UserPromptSubmit hook，所以在终端 Enter / 程序化提交这一边沿解除（同 Codex） | catalog `restorationContinuationGuardDisarmSignal` |
| 熔断文案 | 带上一代退出前最后一行输出，并如实说明「刷新用的是同样的参数」 | `task-session-auto-restart-policy.ts` |

**能力声明**：分支一律读 `src/core/agent-catalog.ts` 的 `nativeConversationSessionIdentityCaptureMethod`。Cursor 是 `kanban_assigned_before_agent_launch`，不新写 `agentId === "cursor"`。

## 6. 存量回填（政策窄例外）

运行时启动后、hydrate 之前，`backfillCursorAgentChatIdentityAndNeverEstablishedStateBeforeHydrate` 会处理存量 Cursor 会话。它是 fill-only 的，逐会话只读自己的桶，只处理本 workspace 看板上确有其卡的会话；sessions.json 里有跨看板的幽灵副本，不碰它们。

- **桶里恰好一段已建立对话，且无同 cwd cursor 会话**：钉成身份（`unique_established_chat_in_working_directory_bucket_backfill`）。
- **一段都没有**：标成「从未建立」，并把熔断留下的过期文案换成如实说明。
- **其余**：一概不动。

post-mortem 2026-09-24 的约束是「身份只认 agent 报告，绝不从路径反推；不做投机性历史迁移」。本回填是用户在 task 203f3 授权的窄例外，理由有二：只在唯一时钉；钉下的就是 `--continue` 今天会选中的那一段，行为等价。

8ef28 是否迁入 c2555 留下的同 prompt 对话，由用户在终端面板「从既有 Cursor 对话迁入…」里自己决定。Kanban 不替人挑，也不改 `~/.cursor/chats` 已有的数据：迁入是复制，源对话不动。

## 7. 复现与重跑

- **隔离方式**：只覆写 `CURSOR_CONFIG_DIR` / `CURSOR_DATA_DIR`。HOME 覆写会让 macOS keychain 认证失效（`Not logged in`）。
- **剥离 env**：剥掉 `KANBAN_*` / `CLINE_KANBAN_*` / `ORCA_*`，避免 hook 把事件报回宿主 task 或 Orca。用户级 hooks 路径不随 `CURSOR_CONFIG_DIR` 走。
- **cwd 位置**：放在 `/private/tmp/...` 下。
- **运行**：用 node-pty 驱动，脚本见证据目录的 `experiment-scripts/`。
- **隔离 kanban 实例跑真 cursor-agent**：kanban 的状态目录绑在 `homedir()` 上，必须覆写 HOME。此时要在隔离 HOME 里软链 `Library/Keychains` → `~/Library/Keychains`，cursor-agent 才能认证（只读用法，收尾先 `unlink` 再删目录）。端到端记录见证据目录 README 的「隔离 kanban 实例端到端」一节。
