# CLI 全项目分组查询与持续监控

`task list --all-projects` 与 All Projects 视图共用分组和排序规则。`task watch --all-projects` 持续查询同一份只读快照，不启动、恢复或修改任务。

```bash
kanban task list --all-projects
kanban task list --all-projects --group running
kanban task list --all-projects --group recent --recent-days 30 --query "修复"
kanban task watch --all-projects --group running
kanban task watch --all-projects --group running --interval-ms 5000 --exit-when-empty
```

## 范围与筛选

| 参数 | 行为 |
| --- | --- |
| `--all-projects` | 查询 runtime 已注册的全部项目；与 `--project-path` 互斥，不依赖调用者当前目录 |
| `--group` | `pinned`、`running`、`cache_warm_awaiting_user`、`recent`；省略时按此顺序返回四组 |
| `--query` | 任务 ID 或投影标题的不区分大小写字面子串；不搜索 Prompt，不做模糊或语义搜索 |
| `--column` | 对组内任务进一步筛选；`done` 对应内部列 `trash` |
| `--recent-days` | `7`（默认）或 `30`；只影响 Recent，按最近触达倒序 |
| `--interval-ms` | 仅 watch；默认 `5000`，范围 `1000` 至 `2147483647` |
| `--exit-when-empty` | 仅 watch，必须指定 `--group`；所选组内筛选结果连续两次完整为空后退出 |

Running 使用可信主会话的 `turnOwner`、`liveness` 与明确 park 事实，包含 agent 回合中的 retrying 和后台等待。`in_progress` 列中等待用户的任务可以不在 Running；其他列的任务也可以在 Running。Pinned 可以同时属于主分组，主分组 Running／Cache warm／Recent 互斥。Recent 包含符合时间窗的 Done 卡。

CLI 使用共享规则的默认排序，不读取浏览器的本地筛选、展开状态或排序偏好。查询不隐式排除调用者自身的任务；它若仍在 Running，也会被列出。较长标题与界面一样采用现有投影的展示文本。

未指定新参数的单项目 `task list` 保留既有行为和输出结构。

## 输出与退出条件

单次全项目查询返回 JSON，包含 `observedAtMs`、`recentDays`、`filters`、`coverage`、`groups` 和 `count`。每组中的任务保持共享排序，带 `workspaceId`、`taskId`、项目名称／路径、看板列与会话 facets。跨项目身份始终使用 `(workspaceId, taskId)`；`count` 按该身份去重，不能把各组条数相加当作任务数。

watch 每次采样输出一行 JSON，即 NDJSON；正常采样也持续输出，便于确认进程仍在观察。事件为：

- `all_projects_task_group_snapshot`：与单次查询相同的结果，`ok` 表示覆盖是否完整。
- `all_projects_task_group_query_unavailable`：本次请求失败及原因。
- `all_projects_task_group_monitor_stopped`：终止原因与退出码。

`--exit-when-empty` 只证明当时查询结果已清空。离开 Running 可能表示等待用户，并不代表所有任务完成、进入 Done、完成 RVF、回写 main 或具备部署资格；命令不会触发这些动作。新进入范围的任务会参与后续采样，不固定启动时的任务批次。

## 查询完整性与恢复

服务端 `projects.getAllProjectsTaskGroupQuerySnapshot` 返回逐项目 `taskEntriesReadStatus`。读取失败时保留原因和其他可读项目，不将失败项目当作有效空集合；旧界面的宽松读取行为保持兼容。持久层约定的缺失初始文件仍表示尚未建立的空状态，损坏或访问失败则表示不可读。查询不使用失败后的陈旧会话回退作为完整证明。

部分覆盖使单次查询退出 `1`，watch 则重置空结果确认并自动补查。请求失败与部分覆盖共用 60 秒恢复预算，重试间隔为 2、5、10 秒，此后最多 10 秒；恢复完整查询即重置预算。请求有独立超时，且受剩余恢复预算限制。60 秒持续不可完整查询后退出 `1`。旧 runtime 缺少 procedure 或返回不兼容契约时明确失败，不回退为空数据。

watch 豁免普通 CLI 的整命令硬超时，但保留上述请求与恢复时限。SIGINT／SIGTERM 取消在途请求和输出等待，分别退出 `130`／`143`。中断停止事件最多等待 500 毫秒输出；从首次信号起，包含最终排空在内的退出期限为 2 秒，后续信号不重置期限或退出码。下游暂停读取时，中断可能舍弃尚未排空的输出；正常结束仍等待完整写入。脚本应检查退出码和完整性字段，不能仅凭 `count: 0` 判断清空。此入口是前台进程，不创建持久后台监控作业。

## 实现与验证边界

实现复用项目注册表的主会话投影及 `assignCrossProjectTaskSwitcherSections`；读取并发有跨请求上限，不请求工作树 Git 元数据。schema、procedure 和 CLI 同时更新，不修改 Web UI 分组算法。

自动化覆盖分组一致性、跨项目同号、筛选、缓存到期、损坏数据与恢复、取消、请求超时、旧命令兼容、管道大输出及 runtime 重启接续。默认 guarded 命令执行进程内只读与严格完整性用例，跳过需要打包 CLI 的真实进程用例：

```sh
npm run test:guarded -- --project runtime-integration test/integration/all-projects-task-group-query-and-monitor.integration.test.ts
```

真实进程用例使用隔离 HOME、Git fixture 和自动分配的端口。先检查 `dist` 与 `web-ui/dist` 的 realpath，确保两者都是本任务私有目录，并显式设置 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY` 完成隔离构建，再启用完整验证：

```sh
KANBAN_TASK_GROUP_QUERY_TEST_PACKAGED_CLI_PATH=/absolute/task-build/dist/cli.js \
npm run test:guarded -- --project runtime-integration test/integration/all-projects-task-group-query-and-monitor.integration.test.ts
```

指定路径必须指向存在的打包 CLI 文件，否则测试失败；不会回退到源码入口或共享 `dist`。显式打包模式自动验证大输出完整性、监控硬超时豁免、runtime 重启接续，以及暂停读取 pipe 时 SIGINT／SIGTERM 在各输出阶段的有界退出和第二次信号处理。部署后另核对全局 CLI 与真实运行实例的版本接线。
