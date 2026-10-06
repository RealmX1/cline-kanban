# Claude `/background` 之后任务打不开：调查、修复与遗留风险

任务：`e336e`（修复）；受影响任务：`99b7e`（跨仓库编排）。2026-10-07。Claude Code 2.1.291 / 2.1.292。

## 现象

打开 99b7e 时终端显示：

```
That session is running in the background (bdd73afb). Run `claude attach bdd73afb` to open it,
or `claude stop bdd73afb` first to resume it here. Add --fork-session to branch off a copy instead.
[kanban] session exited with code 1
```

## 因果链（证据：`~/.claude/daemon.log`、`~/.claude/daemon/roster.json`、两份 transcript、`sessions.json`）

1. 99b7e 的原始会话 `fd026429` 由 kanban PTY 启动。
2. 10-07 02:18:56，用户在 kanban 终端里执行了 Claude Code 新增的 `/background`（别名 `/bg`，"Send this session to the background and free the terminal"，`isEnabled` 恒真）。
   - daemon 日志：`bg spawned bdd73afb (slash)`。
   - `fd026429.jsonl` 末尾：`{"type":"continued-in","continuedInSessionId":"bdd73afb-…"}`。
   - roster 的 dispatch 记录：`launch: {mode: "resume", fork: true}`，`flagArgs` 原样带着 kanban 的 `--settings ~/.cline/kanban/hooks/claude/settings.json`。
3. 02:28，用户在同一个 kanban 终端里经 agent view 重新 attach（`claimed-spare bdd73afb (fleet)`），之后一直在后台会话里交互。
4. 后台会话的 hook 照常报给 99b7e，SessionStart 把 sidecar `agentNativeConversationSessionIdentity` 改成 `bdd73afb`。这一步本身是对的：`bdd73afb` 就是对话的延续。
5. 再打开任务时，kanban 按 id 续跑 `claude --resume bdd73afb-…`。Claude 拒绝续跑被守护进程占着的会话，立即 exit 1。

Claude 侧的同类文案还有两种：按旧 id 续跑时是 "moved to a background session"，`--continue` 时是 "Your most recent conversation is running in the background"。

`CLAUDE_CODE_DISABLE_BG_EXIT_HANDOFF` 管的 exit handoff 不是触发源：它只把后台 shell / agent 交给同一会话的下一次唤醒，不会搬走对话本身。

## 外部契约（隔离 HOME + 真实 Claude 2.1.292 实测）

| 动作 | 结果 |
| --- | --- |
| `claude agents --json [--cwd <path>]` | 0.14s；字段 `id`（短 id）/ `sessionId` / `cwd` / `kind`（`background` / `interactive`）/ `pid` / `status`（`idle` / `busy`）/ `state`。守护进程没跑时只返回 `[]`，**不会**把它拉起来 |
| `claude --resume <id>`（交互与 `-p` 两种模式） | 目标被后台会话占着时，打印上面的拒绝文案并退出 |
| `claude stop <短 id>` | 0.68s，同步完成：返回时会话已从存活列表消失（`--all` 里显示 `pid: null`） |
| stop 之后 `claude --resume <id>` | 成功，上下文连续（探针会话答出了上一轮的内容） |

## 忙 / 闲是怎么判的（Claude 2.1.292 二进制，`uwe` / `Uuo`）

`claude agents --json` 里的 `status` 由会话进程自报：

| status | 条件 |
| --- | --- |
| `waiting` | 有 elicitation、对话框、worker / sandbox 请求，或本地命令面板开着 |
| `busy` | `isLoading`（请求在途或工具在跑）或 `delegatedActive` |
| `idle` | 以上都不是 |

`state`（`working` / `blocked` / `done` …）是 agent view 的任务标签，不是活动态。

**盲区：外部编辑器（Ctrl+G）和输入框里没提交的草稿都不算进去。** 99b7e 现场正是 `idle`，但屏幕停在 "Save and close editor to continue..."：会话 04:39 起开着 `code --wait`，在编辑一份未提交的 prompt 草稿（放在 `/tmp/claude-503/claude-prompt-<uuid>.md`，重启即清空）。只看 `idle` 就 stop，会让草稿和会话脱钩。

## 修复（e336e）

续跑前预检：`src/terminal/claude-code-background-session-ownership-preflight-before-resume.ts`，接在 session manager 的启动漏斗与 refresh 里，和 Cursor 预检站在同一道「销毁动作之前」的闸门位置。

- 只在「按已记录的原生 id 续跑」时生效。能力由 catalog 字段 `nativeConversationHarnessBackgroundSessionDaemonOwnershipInspectionMethod` 声明，不写死 agentId。
- 先沿转录的 `continued-in` 链走到对话最新所在的 id。有更新就改钉身份并落盘，`identityEstablishmentMethod = followed_claude_code_transcript_continued_in_record_to_conversation_continuation`。只沿同一项目目录里存在的转录走。
- **能安全收回**：`claude stop` 后放行，kanban 重新持有进程。判据是 `idle`，且输入框可见且为空。输入框这样读：
  - 把 `claude logs <id>` 回放进 400×120 的无头镜像，用仓库既有的 Claude 读框语法读；
  - 实测 120×40 会折行读不出，200×50 与 400×120 都读得出；
  - 读不出一律按不安全处理。
- **不能安全收回**：不 spawn、不 stop，在终端里写明原因，并写入 summary sidecar `agentNativeConversationHeldByHarnessBackgroundSessionObservation`（被谁占着、为什么、是否在盯）。之后两条路（用户选定）：
  - 盯梢（`src/terminal/harness-background-session-reclaim-watch-after-unsafe-resume-refusal.ts`）：每 5s 只观察一次，能安全收回时以 `harness_background_session_reclaim_watch_auto_resume` 发起续跑。
    - 实际的 stop 仍由启动漏斗里的预检执行，判据只有一份。
    - 时限 2h。人工 start / stop / refresh 与 manager 关停都会取消盯梢，取消时把面板的「正在盯」同步复位。
    - 盯梢交给启动闸门的那次续跑，拿到闸门后会复查盯梢是否已被取消（取消代际），排队期间人工停止就放弃，不 stop、不 spawn。
    - 若这张卡上 kanban 自己的会话还活着且在回合中，盯梢发起的续跑会被折叠：此时结束盯梢、面板改为「已停止自动等待」，交还给人（接管按钮照常可用），不去自动拆一条活会话。
    - 运行时重启后不恢复，hydrate 把「正在盯」复位；下次续跑被拒时重新武装。
  - 一键接管：终端面板提示条上的「停止后台会话并在这里续跑」，确认后经 refresh 的 `forceStopHarnessBackgroundSessionHoldingResumeTargetConfirmedByUser` 无条件 stop 后续跑。确认框写明会丢掉在途回合、对话框和未提交输入。
- 只认 `kind=background` 的占用者；交互终端（包括 kanban 自己的 PTY）一律不碰。
- 列举失败时放行，最坏情形与修复前相同。
- 没有身份记录、走 `--continue` 的旧会话不预检。

选「收回」而不是「在 kanban 终端里 attach」，理由是热重启：

- 热重启的保障都以「agent 是 kanban PTY host 的子进程」为前提，包括部署存活、接管、hook spool、孤儿回收、版本错位追踪。
- 留在 Claude 守护进程里，这些保障一样都不成立，而且 hook env 还可能指错任务（见下节）。

## 遗留风险（已实测坐实，未修）：守护进程 env 串任务

Claude 守护进程及其预热 spare 的 env 来自**第一个拉起它的进程**，不是发起 `/bg` 的那个进程。

- 隔离 HOME 探针：守护进程由 `KANBAN_HOOK_TASK_ID=…-B` 的进程拉起。之后从 `…-D` 的环境发起 `claude --bg`，后台会话里 `printenv` 得到的是 `…-B`。
- 本机现场：守护进程由 99b7e 的 kanban PTY 里那个 claude 拉起，连尚未认领的 spare 进程都带着 `KANBAN_TASK_ID=99b7e`。

后果：

- 守护进程存活期间，**另一个** kanban 任务里执行 `/bg`，后台会话会带着 kanban 的共享 hooks `--settings`（dispatch 原样转发），却用着 99b7e 的 `KANBAN_HOOK_TASK_ID`。它的 hook 会报到 99b7e：改写 99b7e 的原生会话身份、推动 99b7e 的卡片状态。
- 用户在自己终端里 `claude --bg` 起的会话也会继承 `KANBAN_TASK_ID` / `KANBAN_RUNTIME_PORT`，里面调用 `kanban task …` 会被归到 99b7e。
- 热重启 P3 把 `KANBAN_AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY` 注入 agent env 后，同一机制会让 runtime 不在时的 hook 被 spool 进错误的 hosted 会话。

可选根治方向（待用户决定）：

- 在 hooks ingest 按 payload `cwd` 校验任务归属；
- 或对 kanban 起的 Claude 设置 `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` / `disableAgentView`，代价是 kanban 终端里不能再 `/bg`（是否连带禁掉 `/bg`，需实测）。

本修复的「收回」会让被收回的那段对话脱离错误的 env，但不能阻止下一次 `/bg` 再次串任务。
