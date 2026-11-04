# 待合入任务的备份、独立恢复与看板构建

当前主会话负责设施构建及后续 Overwatch。先完成现有交付验收、commit／base-branch-sync，再备份相关状态数据，然后由独立 Sync Orchestrator Task 开启真实看板首轮；本会话不执行 Single Station。协调者自行排序，严格逐项派发；原 Task 主 Agent 自行先 commit（如需）再同步。Watchdog 或原 Agent 按协议回报，协调者核对实际落地并验收后，才启动下一项。独立看板与对照环境的进一步实现、完整验收延后。完整协议见[实验设计](../../docs/experiments/base-branch-sync-ordering-experiment-design.md)。

旧的中央排序执行器、只读 Git 整合 worker、专属预算／恢复控制器及其测试已从源码删除。原件已归档到本 Task 持久交接目录；历史模型调用、计量、失败和 RVF 记录均保留。它们属于旧路线校准，不作为新协议的实验结果。

独立 runtime 已启动，恢复了排除 DD679 后的 12 张卡、工作树与原生历史；bd273 的真实 TUI 已显示原最终交付记录并待命。专用文字回显 Task 已通过 CLI 发消息、原生接受与回复核验；其余样本尚未逐一启动，尚未委派样本合入。

```sh
node_modules/.bin/tsx scripts/base-branch-sync-ordering-experiment/cli.ts --help
node_modules/.bin/tsc -p scripts/base-branch-sync-ordering-experiment/tsconfig.json --noEmit
npm run test:guarded -- --project precommit-safe test/runtime/diagnostics/base-branch-sync-ordering-experiment.test.ts
```

| 命令 | 用途 |
| --- | --- |
| `backup-current-repository --project <path> --task-worktree <path> --cohort <path> --output <new-directory>` | 保存 refs、登记 HEAD、Git 管理状态与 base／本任务 WIP，并独立恢复核验 |
| `backup-cohort --input <json> --output <new-directory>` | 先保存全范围任务状态，准入和交付去重另行核验；不覆盖旧快照 |
| `backup-environment --input <json> --batch <directory>` | 保存安装、发行物及可执行闭包 |
| `verify-cohort-backup --batch <directory>` | 校验归档、独立恢复 base 与任务 |
| `derive-reviewed-batch --cohort <path> --decisions <path> --repository-backup <path> --output <new-directory>` | 从归档派生精确准入输入，绑定实际 base，保留资格与去重依据 |
| `capture --input <json> --output <new-directory>` | 建立完整内容匹配评审候选的冻结批次 |
| `verify --batch <directory>` | 校验冻结批次原件 |
| `plan --batch <directory>` | 离线计算遵守共同依赖的确定性排列；不发模型回合或执行整合 |
| `fork-check --batch <directory> --task-id <id> --codex-binary <path> --configuration-source-home <path>` | 无模型回合地核验私有原生 fork、父子身份和完整历史前缀 |
| `isolation-check --batch <directory>` | 实测基础分析进程的文件边界与网络拒绝 |
| `prepare-isolated-runtime-boundary --owned-root <path> --instance <path> --private-runtime-port <number> --protected-runtime-port <number> --executable <paths...>` | 准备独立设置、浏览器 origin 与进程边界；不启动 runtime 或 Agent |

`restore-linked-task-worktree-from-frozen-snapshot.ts` 只负责把原始工作状态恢复为本实例 common-dir 下的 linked worktree，保留 HEAD、原始／split index、staged／unstaged／untracked、删除、权限及链接。恢复重入先对账，不覆盖后续工作；不向原主 Agent 施加只读 Git 限制，也不代做 commit 或同步。

任务可能通过绝对链接使用共享安装。`restoreExecutionEnvironmentIntoPrivateDirectories` 从归档物化独立副本，按回执映射链接；不用可写硬链接，不把归档对象作为可写 node_modules。来源安装根名为 node_modules 时，私有物理根也保留这一层，不能仅凭归档名称猜测路径。

外部包的上级 Node 依赖解析须按冻结物理来源恢复。旧归档缺少解析关系时，可用 `captureSupplementalExternalPackageNodeResolutionEvidence` 核对来源与归档字节、模式及链接后生成独立补证；恢复时显式传入证据路径和摘要。缺证保留 unknown，不按版本号猜测，不改写原归档。

独立看板使用私有 HOME、原生存储、关系账本、Git common-dir 和配置，不继承生产 Task 身份、Node 注入或旧分析器禁用 Git hooks 的配置。每份实例使用唯一浏览器 hostname；端口复用也不继承上一轮 Cookie／origin 存储。Seatbelt 限制普通文件写入、本实例 TCP／Unix socket 及同沙箱进程信号；原生 TUI 另需标准 PTY 设备权限。它仍共享系统用户和终端设备类别，不等于 VM 安全隔离。

私有环境通过 `KANBAN_CODEX_SESSION_CONTROL_SOCKET_PATHS_BY_SCOPED_SESSION_KEY` 明确绑定 workspace／会话与本实例控制路径，保留普通 Codex TUI、控制宿主与原生 RPC。Codex 0.166.0 实际使用用户级共享 daemon 目录；Seatbelt 只允许本实例已登记路径对应的精确 socket／lock，禁止列出目录或访问其他 socket。缺少会话绑定时保留失败，先补齐实例配置再续接；日常未设置该变量时沿用原路径。模型连接只经公共目的地址白名单代理，禁止连接日常控制面。

消息使用稳定幂等键，正文避免额外首尾空白。即时回执失败不证明未接受：本次核验中 RPC 返回原生 turn，初始接受查询未命中，随后后台补证为 `native_accepted`，且原生历史有唯一用户消息和回复。协调者遇到此类结果先核对操作日志及原生历史，不重发已接受消息；保留初始失败回执，不改写成即时通过。空闲排队未通过的历史也保留；可在核实当前原生回合结束后使用普通直接消息通道。

组件 guarded 测试验证私有设置、真实 PTY、自身 HTTP／Unix socket、子进程环境、越界拒绝、幂等接续与漂移保护。完整普通工作流须分别验收，未通过前不启动正式队列。

最终共同种子包含 main、Task、worktrees、sessions、配置、依赖与发行物，在构建 commit／base-branch-sync 完成后制作。种子只读保存；每轮再从种子派生私有可写实例，其 Task 的 `main` 和 Git 对端均归属该轮，不能直接运行种子或复用上一轮已改变的实例。

计量覆盖构建者、协调者、Watchdog、原主 Agent 和必要评审，原生记录按 response 身份去重；缓存输入属于输入子集。失败仍入账，缺失保留 unknown／已观察下界，不写成零。本轮不自加总 Token 或总尝试上限。纯用量解析保留在 experiment-contract.ts；实际工作回合由对应 Task 的正常会话承接。

DD679 和 D55EE 不进入实验工作负载。旧备份不删除；DD679 已合入 main，用户确认已部署但问题残留，按用户决定不阻塞继续。开始点在构建交回 main 后重新冻结，见[备份进度](../../docs/experiments/base-branch-sync-ordering-backup-progress.md)。
