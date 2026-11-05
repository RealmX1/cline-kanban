# 新任务在 Running 中的启动进度

用户在任务 `5913b` 中批准实施《改善新任务在 All Projects Running 中的出现延迟》方案。目标是保存确认后即可看见启动进度，并减少同次启动内重复的远端 revision 查询。

## 实现合同

- 能力：共享创建编辑器的同项目、跨项目、连续和批量创建均通过持久提交记录投影启动进度；首页、Focus View、CLI 共用归属。
- 范围：可选契约字段 `taskEditorCreationAgentStartupProgress`、身份核对、分组与排序、独立计数、状态广播、事务内 revision 复用、启动分段诊断。
- 边界：不改变 session facet 真相、不把准备写为 live、不取消跨次启动的真实更新检查、不承诺消除全部启动耗时；不提交、同步或部署。
- 门禁：已确认保存且请求启动；项目、任务 ID 和创建时间匹配；真实会话优先，Stop、搁置、删除和换世不能重获启动资格；缺证继续呈现核验状态。
- 验收：阻塞启动 60 秒时仍可见；受控环境保存确认后一秒内可见；真实启动后标签切换、无重复、计数一致；恢复与失败不伪造成功。

## 验证切片

1. 持久状态到 Running 的完整链路：先证明分组失败，再补投影、广播、两种 UI 呈现与回归。
2. 来源锁内 revision 查询复用：同 URL/ref 只探测一次；事实变化失效，跨事务重新探测，失败保持未知。
3. 分段诊断与隔离端到端：记录 worktree、配置绑定、插件锁、原生操作、revision、checkpoint 耗时；构建输出隔离后运行打包实例与 Playwright，注册部署后断言。

影响面：`api-contract`、创建提交 contract/store/service、workspace registry 与跨项目投影、Running 分组、共享分区和任务行、插件协调器、启动诊断及相应测试。

## 实现结果

- 创建提交继续作为持久真相源；新增跨项目条目的可选启动进度，不新增执行状态机或伪造 live。状态 schema 单独放置，避免 API 契约与创建请求契约循环依赖。
- 保存确认、启动准备和等待阶段变化立即触发项目广播；真实会话状态边沿绕过普通输出的一秒合并窗口。目录指纹缓存共享读取，完成记录不随每次状态变化反复解析。
- Running 中实际运行任务在前，启动准备按受理时间排在后面；首页与 Focus View 共用标签、独立计数和等待文案，CLI 复用同一分组。悬浮展开保留原行高度，并将可见状态移到浮层。
- 每次来源锁内复用同 URL/ref 的 revision 探测，未知结果也只探测一次；来源变更或原生安装改变事实后清空，跨次启动重新探测。无法核验 revision 时保持 `ready_with_pending_native_update` 和恢复条件。
- 诊断增加 `phaseDurationMs`，分别记录 worktree、配置绑定、来源锁等待、原生 marketplace 更新、插件安装、revision 查询与 checkpoint。Codex 阶段附运行时代际 ID。

## 后续提交与本地 base 整合

用户后续明确授权 `commit and $base-branch-sync`。初次实现以 `9f5bcf5f23` 提交，提交前 499 个测试文件、6,520 项测试通过；下面的初次交付记录保留其原验证时点。

吸收固定本地 base 时，保留新引入的创建设置冻结、独立 Codex reasoning effort 和本任务的状态通知、阶段计时及两侧回归。创建状态 schema 随 `resolvedSettings` 统一到 `api-contract`，创建请求契约继续转出，避免双份 schema 丢弃冻结设置或产生循环依赖；跨项目广播序列化有对应回归。

同步工具故障的原件、固定快照恢复、当前整合验证与实际落地结果分别保存在本任务持久验证资产目录的 `authorized-commit-and-base-branch-sync-20261104/`；不把历史 RVF 完成事实替代整合后的验证。

## 初次交付自动化验证

| 检查 | 结果 |
| --- | --- |
| 运行时、分组、持久恢复、广播、启动 API 与 CLI 相关测试 | 387 项通过 |
| 共享编辑器、首页、Focus View 与状态流前端测试 | 145 项通过；最终悬浮修改后相关 74 项再验通过 |
| 使用真实 Codex binary 和隔离本地 Git 来源的插件集成 | 5 项通过 |
| Playwright 打包实例端到端 | 1 项完整场景通过，仓库 mutation canary 通过 |
| 根项目和 Web UI 类型检查 | 通过 |
| 变更文件 Biome、`git diff --check` | 通过 |
| 输出隔离后的完整构建 | 通过 |

端到端覆盖：启动阻塞 60 秒、保存即关闭、后台观察页推流、跨项目与批量启动、仅建 Backlog、响应丢失去重、页面重连、运行时重启恢复、等待状态、悬浮行高，以及实际 PTY 进程出现后的标签移除、独立计数和去重。PTY 使用隔离的合成 CLI，不调用真实模型；插件测试使用实际 Codex 与本地 Git fixture。

本轮观测：保存确认后 **2 ms** 完成可见性检查；启动准备实际阻塞 **60002 ms**，期间任务保持可见。这里的起点是编辑器确认保存并关闭，不是服务端最早写盘时刻，也不代表所有机器的一秒保证。浏览器 `pageErrors=[]`。

真实 Git trace 验证同次启动重复插件 revision 查询只执行一次，后续启动重新核验；插件来源 revision、URL/ref 改变及断网恢复均有覆盖。另有真实集成确认 revision 未知不会写成更新成功，来源恢复后可自动重验。

验证时先隔离了 `dist` 与 `web-ui/dist`，并显式设置 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY`。主仓库共享产物未改动。共享依赖中的 thread-graph 与锁定 commit 不一致，已在任务专用 `node_modules` 中从锁定 commit 重建；未修改依赖声明或锁文件。类型检查使用 Node 22；打包和运行实例测试使用与现存原生 SQLite ABI 一致的 Node 24，未重编主仓库共享依赖。

## 部署后验证

| 行为 | 部署前已证 | 真实实例待观察 | 类型 |
| --- | --- | --- | --- |
| 身份、Stop、搁置、换世与恢复资格 | 运行时和分组测试 | 无新增纯逻辑断言 | 不重复注册 |
| revision 复用、失效、未知与恢复 | 真实 Codex + 本地 Git 集成 | 无新增纯逻辑断言 | 不重复注册 |
| 真实任务的准备可见性、计数与进程接管 | 隔离打包实例和合成 PTY 已验证 | 部署后的真实 Agent、自定义配置及日常浏览器环境 | guided_manual，供自然使用观察与人工兜底 |

已调用 `cline-kanban-post-deploy-verification-authoring` 注册 1 项，`verification list` 自查 `count=1`。尚未部署、执行或勾选；不把隔离测试写成真实实例通过。部署记录建立后预计挂载 automated_script 0 项、guided_manual 1 项。

- verificationId：`584dee02-5a85-4a70-a0a4-8c0698445462`
- label：新任务保存后在 All Projects Running 展示启动进度，进程就绪后正确切换且计数一致
- assetsDir：`/Users/bominzhang/.cline/kanban/verifications/584dee02-5a85-4a70-a0a4-8c0698445462`
- cleanup.mode：`automatic`；无仓库插桩，无 automated script，故无需脚本 dry-run。
- 兜底清理：`kanban verification cleanup --verification-id 584dee02-5a85-4a70-a0a4-8c0698445462`

注册定义、浏览器指标、最终截图与测试日志已另存上述持久资产目录。源码内没有 `KANBAN-VERIFICATION-SCOPED` 插桩。

## 限制与交付边界

本次先消除准备期间的展示空窗并去掉重复查询，不承诺消除所有实际启动耗时。初次实现交付时未跑全仓所有测试，也未提交或同步 base；后续授权与提交见上节。部署后真实 Agent 仍待观察，相关断言已注册；没有部署或移列。

