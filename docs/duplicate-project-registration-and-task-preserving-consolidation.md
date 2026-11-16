# 项目显式登记与重复项目保全合并

任务命令只解析已登记的项目。省略 `--project-path` 时先取会话绑定的 `KANBAN_PROJECT_PATH`，并核对当前目录与绑定路径的 Git common-dir；没有绑定时只接受唯一的已登记同仓库项目。普通启动和打开已有运行实例不会登记 cwd。新仓库须先通过界面或显式 `project add` 登记。

## 已查明的误登记链路

2026-11-14，任务 `515ad` 的部署侧会话在任务工作树中调用 `task conversation-session report`，遗漏 `--project-path`。当时的共享解析器默认允许创建项目，随后又调用 `projects.add`；因此工作树被视作独立项目。历史版本 `0e612020cbb8f2a0c2652e7292dde723d74022db` 同样存在该行为。

原回执返回 `{"ok":false,"error":"任务不存在。"}`，CLI 却以退出码 0 结束，调用脚本只检查退出码而漏过了错误。公开操作记录显示 Agent 当时在汇报部署材料，没有提出新增项目的目的。历史没有独立项目创建审计，因此不能确定首次登记的精确时刻，也不能据此推断隐藏思考。

异常项目 `cline-kanban-ap5x` 指向 `/Users/bominzhang/.cline/worktrees/515ad/cline-kanban`，正常项目 `cline-kanban` 指向 `/Users/bominzhang/Documents/GitHub/cline-kanban`。两者 Git common-dir 相同。调查时异常项目仅有以下两张卡，均在 In Progress：

| Task | 名称 | 必须保留的内容 |
| --- | --- | --- |
| `c810e` | `[PERF]定位任务切换与远程交互响应迟缓的原因` | 原生对话、调查文档的未提交改动及工作树 |
| `f56e2` | `[DOCS]完善安装与使用指南并补充关联仓库引用` | 原生对话、尚未回答的问题及工作树 |

## 显式新增的授权边界

`projects.add` 在 clone、Git 初始化、初始提交和索引登记之前检查调用来源。经过验证的界面请求沿用交互入口；CLI 声明优先于界面 nonce，不能借 nonce 绕过 Agent 凭据检查。

非界面调用先执行只读预览：

```sh
kanban project preview-add --path /absolute/repository/path
```

再将返回的规范路径和 `previewFingerprint` 与用户授权原话、来源写入请求文件：

```json
{
  "path": "/absolute/repository/path",
  "previewFingerprint": "预览返回的指纹",
  "authorization": {
    "userQuote": "用户实际授权新增该项目的原话",
    "sourceReference": "可回查的原始消息或批准记录"
  }
}
```

执行 `kanban project add --request-file /persistent/project-add-request.json`。非界面入口仅接受已有 Git 仓库的规范路径；clone 和初始化继续由界面承接。预览与执行之间路径或注册状态变化会拒绝执行。授权及行动者证据先持久化到 `~/.cline/kanban/explicit-project-registration-audit/`，成功后补记项目身份。

授权原话和来源是防误用与审计凭据，不是经过独立身份认证的用户批准证明。不能把 Agent 自行声称“已授权”视作真人授权。

## 同仓库重复项目合并

该维护入口仅支持相同 Git common-dir、相同仓库目录名的两个已登记项目。它不会删除仓库、任务工作树或未提交改动，也不把已启动任务改回 Backlog。原地执行任务、撞号、无法确认任务归属的会话、未结算投递、未识别状态文件都会阻止合并。

```sh
kanban project preview-consolidation \
  --source-workspace-id cline-kanban-ap5x \
  --target-workspace-id cline-kanban
```

核对返回的 task 清单，再以来源、目标和 `previewFingerprint` 执行：

```sh
kanban project consolidate --request-file /persistent/consolidation-request.json
```

执行路径：

1. 在来源 board 锁内重新核对预览，持久登记操作并发布冻结控制状态；同一低层写入漏斗也拦住已通过上层校验的旧请求。只有 Agent 仍占有且进程处于 starting、live 或 retrying 的回合才推迟受理；待审、待答和已经退出的会话不会自行结束，不把它们当成仍在工作。当前运行时未托管、但记录中的进程仍存活时，在写回执前拒绝。
2. 使用现有运行时停止与释放入口关闭来源进程，并确认原进程已经退出，才清除 pid、控制端点和配置 writer 绑定并保存来源原件。保留原生会话身份、问题、Stop 和投递结果。工作区快照的 legacy observation 与 snapshot commit 是派生记账，不迁入目标，也不算未识别状态。显式 Stop 标记随 workspace 复制到目标后，才装入迁入的停止会话。本次已经复制的事实和目标 Stop 名单写在同一份独立 Stop 文件的一次原子提交里；合并回执上的标记可以晚于该文件，缺失时恢复仍不得把用户已经解除的 Stop 并集加回，也不得在该提交成功前把复制记成完成。回收期限必须已是 reclaimed 或 superseded 才进入捕获；未结算时保持 quiescing 并重新读取来源原件。
3. 按既有存储队列与锁合并辅助状态，逐卡先保存目标，再移除来源。账本追加已有 `task_card_project_transfer_completed` 事件，保留最初 workspace/task/incarnation 身份，只更新当前位置。
4. 生命周期投递原件保留在回执中，不进入目标恢复扫描器；已失败消息保持失败，历史回收记录不重新激活。任务在原列保留。
5. 确认来源已无卡片或会话后注销项目索引。原目录中的历史状态与持久回执保留，旧项目 ID 和仓库路径解析到目标；旧作用域写请求必须刷新，不能重新登记来源。

日常门禁只读取 `~/.cline/kanban/duplicate-project-consolidation-controls/` 中按 workspace ID 或仓库路径摘要定位的 v1 小型控制记录；完整任务、会话和辅助状态快照留在 `duplicate-project-consolidations/<来源项目>.json`，不被无关项目扫描。单份损坏审计只影响该操作，恢复循环继续处理其他记录。捕获前因范围漂移拒绝时，回执记为 `rejected_before_capture` 并解除控制状态；新预览可重新受理，旧失败原件归档保留。捕获之后继续前向恢复，不能作为未受理操作解冻。

各 store 拥有自己的迁移合并、完整校验及缓存规则；最近打开时间只前进不后退，历史投递不触发新结算镜像。runtime 组合根创建一份合并服务，HTTP 与后台恢复复用，恢复代际取实际 runtime 身份。完成控制状态已经公开时，后续恢复只补注销与审计，不重放 Stop，也不替换目标已启动的会话。

失败时复用同一请求接续，不另建卡片。运行时已有的持久操作恢复循环在无浏览器时也会尝试接续。同一份恢复证据最多自动尝试三次，间隔至少 30 秒。证据包含来源看板与会话、回收期限原件和目标存储；任务已经写入目标后，再加入本进程代数和目标终端管理器是否已经装入。这些条件变化或运行时重启后，重新给予最多三次尝试，同一进程里证据不变则不再重复装入。回执记录失败原因与下次检查时间；身份或状态冲突不会被写成成功。无版本旧看板不能删除迁入卡，来源后台写入也会被拒绝。

本次现场清理须使用包含上述能力的真实运行实例。源码测试与隔离构建通过，不表示异常项目已经移除；普通计划批准不构成本机部署授权。

## 验证

`test/integration/duplicate-project-consolidation.integration.test.ts` 使用 HOME 隔离的真实 Git fixture，覆盖绑定解析、只读预览、授权审计、原身份迁移、待答问题、工作树改动保留、旧链接及目标写入后的故障接续。现有 Backlog 迁移测试继续覆盖原有合同。

任务编辑器共用项目字段显示完整仓库路径，选中后仍显示路径，并支持按路径检索。界面测试覆盖同名项目的选项与选中结果。

`duplicate-project-consolidation-packaged-runtime.integration.test.ts` 复用现有隔离 runtime fixture，验证真实 HTTP 受理、捕获后进程崩溃、重启后的后台接续及原身份、问题、Stop、工作树保留；CI 在 build 后的 Root tests 自动运行。未构建时跳过该打包用例，可用 `KANBAN_DUPLICATE_PROJECT_CONSOLIDATION_PACKAGED_CLI_PATH` 指定已隔离构建的 CLI。
