# 任务结案分类与成果保全

## 交付范围

任务内部列 ID 仍为 `trash`，展示名称统一为“已结案”。当前会话已授权实施；实现保留在任务 `e3025` 工作区，未提交、同步或部署，也未对真实任务执行结案或批量退役。

| 结果 | 展示名称 | 校验 |
| --- | --- | --- |
| `delivery_accepted` | 交付已接受 | 显式选择，可记录验收证据 |
| `plan_retired` | 方案退役 | 必填原因，可引用替代任务 |
| `implementation_unnecessary` | 确认无需实施 | 必填判断依据 |
| `merged_into_successor_task` | 并入其他任务 | 必填原因及承接任务 |
| `cancelled_by_user` | 用户取消 | 必填原因与授权来源 |
| `closure_outcome_unspecified` | 结案结果未标注 | 历史卡、未传结果的旧 API 调用兼容值 |

部分成果已接受、剩余方案退役时，以 `plan_retired` 为主结果，`acceptedDeliverables` 分别记录成果说明和至少一条验收证据。承接引用保存 workspace、task ID、incarnation，服务端核验引用仍指向同一代任务。

结案结果、代码进入 base、部署和 PDV 通过分别记录。任何结案分类均不自动写入 `verifiedAt`，结案记录也不自动建立需求覆盖关系。Shelved 保持未结案及原 Stage，结案前须先解除搁置。

## 服务端流程与持久保全

结案先校验任务身份、版本、请求 ID 与现有 PDV 门禁，持久保存操作和实际行动者，再停止所属 Agent、协作会话及详情终端。服务端在停止前保存所有已知活体 PID，确认退出后才捕获 Git 状态。

归档复用独立任务的 Git 工作状态快照，保留独有 HEAD、恢复所需对象包、原始 index、staged／unstaged／untracked 内容、文件校验值和权限。独有 HEAD 另建 `refs/kanban/task-closure-archives/.../head` 持久引用。ignored 文件默认不保留，选定报告或目录必须显式加入保全清单。

服务端在操作目录的隔离工作树实际还原，比较 HEAD、index、路径、内容与权限，同步归档文件及各层目录后再次核对来源。持久化失败仍按保全失败处理，保留原列和工作树。公开 `deleteWorktree` 也要求同一操作的已验证归档凭据；物理删除前再次检查身份、操作资格、来源漂移及归档本体的可恢复性。载荷损坏且来源仍匹配原快照时自动重新保全；无法证明来源一致时保留目录。

会话启动、终端重启、详情终端启动与结案共用跨进程生命周期锁。拿锁后重新读取任务状态；已结案任务须通过重开流程先恢复成果。停止操作本身不受启动门禁阻塞。

持久根目录为 `~/.cline/kanban/task-closure-preserved-artifacts/<完整任务身份的 SHA-256>/<操作 UUID>/`，包含 `operation.json`、每次保全尝试的快照和对象包。结案／更正／重开记录另有不可覆盖的历史文件，并由原有只追加任务变更账本保存服务端摘要及进度的变更。

写入成果前将本功能的根目录、任务目录和操作目录限制为 `0700`，操作及历史 JSON 使用 `0600`，不改变共享 runtime 目录权限。恢复时保留原文件权限。历史镜像中断时，历史查询及后续任务动作先从持久摘要补齐记录，避免更正、重开或删卡覆盖唯一补证来源。

卡片的 `taskClosureSummary` 和 `taskClosureOperationProgress` 为服务端字段。旧客户端整板保存不能覆盖记录、绕过结案／重开边界、通过删卡绕过保全，或用同 ID 重建任务继承旧清理资格。

## 失败、中断与恢复

| 情况 | 保留与自动恢复行为 |
| --- | --- |
| 归档或退出确认失败 | 保持原列、原工作树，显示具体缺口；每轮归档最多三次尝试 |
| 来源在验证后变化 | 不删除；清空本次失效验证状态，待来源稳定后重新捕获 |
| 结案后清理失败 | 保留结案结果及“清理待恢复”，继续使用原操作补完 |
| 更正结案结果 | 只追加结果；保留原归档，原操作仍可继续未完成清理 |
| 取消、重开或身份变化 | 原操作清理资格失效，不允许旧请求继续删除 |
| 重开恢复过程中中断 | 先在操作专属目录完整还原和校验，再移回任务路径；未完成的还原工作树可重建 |
| 恢复后已有新工作 | 拒绝覆盖，保留新工作与归档，记录待恢复原因 |
| 永久删卡过程中失败 | 持久保存“永久删除”原动作，重启后继续删除，不误转成结案 |

运行时恢复监视器每 15 秒检查一次。每代运行时或机器可检测条件变化只消费一次恢复预算，持久保存最后探测指纹。条件包含来源 Git 状态、选定成果、可用空间、待退进程、任务身份与版本、工具目录状态；条件无变化时不无限重试。单条坏操作记录会记录诊断，不阻塞其他任务恢复；针对该身份的读取仍如实报错。

重开先撤销未完成清理，再从归档还原，沿用既有会话恢复流程，成功后追加重开历史。重复请求复用同一稳定 ID，冲突内容拒绝；旧结案请求不能在重开后复活。归档不随重开或永久删卡自动删除。

重开前的操作失效不影响重开后新授权的结案或永久删除；恢复仍核验该操作绑定的任务身份与版本。相同结案请求 ID 的评论、PDV 原因或落点等行为参数发生变化时返回冲突，不能静默执行首次保存的旧内容。

## UI、CLI 与 API

主看板、Focus View、详情、搜索及跨项目视图显示结案结果。统一表单包含结果、原因、授权、承接任务、证据、已接受成果与额外保全路径；拖放、卡片动作和 PDV 面板结案均进入该流程。历史补记／更正隐藏额外归档路径，不重新执行清理；无法取得的历史成果标为不可用。现有筛选框架新增结案结果维度。

CLI 的 `task close` 是既有 `task trash` 的别名，`task done` 继续兼容。示例中的项目路径必须指向主仓库：

```sh
kanban task close --task-id abc12 --project-path /path/to/main-repository \
  --outcome plan_retired --reason '剩余方向已由后继方案替代' \
  --evidence '调查报告与用户确认记录' --preserve-path reports/accepted.md \
  --request-id 11111111-1111-4111-8111-111111111111

kanban task close --task-id abc12 --project-path /path/to/main-repository \
  --outcome delivery_accepted --evidence '用户验收记录' --correct-existing

kanban task closure-history --task-id abc12 --project-path /path/to/main-repository
kanban task cancel-closure --task-id abc12 --project-path /path/to/main-repository
kanban task list --project-path /path/to/main-repository --closure-outcome plan_retired
```

`--accepted-deliverables-file` 接受含 `description`、`evidence` 的 JSON 数组。`--successor-workspace-id` 与 `--successor-task-id` 会读取并绑定承接 incarnation；`--authorization-source` 记录用户取消的授权来源。删卡后查询历史可显式提供 `--incarnation-created-at`。

单独提供 `--preserve-path`、证据或成果清单也会创建结构化结案请求；没有指定结果时仍记为“结案结果未标注”。只指定承接工作区而未指定承接任务时明确报错。合法的大写 UUID 与小写 UUID 均可被持久操作和历史扫描识别。

既有 `taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree` 接受 `closure` 并返回记录及进度。新增 `readTaskClosureHistory`、`correctTaskClosureOutcome`、`cancelTaskClosureOperation`；查询历史不启动会话或创建工作树。旧 API 不传结果时记录“未标注”，不推断为验收通过。

## 部署前验证

根项目通过 guarded 测试与调用仓库 mutation canary；真实 Git 用例使用隔离 fixture。端到端运行时使用打包代码、隔离 HOME／Codex 存储与无外网 fake Agent，不触碰真实任务及关系账本。

最终通过根项目 11 个文件／274 项测试，完整 Web 套件 307 个文件／3182 项测试；Node 22 兼容组 5 个文件／17 项测试亦通过。根及 Web 类型检查、Biome 与差异空白检查通过。

验证覆盖六类结果及必填项、部分交付、承接完整身份、历史补记、更正和重开、旧整板保存、请求去重／冲突、停止失败保留 PID、并发启动门禁、公开删除门禁、归档失败跨运行时重启接续、永久删除恢复，以及结案与 PDV 的独立边界。

Git 恢复用例覆盖 detached 独有提交、分开的暂存和未暂存内容、二进制、删除、重命名、符号链接、执行位、显式 ignored 报告、清理及 Git GC 后恢复、半恢复工作树重建，以及拒绝覆盖后来的新工作。Playwright 在 1280px／390px 验证共享卡片双宿主、统一表单、部分成果、历史、无横向溢出和未水合项目 PDV 表单的取消行为。

构建前已将本任务 `dist`、`web-ui/dist` 与主仓库共享产物隔离，构建显式设置本任务输出目录。最终测试计数、构建与检查日志保存在同目录的 `closure-*-output.log`，最终核验摘要见 `verification-results.json`。

## 部署后验证注册

已按 `cline-kanban-post-deploy-verification-authoring` 技能注册定义，只注册，不部署、勾选、运行正式验证或移动任务。

| 行为 | 部署前已证 | 真实安装实例待验 | 类型 |
| --- | --- | --- | --- |
| 结果校验、保全、恢复和并发门禁 | 单元／隔离 Git／打包运行时已覆盖 | 无新增人工核验要求 | 不重复注册 |
| 表单、共享宿主、移动端、PDV 接线 | Web 测试和 Playwright 已覆盖 | 无新增人工核验要求 | 不重复注册 |
| 安装实例的运行时代码与实际前端资源一致 | 本任务独立构建可验证打包行为 | 正在提供服务的实例是否同时包含已结案列、历史查询接口和前端契约 | `automated_script` |

- verificationId：`28a151ed-17c1-44e1-88ce-640d1f18a315`。
- label：已安装运行实例的结案查询接口与前端资源一致。
- assetsDir：`/Users/bominzhang/.cline/kanban/verifications/28a151ed-17c1-44e1-88ce-640d1f18a315`。
- 入口：`verify-installed-task-closure-contract.mjs`，`node`，超时 30 秒；只读 HTTP，不修改任务或核对状态。
- cleanup：`automatic`，无仓库插桩。旧实例 dry-run 如预期返回非零：尚无新列名、历史 procedure 和前端契约；没有崩溃、超时或残留。
- `verification list` 自查：本任务 1 条同 ID 定义；部署 `record` 后预计挂载 1 条 automated、0 条 guided。

兜底清理命令只清理这条部署后验证的资产和定义，不清理任务成果归档：

```sh
kanban verification cleanup --verification-id 28a151ed-17c1-44e1-88ce-640d1f18a315
rg 'KANBAN-VERIFICATION-SCOPED:28a151ed-17c1-44e1-88ce-640d1f18a315' src web-ui/src
```

第二条预期无匹配：本实现未引入临时仓库插桩。

## 边界与风险

归档会持续占用磁盘。无法完整快照或验证的工作树必须保留，没有跳过保全的清理入口。选定 ignored 成果必须显式声明；普通 ignored 缓存不归档。

不包含 D 组批量退役、`024c5` 的危险越过 token 和整列原子化、`dd2db` 的需求覆盖宣告、提交、同步或部署。当前真实安装实例仍是旧版本，部署后的同源资源断言尚待核验；本次没有把它记录为已通过。
