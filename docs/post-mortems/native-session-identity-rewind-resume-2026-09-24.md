# Rewind 后恢复旧会话：调查、修复与验证

任务：`d1bec`；工作区：`/Users/bominzhang/.cline/worktrees/d1bec/cline-kanban`。截至 2026-09-24，RVF 修复已提交为 `58935ec3`；尚未部署。未重启共享实例，未改写 `8dc89` 或其它业务任务的历史绑定。

## 原因与历史证据

按原生 ID 恢复的改动为 `b6e56336`，提交时间 2026-09-10 01:57:14 +08；本地部署记录首次包含它的时间为 2026-09-13 18:05:06 +08，部署提交 `d5e0a481`。提交时间与上线时间不是同一件事。

Codex 0.156.1 的实测根因是启动配置被分到两个层次：根命令的 hooks 配置位于 `resume` / `fork` 之前，另一组 `-c developer_instructions=...` 位于子命令之后。当两侧同时有配置覆盖时，实际 hooks 配置丢失；把全部覆盖项放在根参数区后，resume 和 fork 均重新收到原生 hook。2026-05-09 的 `00598a36` 曾把 hooks 移到子命令前，但没有统一其它配置项，故没有消除这个组合问题。

`8dc89` 调查时磁盘绑定仍指向 `01a0c3df-a765-7292-b15c-23b0861e9c8f`，对应较早的 RVF 收尾；用户纠正后的分支为 `01a0cd40-3ed9-78a1-96c3-09aa257319e5`，创建于 2026-09-23 07:52:14Z。旧 ID 本身仍有效，精确恢复于是忠实地恢复到了错误的旧绑定。

不能据此推断「按 ID 恢复上线后的 Codex rewind 全部漏追踪」。历史抽样涉及 59 份历史、23 个 cwd 组；其中 6 个任务包含 38 次新分支：`8dc89` 存在六条未追踪的后续分支；`5262a` 有成功捕获子 ID 的反例；`22d87` / `74ac1` 无绑定而走 latest，掩盖了观察缺口；`03128` / `041d9` 的无绑定旧记录不足以证明其每次实际恢复结果。故问题是特定启动路径和身份观察链路缺失，不是所有 rewind 的统一后果。

## 各 harness 的语义与处理

| Harness / 本机版本 | 实测的身份语义 | 本次实现 |
| --- | --- | --- |
| Codex 0.156.1 | rewind/fork 可形成新 ID；resume 指定 ID 保持该身份 | 全部 `-c` / `--config` 统一在子命令前；增加 SessionStart；保留覆盖顺序、字面值和 `--` 边界 |
| Claude Code 2.1.281 | 实际 `/rewind → Restore conversation → 完成新回合` 保持 ID；`--fork-session` 创建新 ID | SessionStart 观察；继续使用原生按 ID 恢复；不因菜单出现 fork 字样就假定 ID 改变 |
| Kimi 0.38.0 | `:undo` 保持 ID；`:fork` 创建新 ID；`--session <ID>` 与 SessionStart 可用 | 支持 `session_<UUID>` 等不透明 ID；恢复用 `--session`；不重发原始 prompt / plan |
| OMP 18.0.9 | 文件内 branch 可保持 ID；createBranchedSession / UI branch / fork 可换 ID | PTY 托管扩展读取 SessionManager 当前 ID；监听 start/switch/branch；`--resume <ID>`；ACP 保存 new/load 返回 ID，优先按 ID load |
| DeepSeek Harness 0.1.0-rc.5 | 本机 core SessionStore fork 较早回合生成子 ID；restore 保持该 ID | 记录适配要求；本仓库没有其 catalog/adapter，本次不新增接入 |

Cursor 的既有按 ID 路径保留；本轮没有追加 Cursor 原生 CLI 实测。以上版本结论不能外推到任意未来版本。

## 实现边界

- 本任务自己的恢复身份与「建卡时从另一历史会话初始化」分开建模，避免把 Kimi/OMP 身份强塞进既有 UUID 播种 schema。身份来自 harness hook、托管扩展或 ACP 协议，不从路径或 cwd 最新文件猜测。
- 新事件 `agent_conversation_session_identity_observed` 只更新身份，不推进 facets、对话时钟、通知或恢复守卫。明确标记的子 agent 载荷不更新主任务身份。
- hook 在返回成功前，经 workspace 锁保存当前内存身份；通知去重不能跳过这一步。磁盘保存入口保留较新的身份，防止旧 UI 快照撤销绑定；内存也拒绝比当前身份观察时间更早的身份。观察时间不是跨机器的分布式时钟，本实现针对单机运行时。
- 身份保存失败如实返回失败，但保留 Claude 恢复拦截的 block 指令，避免错误被解释为允许自动继续。CLI 原有 best-effort 退出码不能单独证明服务端成功。
- 有已观察 ID 时，恢复失败不会回退 latest；没有 ID 的历史记录仍仅在不存在同 harness 共目录竞争者时使用原有 fallback。绑定恢复拒绝无法安全拼接的 `--` 参数分隔符。
- OMP 在 PTY→ACP→PTY 之间移交身份；ACP 会话启动响应前持久化协议身份。异步启动用 incarnation 守卫拒绝停止/重开后迟到的连接、事件和身份，不让旧连接替换新连接。
- 没有加入新数据库、外部依赖、后台全盘扫描或猜测式历史迁移。`8dc89` 的修复应在部署后重新核对当时的原生分支，用已有选择/恢复入口完成，不能把调查时 UUID 固化进代码。

## RVF 补充修复

两路独立审查（oh-my-pi、Cursor）共提出三项真实问题，均在隔离 attempt 先复现再修复，并已应用到任务工作区：

- 绑定恢复清理旧 argv 的位置 prompt 与会话选择器，按各 CLI 的参数值边界保留模型、权限和系统提示。Kimi `-p` 是 prompt，OMP `-p` 是布尔 print，不做统一猜测；未知且有歧义的裸选项明确拒绝恢复，需登记真实语法后使用。
- 同一身份的新确认也推进并持久化 `observedAt` 水位，拒绝 `A@10 → B@20 → B@40 → 迟到 A@30` 回退；保持业务状态、对话时钟、恢复守卫与 `summary.updatedAt` 不变。
- ACP 事件按来源连接归属任务；相同原生 ID 的并发加载、启动失败和旧连接关闭不会串任务或删除新连接映射。新增连接运行时回归测试，作为唯一 allowlist 范围扩展。

最终合并候选的验证记录、范围降级说明和逐项结果见 RVF run `rvf-20260924T111559Z-agentic-initiation-start-97ea82ba` 的 `artifacts/handoff.md`。以下 251 项为 RVF 前实现阶段证据，不冒充修复后的最终结果。部署后验证定义已 reconcile，仍保留原两项，尚未执行部署。

## 验证证据

统一证据目录：`/Users/bominzhang/.cache/kanban-multi-harness-session-audit-20260924/`；原始 Codex 配置故障复现目录：`/Users/bominzhang/.cache/kanban-session-hook-diagnosis-20260924/`。这些是本机诊断产物，不是提交依赖。

- 14 个测试文件、251 项定向测试通过，包含身份解析、参数规范化、hook、ACP 服务、双向通道移交和 workspace-state 集成。日志 `implementation-complete-regression.log`。
- 根项目与 web-ui 类型检查通过，最终生产构建通过（`implementation-complete-build.log`）。session-manager 迟到身份与 ACP 重复启动回归已包含在最终 251 项中。
- 测试经 `npm run test:guarded`，使用 Node 24.12.0。初次 Node 22 运行失败的通知测试源于共享 better-sqlite3 为 Node 24 ABI 构建；没有为了测试重建共享依赖。不能把该环境失败称为 Node 22 兼容性通过。
- `implemented-native-results.json`：用本次 adapter 生成的真实 Codex resume/fork 参数，均观察到 SessionStart、UserPromptSubmit，且分别是原 ID / 子 ID；真实 OMP CLI 加载本次生成的扩展，报告指定旧会话 ID，未误选较新的文件。
- `implemented-omp-acp-results.json`：真实 OMP ACP 连续两次按指定 ID 加载，直接 Node + tsx loader 的诊断进程退出 0。该夹具收到的是 available_commands/session_info 元数据，不能据此声称证明了完整历史消息重播；重播边界由单元测试覆盖。
- Claude / Kimi 使用隔离 HOME、会话存储与 mock 模型；OMP / DeepSeek 使用隔离原生存储。没有向真实模型发送诊断回合，没有修改业务历史。实测成功不等于真实部署链路已经修好。

## 基线与相邻任务

实施前 local main 与本任务均为 `24591cd67c0494232f675e1a79350633594eb5d4`。加锁 fetch 后 origin/main `a1b2d686...` 已包含于本地 main；单向吸收无需变更。随后释放 base 锁才运行本仓库测试。

Bootstrap receipt：`/Users/bominzhang/Documents/GitHub/cline-kanban/.git/worktrees/cline-kanban186/base-branch-sync/local-base-into-task-worktree-bootstrap-receipt.json`，SHA-256 `7236ce0fd751c13a9c6768b1e7d071f8d34e9169d8760e2bc22733c480b4c3ec`。

230 项 sibling 快照见 `implementation-sibling-survey.json`。`0b661` 的 hook 身份持久化/重试工作与本次 hooks/state 文件重叠；`9d24c` 的 cwd 隔离与 ACP legacy session/list 工作与 adapter/connection 文件重叠。依用户关于自主处理执行次序的指示，本任务在独立 worktree 完整实现，不修改或吸收 sibling WIP。日后进入 local base 前必须按届时接口复核这两处重叠，不能假定无冲突。

```text
LOCAL_BASE_DELTA_INSPECTED=VERIFIED
LOCAL_BASE_ABSORPTION=COMPLETED
SIBLING_TASK_SURVEY=VERIFIED
NO_SIBLING_WORKTREE_MUTATION=VERIFIED
NO_SIBLING_WORK_MERGED=VERIFIED
PLAN_REVISION=APPLIED
POST_ABSORPTION_PLAN_FRESHNESS=VERIFIED
ONE_WAY=VERIFIED
BASE_UNCHANGED_BY_TASK=VERIFIED
NO_HANDBACK=VERIFIED
NO_PUSH=VERIFIED
BOOTSTRAP_SEQUENCE=VERIFIED_SYNC_BEFORE_TARGET_REPOSITORY_VALIDATION
BOOTSTRAP_RECEIPT=VERIFIED
```

## 部署后验证登记

| 行为 | 部署前已证 | 部署后待验 | 类型 |
| --- | --- | --- | --- |
| 身份事件不推进会话 | 单元测试覆盖，真实 harness 能发 hook | 实际安装的 CLI 与共享运行实例均接受新协议，空身份事件无状态副作用 | automated_script |
| 原生分支跟踪、按 ID 重启 | 隔离原生 CLI/存储测试与 guarded integration | 部署后的真实任务生命周期、关闭浏览器仍落盘、共享运行时冷启动、OMP 双向切换 | guided_manual（维护窗口条件）；窗口内优先用 API/CLI 自动驱动 |
| 参数规范化、ID schema、旧快照保护 | 自动化回归已覆盖 | 无独立部署断言 | 不重复登记 |

已注册于 `d1bec`，`verification list` 自查为 `ok:true, count:2`；部署 record 后预计挂载 1 条自动、1 条引导验证，目前均未勾选通过。

| verificationId | kind / cleanup | label | assetsDir |
| --- | --- | --- | --- |
| `22bb6cf0-c15b-4e47-91db-d4af6bd95d00` | automated_script / automatic | 部署后 CLI 与运行时接受身份专用事件，空载荷不推进任务状态或对话时间 | `/Users/bominzhang/.cline/kanban/verifications/22bb6cf0-c15b-4e47-91db-d4af6bd95d00` |
| `83d1f8fd-97f3-4382-86e6-0c639122d5a0` | guided_manual / manual | 维护窗口内原生分支、OMP 通道切换与冷重启均保持最新绑定 | `/Users/bominzhang/.cline/kanban/verifications/83d1f8fd-97f3-4382-86e6-0c639122d5a0` |

自动脚本在旧实例 dry-run **受控失败（exit 1）**：旧 CLI 未向探针中继投递新事件；单独读取真实 HTTP 也确认旧 runtime 返回 400、不接受新枚举。脚本使用临时本地 HTTP 中继检查实际 ACK，不能只看 CLI exit 0；临时 HOME 全部位于 assetsDir 并在 finally 清除，无残留、无超时。它发的是本任务的空身份事件，不提供伪造 ID，不改历史绑定。`post-deploy-dry-run.log` 保留最终结果。另用本次构建的 CLI 与隔离 HTTP 夹具验证脚本成功路径，退出 0；这仅证明探针不会永远报失败，不代表旧运行实例通过。

自动化已覆盖隔离启动；共享运行时重启会中断其它活任务，需要部署维护窗口，所以该项登记为引导验证，未在本轮擅自执行。引导步骤仍要求优先自动驱动测试任务。没有 repo 临时插桩。

兜底清理：

```bash
kanban verification cleanup --verification-id 22bb6cf0-c15b-4e47-91db-d4af6bd95d00
kanban verification cleanup --verification-id 83d1f8fd-97f3-4382-86e6-0c639122d5a0
rg 'KANBAN-VERIFICATION-SCOPED:(22bb6cf0-c15b-4e47-91db-d4af6bd95d00|83d1f8fd-97f3-4382-86e6-0c639122d5a0)' src
```

仅清理本验证创建且带对应 `[vrf:...]` 标记的测试任务与隔离目录；最后一条预期无匹配，不要删除业务任务。

## RVF land 后的 local main 语义合并

本轮 handback 吸收 `f3963548`，其中 `0b661` 的 `ba5d1d03` 已实现身份可靠持久化，`9d24c` 的 `38398fdc` 已实现 Codex / ACP 最近会话目录隔离。六处文本冲突之外，合并还需要处理三个契约差异：

- 复用 main 的 `persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId`，删除本任务重复的保存入口。保留锁内重读、先增 revision 再写 sessions、失败可重试及状态广播；同身份的新 `observedAt` 必须落盘，相同时间的重复观察才幂等，较旧观察不得回退。
- Codex 的目录隔离配置与 hooks / developer instructions 一起归一到根命令层。初次目录实验中的混合布局不能变成永久的「必须放子命令后」约束。合并后真实 0.156.1 PTY 已验证 resume / 隐式 fork 选本目录，显式 ID fork 仍可跨目录。
- ACP 保留 main 的真实 cwd 核对、分页与重复游标拒绝，并让列表选中与显式 ID 两条路径共用按连接登记的 load；更新 main 测试对旧全局 sessionId 映射字段的引用。

原先的重复确认 revision 断言也已更新：新确认增加一次 revision，同一观察重试不增加。主任务、侧问恢复、写盘失败重试、恢复守卫及业务时间语义均继续由两侧回归共同约束。

RVF land 首次完整 pre-commit 暴露两个测试文件的三个 mock 缺少新增运行时查询方法；仅补齐 `listSummaries` / `getSummary`，随后 2361 项 pre-commit 测试通过。candidate evidence writer 因 handoff 缺少 canonical issue summary 拒绝写证据；未改写 handoff 或伪造 receipt，后续同步按 legacy 语义合并与验证路径执行。231 项 sibling 清单只读检查，其余未落地工作没有被吸收。
