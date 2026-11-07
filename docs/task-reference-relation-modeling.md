# 任务参照关系的人工建模与多跳预览

创建单个任务、Backlog 编辑和 Focus View 共用 `ReferenceRelationModelingEditor`。Focus View 扩展既有右侧 Relations Section：原列表、快捷添加和静音功能保留，通过「关系图与建模」进入图形编辑；手机沿用 Sessions 页中的同一入口。图形编辑打开时隐藏外层快捷添加，避免重复入口。

## 用户操作与保存边界

- 搜索所有 project 中的现有任务，选择后立即加入待保存列表。默认使用 `reference_is_generally_related_with`（普通关联）。创建、Backlog 编辑、Focus View 和快捷添加共用「本 Task：标题 → 关系及方向 → 已有 Task：project / ID / 标题」阅读顺序，方向直接并入选项，左右端点不交换；手机按相同顺序换行。无向关系以连接线和「无方向」标明。详情收起后列表仍保留完整陈述。
- 图默认展示两跳，可切换一至三跳。记录型关系和有效断言都参与双向邻域遍历，边仍保留原陈述方向；连通路径不代表新的直接关系。最多 150 个节点、300 条边，超过时显示截断提示。
- 可修改当前任务直接相连的参照关系，或以「自然结束／关系有误」撤销。系统记录型关系只读，保留在原摘要中静音的能力。
- Focus View 显式点击「保存关系变更」才落账。待保存关系的详情与方向随编辑进入草稿，收起后仍参与提交；修改已保存关系仍需先暂存详情或取消。无效字段保留错误并阻止提交。剪贴板候选只作预选，不采纳不会产生关系，也不会阻塞创建。
- 成功保存时消费本次关系草稿不算用户修改；保存期间后来填写的正文、新增关系、撤销和无效详情仍保留，并阻止误关闭或继续启动。
- 创建时先保存卡片，再原子保存关系，最后启动 agent 或关闭对话框。失败保留卡片快照和原 ID；刷新当前标签页后可恢复并重试，不再次分配任务 ID。已永久删除或 incarnation 已变化的卡片不能被恢复为新卡。

草稿以项目、当前任务或创建入口、浏览器标签页身份隔离。浏览器镜像用于即时恢复，运行时将草稿写入 workspace 的 `reference-relation-modeling-editor-drafts.json`，通过锁与原子替换保存。不同标签页各自独立；新标签页不会自动发现其他标签页的草稿。


## 关系语义与兼容

新建关系可选择以下六种语义，理由、证据与专有详情均可省略：

| kind | 本 Task 为主语 | 本 Task 为锚点 |
| --- | --- | --- |
| `reference_fixes_defects_in_produced_outputs_of` | 修复其交付物 → | ← 交付物由其修复 |
| `reference_diagnoses_agent_execution_trajectory_of` | 诊断其 Trajectory → | ← Trajectory 由其诊断 |
| `reference_reuses_produced_outputs_of` | 复用其产物 → | ← 产物被其复用 |
| `reference_requirement_originates_from` | 需求源自 → | ← 其需求源自本 Task |
| `reference_is_cross_repository_counterpart_with` | 跨 project 对应（无方向） | 同一选项 |
| `reference_is_generally_related_with` | 普通关联（无方向，默认） | 同一选项 |

修复关系只声明修复对方实现、文档等交付物的工作对象，不证明已经完成修复。Trajectory 诊断只针对 Agent 的执行过程；具体 Session 或片段可以放入现有证据位置，没有新增必填字段。CLI 自动从注册表提供 `--fixes-defects-in-produced-outputs-of` 和 `--diagnoses-agent-execution-trajectory-of`，邻域摘要与图使用同一方向。

历史 `reference_concerns_behavior_or_state_of` 和 `reference_verifies_claims_of` 继续读写，旧关系与草稿不自动转换；只有当前编辑的旧 kind 才出现在其选项里。AI 建议中的 `concernNature=checks_scope_overlap_with` 明确标为「工作范围重叠」，不会替换成 Trajectory 诊断。普通 Code Review、核验框架、Subagent 和 Peer Session 不新增关系类型。

「跨 project 对应」沿用已有持久化 kind。同 project 或对端当前归属未知时禁用，显示「仅限不同 project」。以本 Task 的目标 project 和对方当前 project 判断资格，单条与批量写入共用校验；canonical identity 继续用于身份、自指和自然键去重。目标 project、对端或草稿恢复发生变化时重新校验，失效选择保留并阻止新提交，用户修正或移除后再保存。

已落账批量提交的指纹回执在当前资格校验之前读取，同内容的幂等重放不因之后的项目迁移而失效；新的提交仍按当前归属校验。原子保存、版本冲突和创建受理后的冻结身份继续复用原机制。

## Relations 原地展开完整任务卡片

关系摘要的记录型、断言型任务引用与图节点共用「悬停约 200ms 预览、键盘焦点立即预览、点击或触屏点按固定」交互。固定后悬停或移焦不切换卡片，点击其他任务可切换；关闭按钮或 Esc 取消展开。宽容器在右侧展示，窄容器在下方展示，卡片区域独立滚动。切换预览不重挂关系图，不改变手工视口或关系编辑草稿。

`RelatedTaskPreviewFullTaskCard` 接收完整任务引用和仓库路径，继续复用 `TaskCardBody` 的预览专用 render role、快照缓存与业务动作。只有当前预览卡片会加载快照和 Git 元数据。创建时间贯穿读取、评论、操作及导航；迟到响应被丢弃，同 ID 重建返回明确错误。由预览发起的关系表单在解析对端时也核对原创建时间。根任务和多跳任务可预览；虚拟创建根、独立会话、墓碑及不可用项目只显示原因，Done 卡沿用原动作门禁。

卡片内操作或焦点交互会固定预览。模态框 Portal 打开期间不切换卡片，关闭后焦点回到发起控件；Esc 先由模态框或行内编辑消费，再关闭卡片预览，最后退出前台 Relations。模态框判定允许承载编辑器的祖先 Dialog，并排除显式声明 `aria-modal=false` 的非模态任务浮窗，收起的浮窗也不阻挡背景预览。行内编辑在 window 捕获阶段先保留 Esc，祖先浮窗尊重 `defaultPrevented`，事件仍会到达输入框自身的取消处理器。

「打开任务」保留独立入口，并携带创建时间走既有跨项目导航。前台导航的 `dismissForTaskNavigation()` 同步清除展开层 URL 和归属，不调用异步 `history.back()`，防止旧来源页覆盖目标任务。普通「返回」仍使用原历史返回语义。

## 账本写入

Web UI 专用单条写入与建模草稿允许省略类型和理由，分别规范化为普通关联与空字符串，证据和专有属性保持空集合，不编造信息；空理由不渲染说明行。服务端按通过来源核验的 proposer 决定完整性，Agent／CLI 仍要求理由及对应类型的必需属性，不接受客户端自报放宽资格。字段格式、类型归属、自指、跨 project 对应、自然键与身份门禁继续生效。

`workUnit.applyReferenceRelationModelingChangesDirectlyAsWebUiUser` 复用既有真实用户手势与页面 nonce 校验。整批检查关系版本及自然键，任何冲突都不写入。修改是撤销旧断言、创建替代断言，保存完整历史；理由、证据和属性是替换值，不与旧证据自动取并集。仅修改其他字段时保留未改写主张的核验结论。

`modelingSubmissionId` 与提交内容指纹共同保证未知网络结果后的幂等重试。同 ID、同内容返回 `alreadyApplied`；同 ID、不同内容报冲突。SQLite 事务同时更新当前态、必要的拒绝抑制墓碑并追加 `reference_relation_modeling_changes_applied_by_web_ui_user` 事件；读侧可从该事件重放关系状态。

## 项目级建议服务的接入缝

截至本任务实现时，`a0401` 负责设计项目任务索引与关系分诊 support agent，仍未实现；`9cc01` 是任务意图与回复 recap 的上游工作，`049a5` 涉及分诊交互。`ac29f` 已交付既有账本、Relations 摘要及快捷添加，是本实现的基础。

`workUnit.suggestReferenceRelationsForTaskModeling` 当前明确返回 `availability: unavailable`、原因及空候选，界面显示尚未启用。本任务未实现索引、模型调用或建议引擎。

未来接入时复用 `src/core/work-unit-relation-modeling-api-contract.ts`：请求包括当前任务或虚拟创建根、跳数与待保存变更；响应包括可用状态、`contextAsOf`、`contextCompleteness`，以及带理由、证据和限定端点引用的候选。候选必须由用户选择进入草稿，随后走人工保存流程；不能把候选直接写成有效关系。图谱预览不是项目任务索引的替代品。

## 验证

纯函数测试覆盖循环、有界多跳、方向、自指、重复及过期版本。账本集成验证修改、幂等、并发冲突、非可信手势拒绝和事件投影一致性；前端测试覆盖草稿恢复、坏镜像回退、跨项目及异步保存时切换任务。

HOME 隔离浏览器脚手架由 `KANBAN_RUN_ISOLATED_REFERENCE_RELATION_MODELING_BROWSER_CHECK=1` 启用，覆盖原 Relations 入口、三跳图、修改、手机布局、创建失败后刷新重试以及关系落账后才发出启动请求。它仅使用自己创建的临时 runtime、账本、项目和端口，不连接真实实例造测试关系。

原地完整卡片的浏览器测试使用 `npm --prefix web-ui run e2e -- --config playwright.relations-task-card-preview-isolated.config.ts`，覆盖真实卡片、评论与确认框 Provider、桌面与手机、键盘与触屏、重试、同 ID 重建、草稿与视口保留、跨项目导航；全部 API 和 WebSocket 在测试浏览器中隔离拦截，不写真实看板或关系账本。

新增打包态关系与方向验收可设置 `KANBAN_TASK_RELATION_OPTIONS_PACKAGED_CLI_PATH` 与持久的 `KANBAN_TASK_RELATION_OPTIONS_BROWSER_EVIDENCE_DIRECTORY`，运行 guarded 的 `task-reference-relation-options-and-direction-real-browser.integration.test.ts`。它隔离 HOME、Codex 配置、项目与 runtime，覆盖创建、Backlog、Focus、快捷添加、键盘、手机布局及响应丢失重试，逐项核对实际账本端点。
