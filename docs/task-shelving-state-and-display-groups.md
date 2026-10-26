# 任务搁置状态与展示分组

Shelved 是独立任务状态。搁置时保留真实 Stage、置顶意图、会话与 worktree；各视图把卡片集中到最后的 Shelved 展示组，默认收起。

## 状态与操作边界

卡片的可选字段 `taskShelvingState` 保存 `{ isShelved, lastChangedAt }`。旧卡缺省未搁置；解除搁置仍保留 `isShelved: false` 和变更时间，作为旧快照与自动移列的水位。搁置不改变任务内容的 `updatedAt`。

`taskCardAction.setTaskCardShelvingStateWithoutSessionSideEffects` 在任务串行器及 workspace 写锁内修改最新卡片，校验任务 incarnation，复用行动者记账和状态广播。重复设置当前状态不写盘、不刷新时间。搁置及解除搁置都不启动或停止会话，也不创建或删除 worktree。

搁置卡禁止自动移列；普通手动移列须先解除搁置。会话状态继续按真实摘要展示。解除搁置回到原 Stage，不重放搁置期间的自动移列；新的可信活动继续触发现行规则。自动审查也在搁置期间暂停，并排除解除搁置之前的活动。

唯一同时改变状态和 Stage 的入口是单独启动搁置 Backlog：在同一次持久写入中解除搁置并移入 In Progress，再正常准备 worktree 和启动。启动失败沿用普通 Backlog 行为，卡片留在 In Progress。Backlog 批量启动与 Done 整列清理排除搁置卡。

```sh
kanban task shelve --task-id <taskId> --project-path <mainRepositoryPath>
kanban task unshelve --task-id <taskId> --project-path <mainRepositoryPath>
kanban task get --task-id <taskId> --project-path <mainRepositoryPath>
kanban task list --all-projects --group shelved
```

任务查询返回 `taskShelvingState`。跨项目取景包含所有搁置卡，不受 Recent 时间窗限制，身份始终使用 `(workspaceId, taskId)`。

## 展示投影与持久化

真实 `BoardColumnId` 仍只有五个 Stage。`BoardDisplayGroupId` 另外包含 `shelved`，`projectTaskBoardDisplayGroups` 仅供看板、Focus View 和导航渲染，不能保存成看板。

Shelved 优先于原 Stage、Pinned、Running、Cache warm 和 Recent，组内按最近状态变更倒序。原 Stage 交给卡片动作判定，搜索与跨项目定位搁置 Backlog 时也能进入 Shelved 的 Focus View，不解除搁置；Focus View 的行内头、固定头与导航读取同一展示分组。展开偏好分别复用单项目看板、Focus View 与跨项目切换面板的持久偏好。

拖入 Shelved 执行搁置；拖回原 Stage 仅解除搁置；搁置 Backlog 拖到 In Progress 执行单独启动。Shelved 不支持手动排序。拖放按任务 ID 和可见目标卡锚点换算完整看板位置，不使用被隐藏卡片改变含义的源索引。

浏览器始终保存完整看板。搁置命令的乐观状态只进入展示 overlay，失败即撤回。服务端整板保存保留 runtime 的最新搁置状态，拒绝旧快照对搁置卡的移列或遗漏；解除搁置后，携带旧状态水位的快照同样不能重放原来的移列。

## 验证

领域测试覆盖五个 Stage、旧卡兼容、幂等往返与旧快照；真实 tRPC 集成覆盖 incarnation、串行化、启动成功和失败、会话副作用边界、整列清理。Web UI 测试覆盖展示唯一性、置顶恢复、真实 Stage 动作门控及隐藏卡片后的拖放定位。

隔离 HOME、runtime、CLI 和 Playwright 的端到端入口复用仓库现有宿主：

```sh
KANBAN_RUN_ISOLATED_TASK_SHELVING_BROWSER_CHECK=1 \
PLAYWRIGHT_BROWSERS_PATH=<installedPlaywrightBrowsersPath> \
npm run test:guarded -- --project runtime-integration \
  test/integration/cross-project-task-switcher-server-card-actions-real-browser.integration.test.ts
```

本机原生依赖须使用与其 ABI 匹配的 Node 版本；不要在共享 `node_modules` 上为验证重编译依赖。

## 部署后验证

| 行为 | 部署前覆盖 | 部署后观察 | 类型 |
| --- | --- | --- | --- |
| 字段、幂等、并发、旧快照与启动失败 | 领域测试及真实 tRPC 集成 | 无额外断言 | 不注册 |
| 分组唯一性、拖放、聚焦、展开偏好、重启恢复 | 隔离 runtime、CLI 与 Playwright | 无额外断言 | 不注册 |
| 已安装 CLI 与在线 runtime 的版本配套 | 本 worktree 的源码及打包测试 | 部署后执行只读 Shelved 全项目分组查询 | `automated_script` |
| 真实 agent 输出、交棒与搁置状态同时存在 | 隔离会话桩和自动移列测试 | 自然使用实际 agent 时观察，保留任务优先级由用户决定 | `guided_manual` |

当前任务 `3cc9f` 已注册两项，`verification list` 返回 `count: 2`，均为 `cleanup.mode: automatic`：

- `6b192ebc-3c6f-49fa-8bf9-4a18053883ea`：部署后安装的 CLI 与在线 runtime 能返回独立 Shelved 全项目分组。脚本资产位于 `~/.cline/kanban/verifications/6b192ebc-3c6f-49fa-8bf9-4a18053883ea/`，不依赖 task worktree。旧实例 dry-run 如实返回不支持 `--group shelved`，无崩溃、超时或临时任务残留。
- `05ebfdc0-2001-41d8-adea-8ec8e43379f8`：真实 agent 任务搁置后保留原 Stage 和会话，四个视图仅在 Shelved 展示。定义资产位于 `~/.cline/kanban/verifications/05ebfdc0-2001-41d8-adea-8ec8e43379f8/`，使用稳定锚点 `board-column:shelved`。

部署记录后预计挂载一项自动检查和一项真实使用观察；本次注册不表示部署后检查已经通过。没有 repo 临时插桩。兜底清理命令：

```sh
kanban verification cleanup --verification-id 6b192ebc-3c6f-49fa-8bf9-4a18053883ea
kanban verification cleanup --verification-id 05ebfdc0-2001-41d8-adea-8ec8e43379f8
```
