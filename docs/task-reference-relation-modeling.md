# 任务参照关系的人工建模与多跳预览

创建单个任务和 Focus View 共用 `ReferenceRelationModelingEditor`。Focus View 扩展既有右侧 Relations Section：原列表、快捷添加和静音功能保留，通过「关系图与建模」进入图形编辑；手机沿用 Sessions 页中的同一入口。图形编辑打开时隐藏外层快捷添加，避免重复入口。

## 用户操作与保存边界

- 搜索所有项目中的现有任务，选择六种参照关系之一，填写理由、证据和专有属性，再加入草稿。非对称关系可选陈述方向，对称关系没有单向箭头。
- 图默认展示两跳，可切换一至三跳。记录型关系和有效断言都参与双向邻域遍历，边仍保留原陈述方向；连通路径不代表新的直接关系。最多 150 个节点、300 条边，超过时显示截断提示。
- 可修改当前任务直接相连的参照关系，或以「自然结束／关系有误」撤销。系统记录型关系只读，保留在原摘要中静音的能力。
- Focus View 显式点击「保存关系变更」才落账。未暂存的关系表单必须先加入草稿或取消，防止提交时遗漏。
- 创建时先保存卡片，再原子保存关系，最后启动 agent 或关闭对话框。失败保留卡片快照和原 ID；刷新当前标签页后可恢复并重试，不再次分配任务 ID。已永久删除或 incarnation 已变化的卡片不能被恢复为新卡。

草稿以项目、当前任务或创建入口、浏览器标签页身份隔离。浏览器镜像用于即时恢复，运行时将草稿写入 workspace 的 `reference-relation-modeling-editor-drafts.json`，通过锁与原子替换保存。不同标签页各自独立；新标签页不会自动发现其他标签页的草稿。

## 账本写入

`workUnit.applyReferenceRelationModelingChangesDirectlyAsWebUiUser` 复用既有真实用户手势与页面 nonce 校验。整批检查关系版本及自然键，任何冲突都不写入。修改是撤销旧断言、创建替代断言，保存完整历史；理由、证据和属性是替换值，不与旧证据自动取并集。仅修改其他字段时保留未改写主张的核验结论。

`modelingSubmissionId` 与提交内容指纹共同保证未知网络结果后的幂等重试。同 ID、同内容返回 `alreadyApplied`；同 ID、不同内容报冲突。SQLite 事务同时更新当前态、必要的拒绝抑制墓碑并追加 `reference_relation_modeling_changes_applied_by_web_ui_user` 事件；读侧可从该事件重放关系状态。

## 项目级建议服务的接入缝

截至本任务实现时，`a0401` 负责设计项目任务索引与关系分诊 support agent，仍未实现；`9cc01` 是任务意图与回复 recap 的上游工作，`049a5` 涉及分诊交互。`ac29f` 已交付既有账本、Relations 摘要及快捷添加，是本实现的基础。

`workUnit.suggestReferenceRelationsForTaskModeling` 当前明确返回 `availability: unavailable`、原因及空候选，界面显示尚未启用。本任务未实现索引、模型调用或建议引擎。

未来接入时复用 `src/core/work-unit-relation-modeling-api-contract.ts`：请求包括当前任务或虚拟创建根、跳数与待保存变更；响应包括可用状态、`contextAsOf`、`contextCompleteness`，以及带理由、证据和限定端点引用的候选。候选必须由用户选择进入草稿，随后走人工保存流程；不能把候选直接写成有效关系。图谱预览不是项目任务索引的替代品。

## 验证

纯函数测试覆盖循环、有界多跳、方向、自指、重复及过期版本。账本集成验证修改、幂等、并发冲突、非可信手势拒绝和事件投影一致性；前端测试覆盖草稿恢复、坏镜像回退、跨项目及异步保存时切换任务。

HOME 隔离浏览器脚手架由 `KANBAN_RUN_ISOLATED_REFERENCE_RELATION_MODELING_BROWSER_CHECK=1` 启用，覆盖原 Relations 入口、三跳图、修改、手机布局、创建失败后刷新重试以及关系落账后才发出启动请求。它仅使用自己创建的临时 runtime、账本、项目和端口，不连接真实实例造测试关系。
