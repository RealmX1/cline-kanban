# 持久多轮查卡与工作台

本功能由 `3346b` 承接，包含 `7a1dd` 的 Search 需求。共享 Context、材料采集与 headless 执行器来自 `a0401`；本功能不生成另一套 recap 或索引。

## 界面与任务身份

顶栏“AI 查卡”在现有工作台切换显示模式。已有 FocusTask 时保留左侧任务导航，中部和右侧切换为查卡内容；原任务界面保持挂载并隐藏，不停止任务进程。没有 FocusTask 时也能进入。Search 的“AI 查卡”传入描述、项目和列范围，通过同一查询服务提交第一轮。

点候选只预览，不修改 FocusTask。右侧默认两格为“查询会话”和“候选详情”，另可选择检索范围与共享执行器设置。点“打开任务”使用现有跨项目任务导航；再次进入查卡继续原会话。格位与大小偏好独立于任务工作台，横屏左右、竖屏上下，手机通过页签访问。

查卡会话不属于被检索任务，也不进入其 Sessions、worktree、facet 或关系生命周期。它是 runtime 持有的逻辑会话，底层每次模型请求仍是无状态 headless 调用。

## 查询与证据

每轮先用查卡专用指令及共享 L1–L3 召回候选，再在 L4 补全这些候选当前要求，生成多个候选及匹配原因、证据与局限。完整历史参与后续查询；范围限制由服务端核对。所有候选使用 workspaceId、taskId、incarnation 的限定身份，返回前再次读取并核对要求与所在列，拒绝检索期间失效的身份或材料。

零候选是成功结果；认证失败、模型失败、输入超预算、取消与中断分别留档，不映射为空结果。输入预算沿用共享执行器，超限不静默裁掉历史或要求。列位置、摘要与 Agent 自述不等于实现、合入或部署证明。查询不写被检索任务、关系或任务状态。

## API 与持久化

`support` 新增 `createTaskLookupConversation`、`listTaskLookupConversations`、`getTaskLookupConversation`、`submitTaskLookupTurn`、`cancelTaskLookupTurn` 和 `readTaskLookupCandidatePreview`。契约在 `src/core/task-lookup-conversation-contract.ts`，查询服务在 `src/task-indexing-support/task-lookup-conversation-service.ts`。

会话保存在 runtime home 的 `task-lookup-conversations/<conversationId>.json`；实际 L0–L4 输入另存于同名目录，避免可覆盖 Context 缓存破坏历史证据。文件原子写入，单会话写入加锁；requestId 防止重复模型调用，同一会话同时只运行一轮。轮次变化在写盘后经全局 `task_lookup_conversation_updated` 推送，浏览器重连后重新读取，无浏览器轮询。关闭面板不取消查询。

新轮次持久保存 `owningRuntimeProcessInstanceId`。恢复仅中断所属实例已失活的轮次，沿用进程实例心跳的两分钟宽限期；新实例启动和读取历史不能中断仍存活的其他实例。缺少归属、心跳损坏或读取失败时保留运行状态并给出说明，不把未知状态称为重启。服务每 30 秒复核遗留轮次，同时转发共享历史的新 revision。runtime 关闭只取消本实例正在执行的轮次；取消也覆盖材料读取和 Context 准备。所有异步写回再次核对轮次状态与归属，重试只能由用户显式发起。

## 进度与失败诊断

运行阶段为读取材料、准备 Context、召回候选、解释候选、核验要求和保存结果。轮次保存阶段起点、最近真实活动、执行器设置、输入字节数与限长时间线；模型事件只提供活动摘要，不展示输入材料或推理正文。活动合并后每秒至多落盘一次，阶段切换与终态立即落盘；保留最近 200 条并计数说明省略量。超过 60 秒没有新活动只提示仍在等待，每次模型调用继续使用 180 秒时限。

失败、取消与中断均保留停止阶段和原因码；执行器失败补充退出码、信号及脱敏限长的错误详情。所有状态都可展开检索记录和复制诊断，复制内容包含会话、轮次、请求与 runtime 身份，不含完整问题、任务材料或结果正文。请求模型与实际返回的模型身份分别展示，未返回的身份不能用请求别名补齐。旧历史缺少诊断时明确标为未记录。

浏览器按会话与 revision 合并更新，进度推流只重读当前相关会话，不重复读取整份历史。迟到的提交、取消和读取响应不能覆盖更高 revision；提交错误和各读取入口的错误独立保留。

执行器沿用 Context 项目共享设置，界面显示影响范围。模型用量单列用途 `task_lookup_conversation`；不宣称无状态进程能够命中缓存。Claude 认证状态与缓存验收沿用上游交接的未核实边界。

## 验证

- guarded 服务测试：多轮、重复提交、范围验证、空结果与失败区分、取消、重启恢复和损坏历史。
- HOME 隔离 HTTP 集成：真实 tRPC、共享材料/Context、headless 桩、候选预览、重建服务后历史一致与原任务不变。
- Playwright：真实 Search 入口、查卡界面、多候选预览与打开、多轮和重载、手机与竖屏。
- `.plan/scripts/verify-task-lookup-conversation-codex.mts`：真实 Codex 小型隔离材料查询；结果与实际输入写入持久交接目录，不触碰真实任务。

自动化结果、构建和部署后验证分别记录；源码实现和隔离验证不代表已经部署。
