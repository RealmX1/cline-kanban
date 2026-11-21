---
name: cline-kanban-local-deploy
description: Project-local workflow for safely deploying this Cline Kanban running instance from an already-present local source checkout while preserving runtime state, task metadata, worktrees, dirty diffs, CLI links, PATH, and agent detection. Use in this project when asked to deploy locally, rebuild, relink, reinstall, restart, or switch the running local instance to code that is already in this checkout (the "local deploy"). Do not use for fetching, rebasing, cherry-picking, or taking new code from official upstream; use this project's cline-kanban-upstream-update skill for official source integration first.
---

# Cline Kanban 本地部署

日常部署按同一次执行推进。选定本地完整提交，准备并启动标准执行，最后读取该执行的结果。

## 授权与候选

- 用户主动要求执行本 skill、部署或重启本机 Kanban，即可按本次明确范围准备和启动。修改本 skill 或批准实现方案只授权相应实现。Agent 发起生产部署须先取得匹配目标、候选和影响的本次用户授权；普通继续、交接文本和自动投递不产生部署授权。
- Agent 默认不主动请求生产重部署。只有紧急故障阻塞全部既有工作，且修复已审阅、验证并进入本地 `main` 后，才可考虑请求。
- 默认用已存在的本地提交，核对来源工作区、实际服务 Node、canonical runner、目标运行目录和当前运行版本。保留源码 WIP；候选由执行器独立检出。官方上游集成使用 `cline-kanban-upstream-update`。
- 已授权 local deploy 覆盖范围内的必要修复和本地部署分支提交。显式 Stop 与禁止提交、同步、推送或部署的限制继续有效。

## 启动标准执行

1. 读取[标准请求与恢复合同](../../../docs/local-redeployment-standard-entry-and-offline-recovery.md)及[会话连续性要求](references/kanban-runtime-upgrades.md)。为本次执行分配 UUID，准备持久执行目录和请求 JSON，其中保留用户授权原话和来源。已知上游原件时按[验证证据交接](references/source-validation-evidence-reuse.md)填入 `sourceValidationEvidenceFilePaths`。
   已获准中断无法跨重启保留的会话时，在请求中登记 `nonPreservableSessionInterruptionAuthorization`。等待期间获得授权时，使用同一冻结执行器的 `authorize-redeployment-session-interruption` 追加该证据。
2. 用实际服务 Node 调用已经打包的执行器。准备冻结请求、归属与工具；启动交给所属命令执行或既有独立 supervisor。

   ```sh
   "$DEPLOYMENT_NODE" "$INSTALLED_DEPLOYMENT_EXECUTOR" prepare-redeployment \
     --execution-directory "$EXECUTION_DIRECTORY" --request-file "$REQUEST_FILE"
   "$DEPLOYMENT_NODE" "$INSTALLED_DEPLOYMENT_EXECUTOR" start-redeployment \
     --execution-directory "$EXECUTION_DIRECTORY"
   ```

3. 用会话绑定的 Kanban CLI 读取同一执行。目录指向本轮已冻结、可跨重启读取的材料。

   ```sh
   "$KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH" deployment analyze --execution-directory "$EXECUTION_DIRECTORY"
   ```

   从准备起可看本次候选及验证复用数。会话暂不可交接时，私有候选可继续验证和构建，状态保全等待门禁。可恢复缺口由 supervisor 按条件接续；同目录的 `start-redeployment` 复用原执行，显式取消使用 `cancel-redeployment`。历史执行继续读取其原件，并由其冻结工具接续。

## 处理结果

- 质量失败保留原件。在原授权内于 `deployment-repair/<taskId>-<来源执行短ID>` 修复、验证并提交，再带 `--repair-of-execution-directory` 和 `--deployment-branch` 准备新候选。同一授权最多三次修复候选；其他接续均使用原执行目录。
- 运行验收后，登记用同一 `executionId` 补齐 marker、PDV 组和回执。执行器核对已有登记效果，清理、任务备注和终审交回的结果单独记录。默认只清理本次登记且确认退出的可重建暂存与失败副本；保留候选、原件和检查点。需要保留现场时用冻结执行器的 `set-redeployment-cleanup --automatic-cleanup disabled --inspection-reason …`。
- 用本次登记回执汇报当前服务版本、上次到本次的已部署 commit、上线任务和 PDV 计数。旧提交对象不可读时保留两端 SHA；反向区间非空时单列回退。缺失的历史统计保持未知。完成后读原执行终审材料并固化轻量复盘。详见[执行与复盘合同](../../../docs/local-deployment-execution-and-retrospective.md)。
