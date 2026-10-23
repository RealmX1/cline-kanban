# 按资源余量发送 RVF prompt

脚本每 10 秒采样整机 CPU 与 macOS memory pressure，每 5 分钟检查一次是否发送。最近完整五分钟 CPU 使用率的时间加权均值须不超过 80%，内存 pressure 采样须全部为 normal，同时 All Projects Running 数量须小于 8。CPU 尖峰允许存在；load average 只写诊断日志。采样失败、缺口、过期或运行时查询失败均跳过本次机会。

采样使用独立的单飞定时器，查询会话、观察转录与 RVF 产物、刷盘等待均不阻塞它。实际发送前会重验当前完整采样窗口并重新查询 Running；准备与重验总计超过 15 秒、Running 查询过慢或资源恶化时跳过本次机会。明确尚未调用发送 API 的跳过会恢复为未发送，继续等下一个五分钟机会，不增加高频补发。两次实际发送之间也至少相隔五分钟。

发送 RPC 携带本轮资源证据剩余有效期的取消信号，内部等待 runtime 恢复时也不能越过原截止后再发。调用 RPC 后超时保留发送意图与 `outcome_unknown`，重启不自动重投；只有确定尚未调用发送 API 的过期机会才恢复为未发送。

脚本按给定顺序每次最多发送一个目标，每个目标仅尝试一次。它使用用户明确选择的 `runtime.sendTaskChatMessage` 用户发送通道，正文严格为 `$review-validate-fix`，绑定发送前解析的主会话。请求不带后台 `source` 或强制 `mode`；调用者身份仍由 CLI actor claims 记录，授权来源保存在脚本的持久日志中。它不会把 Agent 已持有的回合打断，也不会启动已退出的会话。

## 首轮与续跑

在本任务工作区执行：

```sh
node --import tsx scripts/dispatch-review-validate-fix-prompts-when-host-resources-allow.ts \
  --mode pilot \
  --task-worktree-path /Users/bominzhang/.cline/worktrees/df81c/cline-kanban \
  --task-worktree-path /Users/bominzhang/.cline/worktrees/677cc/cline-kanban \
  --task-worktree-path /Users/bominzhang/.cline/worktrees/58b66/cline-kanban \
  --task-worktree-path /Users/bominzhang/.cline/worktrees/ea403/ai-analysis \
  --task-worktree-path /Users/bominzhang/.cline/worktrees/dbfe4/cline-kanban
```

`pilot` 只试首个目标，观察到关联 reviewer 的真实输出后停止。确认首轮报告后，以相同目标顺序、相同状态目录改用 `--mode remaining`，依次处理剩余任务。首轮没有成功时拒绝续跑。可通过 `--cpu-average-limit-percent` 配置均值上限；持久状态建立后拒绝静默更改目标顺序或上限。

状态为 `reviewers_started` 的条目使用已保存的身份，目录清理后仍可重启已完成的 pilot 或继续 remaining。恢复时仍须传入完整原顺序与 CPU 上限，已清理条目的路径使用持久记录中的规范路径；未完成条目继续验证目录、Git 归属和项目注册，缺失时拒绝续跑，不跳过或重投。

默认持久目录为 `~/.cline/kanban/cross-task-handoff-artifacts/task-66679-rvf-resource-gated-dispatch/`，也可用 `--state-directory` 指定。目录包含发送状态 JSON、资源与事件 JSONL、触发报告 Markdown。没有满足门槛时持续等待；可发 SIGINT/SIGTERM 停止，重新运行后重建完整资源窗口。该脚本不会自行安装系统启动项。

## 如何判定触发

运行时受理、原生 user message、结构化 skill 引用、原生 skill 内容展开、RVF hook token、绑定 run 和 reviewer 输出分别记录。Codex TUI 可能把原样发送的 `$review-validate-fix` 规范成带命名空间的 `$review-validate-fix:review-validate-fix`，脚本认可这个等价调用并保存实际原生文本。只读取发送后、匹配目标 worktree 与原生会话的证据。派发协调进程的 PID 或运行时的 pending 回执不证明 reviewer 启动。`reviewers_started` 表示至少一个关联 reviewer 已产生输出，不代表双评审通过、提交、部署或 Done。

token 的 `worktree` 与绑定 run 的 `summary.repo` 均按文件系统的设备号与 inode 核验目录身份，符号链接别名与真实路径可以匹配。原生会话与发送时间仍须匹配；其他真实目录、普通文件以及无法核验的路径均不能产生成功证据，观察超时后保留未知结果。

原生转录增量读取只按 LF 分帧；U+2028/U+2029 不作为记录分界。同一原生会话 ID 和进程代次下，续接可能更换物理转录文件；脚本只跟随运行时明确记录的新路径，从头读取并按发送时刻排除旧消息。目标主会话或原生进程代次变化、转录截断和无法可靠读取的证据保留未知结果。发送后最多观察 20 分钟；明确的 token 谢绝或最终 RVF 阻断消息会提前生成报告。

单实例锁防止同一状态目录并发运行。请求前原子保存并刷盘发送意图；请求响应丢失时不重投，重启后的已保存意图只继续观察。`blocked` 或 `outcome_unknown` 要先核对原生消息与报告，不应删除状态目录或换目录重跑来绕过防重发。

独占锁失效时，旧实例停止发送和提交共享状态、报告、事件日志，退出清理也不覆盖接管实例的记录。异步暂存写入完成后会重新检查持锁状态，检查与原子重命名之间不插入异步等待；事件日志采用同样无异步间隔的检查与短记录追加。失锁后仅清理本实例独占的 UUID 暂存文件；已保存的发送意图保留，由接管实例继续观察，发送响应尚未返回也不重投。
