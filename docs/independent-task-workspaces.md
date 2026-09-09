# 独立任务工作区

独立任务用于研究、写作、规划等不绑定仓库的会话。项目选择器内置并置顶「独立任务」，无需先添加仓库；仍复用现有看板、任务命名、Agent 选择、权限档位、会话与任务搜索。

## 目录与生命周期

- 每张新卡片在保存时分配 `~/.cline/kanban/independent-task-workspaces/<taskId>/` 普通目录，不执行 `git init`。
- PTY、Cline SDK、ACP 与任务附属终端均使用该目录。目录隔离是默认工作目录的隔离，不是文件系统沙箱；Agent 的本地操作仍受所选权限档位控制。
- 完成、归档、停止会话与运行时重启均保留目录。恢复会话只验证原目录，丢失时明确失败，不重建一个空目录冒充恢复。
- 「创建并启动」等待服务器保存后的看板状态，再进入既有启动链路，防止启动早于目录分配。
- 永久删除须确认目录及全部文件。后端先停止该任务及同目录附属会话，再在看板锁内验证目录所有权并清理。拒绝符号链接和越界 task ID；文件清理失败时保留卡片。普通整板保存不能删除独立任务。
- 单独关闭详情终端或附属会话只停止该会话；停止看板任务时才同时停止同目录的 PTY、Cline 与 ACP 会话。

## 契约与边界

`workspaceKind = independent_tasks`、`repositoryPath = null`、`git = null` 表达不绑定仓库。`repoPath` 为兼容既有路由保留，表示集合目录，不能用于判断是否具有仓库能力。旧仓库数据缺少 `workspaceKind` 时继续按仓库处理。内置 ID `kanban_independent_tasks` 使用仓库自动命名不会生成的下划线，避免与同名仓库索引碰撞。

独立卡片的 `worktreeMode = independent_directory`、`baseRef = ""`、`autoReviewEnabled = false` 由持久化入口统一设置。仓库看板拒绝独立目录模式。Git diff、分支、提交、同步和 checkpoint 不参与独立任务运行；相关 Git procedure 直接拒绝独立集合请求。

文件补全仅检索指定 task 的目录；创建前没有 task ID 时返回空结果。集合根目录不承载共享 Home Agent 或共享终端会话。「打开目录」在任务详情中指向该 task 的目录。

CLI 示例：

```bash
kanban task create --independent-tasks --prompt '整理研究资料' --title '研究资料'
kanban task list --independent-tasks
kanban task get --independent-tasks --task-id <id>
kanban task delete --independent-tasks --task-id <id> # 只列出待删除目录
kanban task delete --independent-tasks --task-id <id> --confirm-delete-workspace-files
```

`--independent-tasks` 与 `--project-path` 互斥。创建预览仍为只读。内置集合不可作为普通项目整体删除或初始化为 Git 仓库。

CLI 删除时，指定不存在的 task ID 会明确报错。每个任务确认删除成功后，清理其持久化编辑草稿及落败副本；预览、删除失败和其他任务的草稿保持不变。

## 验证

- `test/integration/workspace-state.integration.test.ts`：普通目录持久化、缺失目录不重建、符号链接与整板删除保护。
- `test/integration/runtime-state-stream.integration.test.ts`：隔离 HOME 下无仓库启动、真实 PTY 的 `pwd`、文件补全隔离、归档和跨进程重启保留、显式删除。
- `test/integration/task-command-exit.integration.test.ts`：CLI 预览、创建、更新、读取及确认删除。
- `test/runtime/trpc/runtime-api.test.ts`：三种 Agent transport 接收工作目录，独立任务不创建 checkpoint。
- RVF 定向回归：停止入口 104 项通过；CLI 集成 17 项通过，包含不存在 ID、删除失败保护、草稿与落败副本清理。
- Web UI hooks：无分支建卡、等待服务器保存再启动。
- `test/integration/independent-task-browser-check.integration.test.ts`：实际 dist、隔离实例与 Chromium 的建卡、刷新、再次编辑，以及立即启动前目录已存在。启动请求被拦截，不调用外部 Agent 服务。先 `npm run build`，可用 `KANBAN_BROWSER_EXECUTABLE_PATH` 指定已安装 Chromium；未提供可用浏览器或未构建时仅跳过这项浏览器检查。

本次实现验证：根 `precommit-safe` 2151 项、Web UI 1545 项通过；完整集成运行 130 项通过，剩余 1 项缓存测试适配新增入口的刷新计数后定向重跑通过（共覆盖 131 项，浏览器检查实际执行）。根与 Web UI 类型检查、构建、修改文件的 Biome 检查及 `git diff --check` 通过。集成命令使用 `env -u NO_COLOR -u FORCE_COLOR`，避免执行环境同时设置颜色变量导致 Node 警告干扰 CLI 的空 stderr 断言。

## 延后范围

创建时检索其他 task 并复用其工作区，等 Task Relation Modeling Overhaul 完成后实现；本期不增加工作区复用入口。自动 tags / groups 不在本期实现中，后续复用现有 AI 命名设施。

## Task 9674c 部署后验证

| 行为 | 部署前已证 | 部署后待验 | 类型 |
| --- | --- | --- | --- |
| 独立目录生命周期与删除保护 | 隔离实例 API、CLI、PTY 与重启测试 | 无额外重复项 | — |
| 浏览器表单、刷新、立即启动 | 实际发布包与自动化 Chromium | 无额外重复项 | — |
| 正在使用的安装实例提供新契约 | 工作区构建通过 | 实际部署是否已切换到包含独立入口的版本 | automated_script |

已注册 `653a84a3-bcd4-4c86-8873-1d5303925efa`，资产在 `~/.cline/kanban/verifications/653a84a3-bcd4-4c86-8873-1d5303925efa/`，清理模式 `automatic`。旧实例 dry-run 按预期返回「尚未提供独立任务入口」，受控退出、未超时、无写入或残留实体。部署 record 后预计挂载 1 个自动验证、0 个人工验证。

RVF 修复后以同一 ID reconcile 重注册，定义仍为 1 条。停止范围与 CLI 删除边界由部署前自动化回归覆盖，无新增部署后人工项。

兜底清理：`kanban verification cleanup --verification-id 653a84a3-bcd4-4c86-8873-1d5303925efa`。本变更无验证专用代码插桩。
