# 统一 Task 与侧会话创建实施合同

用户在本轮明确要求实施已给出的方案；该方案作为 PLAN-READY 实施合同。

- 能力：Task、Backlog 编辑、Peer、By the way 共用非模态创建工作台及启动设置控件；侧会话保留独立身份、宿主目录、角色与生命周期限制。
- 范围：独立 Plan 偏好、默认全部允许、角色只读门禁、模型与上下文正交、来源回执、CLI 显式 Plan、名称与持久草稿、原请求恢复。
- 不包含：侧会话探索模式、完整 orchestration、全局检索、部署、Git 提交和同步。
- 验收：缺 Plan 的 CLI 零创建；显式 false 保留；fork 实际应用模型；名称回填保护手改与身份；刷新/重启复用原提交；Stop 阻止恢复启动；桌面与手机自动化覆盖。
- 主要影响：api-contract、创建设置解析、conversation-session service/store、runtime-api、harness adapters、TaskEditorDialog、Sessions、界面偏好和命名服务。
- 风险：旧记录兼容、异步模型与名称结果、响应丢失、角色权限和跨项目提交身份。
- 验证：根和 Web 类型检查、guarded 定向回归、Web 单测、隔离 Playwright、隔离构建；真实 harness 断言登记 PDV。

实施按三段验证：启动设置与 CLI；持久命名和提交；共享工作台与浏览器回归。
