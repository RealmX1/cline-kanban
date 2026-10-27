# Codex 配置审批与发起者追踪实施合同

用户已批准本会话提供的实施计划。目标是修正来源摘要误报、先审批后修改未来看板默认、提供可持久收起的批量交互，以及只读诊断证据。

本轮不改变插件安装生命周期，不做插件缓存物理隔离，不写回用户全局配置，不自动同步现有会话。旧版已经采用的默认值保持原样，原始观测和历史事实保留。

## 可独立验证的交付切片

1. 设置提案与来源观测分离：两次切换、十个观测位置、三个 hook 归并为一条来源提示；旧版迁移不制造新审批。
2. 服务端审批与批量动作：审批前默认不变，通过、拒绝、稍后分别建模；版本、幂等、来源和信任门禁覆盖所有入口；部分失败继续有效项。
3. 通知与管理页：独立分类、多选与筛选、持久收起、键盘和手机布局；只为实际变化显示方向，不把检测位置称为修改者。
4. 启动基础诊断与独立追踪脚本：请求用途与身份、只读文件摘要、macOS eslogger 实际写入事件、覆盖缺口及重启恢复。

## 验证与边界

使用受保护的根测试入口、Web UI 测试、两套 typecheck、Biome、隔离输出构建和隔离浏览器实例。诊断测试同时隔离 HOME、CODEX_HOME、CODEX_SQLITE_HOME，证明观察器不改变目标文件。系统级 eslogger 权限不可用时保留待验事实，不宣称查明实际写入者。

实施结束登记部署后真实实例验证；提交、远端推送和部署遵循本任务已有授权及仓库约定。

## 2026-10-27 续接计划

用户明确要求吸收最新本地 main，并读取持久交接后更新计划。技术输入来自 `/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/codex-directory-identity-commit-deploy-20261027/922cc-followup-assessment/922cc-continuation-handoff.md`；它提供调查事实与接缝建议，本身不增加提交、push 或部署授权。

已按单向同步流程吸收固定本地 main `ea3c04aaeef1186de9ae951716dbd63577f1c062`，原 detached HEAD 为 `8cbf352c46054a43fcfa7221ce806148f9fb4705`。23 个 tracked 修改和 11 个 untracked 文件已恢复，四个重叠路径自动合并；保护引用已精确清理，boundary verifier 与 bootstrap receipt 通过，锁已释放。同步原始证据保存于 `/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/task-922cc-local-main-absorption-20261027/absorption-state.json`。

后续按以下顺序推进，无需重新批准原实施范围：

1. **先修身份与锁接缝。** 审批使用 `resolveVerifiedCodexConfigurationSourceIdentity(source.home, store, change.sourceIdentity)`，保持已恢复的旧来源键。批量审批、冲突审批、目标同步和诊断归属验证分别审计；所需 source / history / SQLite 卷观察先在全局 store 锁外补齐，锁内重读并核验实际目录、清单、桥接与定义。退休 writer 和 source-only 记录按各自资格处理，不能只依赖 observe 的活跃 writer 集合。
2. **保留两侧状态契约。** 保留 main 的完整异步禁系统查询作用域、历史身份与持久挂载观察、显式及推定 parent 来源、canonical marker 原子发布与 durable retry；保留本任务 schema 1→2 的提案、来源观测、历史、targets、receipts 与失败事实。不能合并同物理路径下不同历史来源，也不能重算旧 manifest。
3. **补组合回归。** 覆盖设备号变化后旧来源提案获批及未来 writer 采用、来源 A/B 的 parent 保持、退休 / source-only / 不同卷目标、慢或失败卷查询与可靠来源并发、预取后真实目录或设备节点替换、迁移不丢历史与恢复证据。机器补证不足保留未知及恢复条件，不创建额外设置审批。
4. **完成原交付并重新核验。** 重跑配置与并发测试、诊断只读与跨重启测试、原生 Full Access 新 thread 继承及只读 fork、两套 typecheck、Biome 和隔离构建。当前工具权限已变化，重新尝试打包态桌面 / 手机 / 键盘 / 收起持久性浏览器测试，不沿用上次启动故障作为当前不可行证明。
5. **收尾证据与部署后验证。** 核对并幂等登记 PDV，保留系统 eslogger 权限缺失时的真实未知。当前 `rvf-history` 为 partial，历史完成与候选覆盖均为 unknown，不能据此断言没做过或已覆盖；需要 RVF 时绑定新的精确组合候选，不复用其他任务或旧 HEAD 的结果。

同步只完成 Git 边界，语义整合和新组合的验证仍在进行。旧 HEAD 的构建与旧 API 子集记录不代表本次组合已验证，也不能直接覆盖当前运行实例。

## 合并态实施与验证结果

本轮已完成身份与锁接缝整合，以及原计划的通知、审批和诊断交付。审批核验旧来源身份，退休 writer 单独预取卷观察，source-only 不依赖退休桥接；诊断补证使用独立上下文，业务连接不等待系统查询。

合并后的相关验证共 146 项通过：108 项运行时单测、9 项界面测试、27 项原生 Codex／连接／追踪集成测试，以及 2 项打包态 API／浏览器测试。打包态浏览器实际覆盖桌面、手机、键盘、刷新与新通知下保持收起，以及选择和阅读位置恢复。两套类型检查、Biome、差异空白检查和独立输出构建通过。追踪脚本另经失败再修复验证：无效证据目录位于目标缓存内时，拒绝发生在任何目录创建之前。

已注册 4 项持久 PDV（1 项自动、3 项真实界面或会话观察）。自动脚本在旧实例上清晰报告 schemaVersion 2 尚未部署，在隔离的新打包实例上通过。当前非 root 环境没有执行系统级实际写入者采集；只证明降级、归一化及未知状态保留。权限继承的原生实验确认了一条可复现机制，不据此断言所有历史会话异常都由同一路径造成。

提交、push、部署和移入 Done 均未执行。当前 RVF 历史完成与候选覆盖查询仍为 unknown；实现验证不冒充审查或部署后通过。持久证据、PDV 定义与清理入口位于 `/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/task-922cc-codex-configuration-approval-and-tracing/`。
