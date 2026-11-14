# 任务列表 Git 查询范围、缓存与资源验证

`kanban task list --column …` 曾在筛选之前调用无参 `workspace.getTaskWorkspaceGitStatuses`。服务端逐卡读取 HEAD、计算分歧和提交溯源，绕过浏览器元数据已有的变更门控，把按列查询放大成整板 Git 探测。本次修复服务端与 CLI；外部 Overwatch 的触发与安装脚本由其所属任务维护。

## 查询合同与缓存

- `workspace.getTaskWorkspaceGitStatuses({ taskIds })` 只读取服务端看板内被选中的任务。空数组返回空映射，不启动 Git；未知 ID 不变成探测目标。旧无参调用仍返回整板状态。
- CLI 先读取看板并应用 column / closureOutcome 筛选，再传入最终任务 ID，输出结构保持一致。
- `task-workspace-git-status-query-cache.ts` 在进程内共享缓存和同键单飞，复用 `loadTaskWorkspaceMetadata`，不新增轮询器。键包括 workspace、仓库路径、任务 ID / createdAt、baseRef、worktreeMode 和持久 provenance 内容版本。
- 每次只为所选任务计算 provenance 版本；持久归属修复、历史恢复或删除，即使 HEAD 未变也会失效。响应前再次核对卡片身份，丢弃删除重建或更改 baseRef / mode 期间结束的旧探针。
- 缓存最多 2048 项，下一次查询时清除五分钟无人请求的空闲条目；进程重启后冷启动，不恢复未完成 Promise。

底层沿用既有热 / 冷刷新窗口、近期活动判断、base tip 每批去重与全局 Git 并发上限。没有降低刷新频率：HEAD/ref/index 变化走廉价 token；就地未暂存编辑仍由热档 10 秒、冷档 60–90 秒兜底。

`git-change-token.ts` 的 gitdir 解析缓存同样限制为 2048 项：不缓存缺失结果，以 `.git` 的设备 / inode / 文件变更识别替换；读取 symbolic HEAD 对应的 common-dir ref 和 packed-refs，避免其他工作树推进共享分支后沿用旧 token。

## 失败、取消和恢复

探针失败返回 `git_probe_unavailable`，不能用旧成功冒充当前读取。失败不形成成功缓存，单飞在 finally 释放，下次查询立即重试；调用方已有的超时错误走同一路径。没有独立重试定时器，恢复条件是下一次正常查询。

客户端取消一个请求不取消其他消费者共享的读取。停止运行时后不保留进程内缓存；重启读取原有看板和 provenance，再计算当前状态。历史观测时间不因缓存命中而刷新。本次没有增加永久卡死 Git 进程的原生故障注入或新的 Git 超时策略。

## 自动验证与资源口径

单测覆盖 CLI 筛选、空范围、并发、失败重试、身份 / provenance 版本、容量与闲置淘汰，以及 `.git` 初次创建、替换、共享 ref 和 packed-refs 失效。共享探针另有旧成功后失败及立即恢复的回归。

`test/integration/task-workspace-git-status-query-cache.integration.test.ts` 使用统一 Git fixture、隔离 HOME / Codex 存储和真实打包 runtime，验证 HEAD/base 推进、Git 目录故障、provenance 缺证恢复、客户端断开、停止 / 重启及真实 CLI。确认 runtime 退出后才清理 fixture；此查询测试禁用新建独立 PTY host。

固定实验规模为 1 个项目、12 个有提交的任务、6 个所选任务。基线为 `ea592d5225bc48eb1e6a75e717b3ad1051ed76bc`，对照修改前的无范围 API 与候选版的范围 API；冷启动和首次 provenance 版本收敛单独记账。

| 场景 | 修改前 Git 派生 | 修改后 Git 派生 |
| --- | ---: | ---: |
| 稳定状态连续读取 8 次 | 392 | 8 |
| 并发读取 4 次 | 196 | 1 |
| 无订阅空闲观察 | 0 | 0 |

Git 数量来自 `GIT_TRACE2_EVENT` 的 start 事件，包含已退出短命进程。CPU/I/O 使用 macOS 原生计数，校准 Mach timebase 并核对父进程启动世代；父自身 CPU 与已回收子进程 CPU 分开，不能把所有子 CPU 归给 Git。墙钟、I/O 和 footprint 变化不外推成整机收益或内存泄漏结论。

可选实验参数：

```sh
KANBAN_GIT_QUERY_BASELINE_CLI_PATH=/持久目录/baseline-distribution/cli.js \
KANBAN_GIT_QUERY_NATIVE_RESOURCE_SNAPSHOT_SCRIPT_PATH=/持久目录/read-darwin-runtime-resource-snapshot.py \
KANBAN_GIT_QUERY_RESOURCE_EVIDENCE_DIRECTORY=/持久目录 \
npm run test:guarded -- --project runtime-integration \
  test/integration/task-workspace-git-status-query-cache.integration.test.ts
```

省略参数仍执行候选版本功能与派生数回归，不依赖外部模型或消息服务。构建、原始 trace、原生快照、失败历史和交接报告保存在 `~/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/task-e5aec-git-query-resource-efficiency/`。

## 实际采用边界

本任务没有同步、推送或部署。历史 PID 78881 在调查期间退出；之后 PID 55555 的生产采样属于另一个启动世代，不能与隔离实验相减。真实实例采用本任务代码后的资源表现仍待部署后核验。

已登记自动验证 `96ca5732-87db-4a89-9528-802b01e5aecc`，只读检查真实实例连续空范围查询不扩散为整板结果。脚本资产不依赖任务工作树，没有标记通过。兜底清理：

```sh
"$KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH" verification cleanup \
  --verification-id 96ca5732-87db-4a89-9528-802b01e5aecc
```
