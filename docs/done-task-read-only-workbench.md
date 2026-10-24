# Done Task 的完整工作台与只读历史

Done 的内部列 ID 为 `trash`。选中卡体仍打开统一的 `CardDetailView`，保持原列，不恢复 agent，不重建工作树。
桌面、手机、主看板与 Focus View 共用此语义。继续执行必须先使用显式的「恢复任务」。

## 工作台资产与执行操作

Prompts、Commands、Sessions、Queue、Relations、Findings、探索地图继续使用原有数据源。
Prompts 按所选会话读取，主会话交接和侧会话的 ID 仍归属于宿主卡片，不能误标为已删除任务的资产。
Findings 按所选会话的 provenance 过滤，显示条件不依赖实时聊天 turn 投影。
日志缺失、身份无法确认或工作树已删除，都不阻断这些面板。

Done 禁止聊天发送、打开任务终端、新建会话、主会话交接、分出独立任务、填入输入框、Queue 重新投递/重启确认、Diff 发送及探索地图维护。
历史队列仍可展开、取消和整理；Prompt 与 finding 等资产的原有管理操作保留。
浏览不会自动确认运行时重启后的待投递 Queue。

## 只读会话历史

`runtime.getTaskConversationHistoryPage` 是 workspace 范围的 query，输入显式包含卡片与会话 ID。
服务端先校验持久会话对卡片的归属，再读取持久化的 `agentNativeConversationSessionIdentity`。
它不调用终端管理器、启动 SDK host、解析执行 cwd 或创建工作树。

- 支持 Claude、Codex、OMP 的可信原生 JSONL；ACP 可回退到当前运行实例已经保留的结构化消息，并标记历史可能不完整。
- 原生文件内容必须与持久身份匹配；Codex 的后台记忆/审查作业不能冒充主会话。
- 最新页优先，约 100 条消息一页，同一原生记录内的内容不拆页；保留用户、回答、工具及可读推理正文。
- Claude/OMP 沿最新有效父链读取；Codex 沿 `history_base` 的父段字节截点分页，排除被回退的另一分支，并去除重复 envelope。
- 文件读取按 LF 字节边界进行，Unicode U+2028/U+2029 不作为换行；单次扫描和单条记录均有上限。
- 分页标记绑定来源身份、文件版本、分段和分支位置。文件变化要求刷新，前端不拼接另一份记录；切换卡片、会话或项目时丢弃迟到响应。

`available`、`partially_available`、`unavailable` 区分可读、部分可读和不可读；不可读必须带提示，不能伪装成空会话。
目前附件仅显示存在图片/文件的提示，不恢复原生附件预览；缺失或不支持的持久格式也不会触发扫描猜测或启动进程来补齐。

## 验证入口

- 根单测：`test/runtime/agent-session-history/task-conversation-history-page.test.ts` 与 `test/runtime/trpc/runtime-api.test.ts`。
- HOME、Git、关系账本与进程隔离的真实 HTTP 测试：`test/integration/done-task-read-only-history-through-packaged-runtime.integration.test.ts`。
- 桌面/手机浏览器：`web-ui/tests/done-task-complete-workbench.spec.ts`，使用真实工作台组件和隔离的查询回执，断言没有写请求与终端连接。
- 实际部署的数据和界面仍需 Post-Deploy Verification；部署前测试不能代替真实实例的通过记录。
