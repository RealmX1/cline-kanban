# Task 的外部工作流 Run 引用

Task 可显式绑定一个外部工作流 Run。外部 Plugin 拥有业务图、数据库、阶段资格与 Stop；Kanban 只保存归属齐全的引用和最近一次显式发布的只读观察。普通 Task 不会自动采用任何外部工作流，查看引用不会启动 Agent、创建 Run 或调用外部数据库。

## 公共 CLI

```bash
"$KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH" task external-workflow bind \
  --project-path <项目主仓库绝对路径> --request-file <持久请求JSON>

"$KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH" task external-workflow get \
  --project-path <项目主仓库绝对路径> --task-id <任务身份>
```

`bind` 请求示例：

```json
{
  "taskId": "task-id",
  "expectedTaskIncarnationCreatedAtEpochMs": 123456789,
  "externalWorkflowRunBinding": {
    "workflowProviderId": "software-factory",
    "workflowKind": "delivery_planning",
    "workItemId": "work-item-id",
    "runId": "run-id",
    "workflowDatabasePath": "/persistent/software-factory-workflows.sqlite",
    "artifactDirectoryPath": "/persistent/work-item-artifacts",
    "lastObservedState": {
      "observedAtEpochMs": 123456790,
      "availability": "observed",
      "businessStage": "planning",
      "executionQualification": "stage_work_required",
      "waitingReason": null,
      "materialFilePaths": ["/persistent/work-item-artifacts/plan.md"]
    }
  }
}
```

`lastObservedState` 可缺省，其余引用字段必填。观察中的三个状态文字允许 `null`，材料可为空数组。Plugin 不可达时显式发布 `availability="unavailable"`；界面显示 `unknown`，不把附带的历史阶段文字冒充当前状态。只有最近记录与观察时间，没有后台刷新承诺。

CLI 将解析出的 workspace ID 与任务 ID、代次写入 `owningWorkspaceId/owningTaskId/owningTaskIncarnationCreatedAtEpochMs`，再经已有 `taskCardAction.updateTaskCardFieldValues` 和 board 持久化漏斗保存。服务端在最新 board 锁内核对全部归属；API 直接调用者同样必须提供精确代次。读入口返回 `bindingAvailability=unbound|bound|ownership_mismatch` 和原引用，归属不符不会自动重绑。

首次绑定后不能替换 Run、Work Item、数据库路径或产物目录。相同引用可发布新的观察，时间必须单调；同时间的相同观察可重放，同时间改内容、倒序或清除已存观察均拒绝。这样不能以换 Run 绕过原 Stop 或机器待证。新一轮流程和 Task 迁移后的引用切换尚无自动接口，需后续明确设计，当前拒绝静默切换。

整板 `workspace.saveState` 不拥有引用写入权：服务端在 board 锁内按任务 ID 与代次保留当前引用及观察，忽略整板请求中的删除、替换或观察更新；未绑定或新建卡也不能经此入口注入引用。旧页面的普通看板编辑仍可保存，首次绑定与后续观察发布统一走显式字段更新入口。

## 展示与继续

主看板与 Focus View 使用同一个卡片组件，均显示可展开的外部流程引用：最近阶段、等待原因、观察时间、材料路径及复制原 Run 信息。复制只写剪贴板，路径是引用，不会转换为任意命令执行。

继续前由所属 Plugin 查询原数据库的当前事实和资格；Kanban 投影、聊天结束或卡片所在列都不能替代这一判断。引用随 Task 的持久 board 保存，重启后仍保留。浏览器水合必须带过该字段，避免整板保存丢失。
