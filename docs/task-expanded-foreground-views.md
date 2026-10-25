# 任务内容的前台展开视图

任务可视化、探索地图和 Relations 共用 `web-ui/src/expanded-foreground-view/` 的导航与宿主。展开占满应用视口，保留浏览器工具栏；首次展开新增一条浏览器历史，前台内切换内容或 Relations 中心替换这一条记录。返回、Esc 或浏览器后退收回；前进重新展开。直接访问的链接返回所属任务。

## 内容身份与返回

`ExpandedForegroundViewTarget` 包含内容类型、workspaceId、taskId 与 taskIncarnationCreatedAtEpochMs；可视化额外保存产物 ID 和阅读中的修订。独立 `expanded*` 参数与来源页面的项目路径、`task` 参数并存，所以跨项目查看图谱不会切换来源工作台。链接不包含内容凭据、原生会话身份或宿主文件路径。

`onOpenRelationsVisualizationForTask` 接收被预览卡片的完整限定引用。App 将它交给共享导航控制器，Relations 读取使用 `kanban_board_card_by_qualified_reference`。墓碑可作为历史根读取；未知一世明确失败，不替换为同 ID 的当前卡片。创建、编辑、图谱遍历和关系保存继续使用原领域 API。

## 生命周期与扩展

功能面板通过 `useExpandedForegroundViewSurface(target)` 和 `ExpandedForegroundViewSurface` 接入。`CardDetailView` 在手机与桌面间复用同一棵 Agent 与工作台内容树，`TaskWorkbench` 只切换格位布局、手机模块分组与可见性；展开或跨断点收回不移动内容 DOM，不切换 portal 容器，也不改变 iframe、ReactFlow 的 key 或控制器。跨断点时把活动内容交接给当前布局的手机页签或桌面格位，保留同一 iframe、`contentWindow` 与阅读状态。来源卸载或身份变化后，导航保留原完整目标并恢复独立宿主。

新增内容类型时，在 target、独立内容宿主与工作台模块映射中注册该类型，提供领域读取与明确操作。共享层只处理 URL、显示、焦点和返回，不调用建模、付费维护或 agent 启动。

Radix FocusScope 管理焦点。前台禁用祖先链外的背景兄弟，内层对话框与菜单继续使用现有 portal。键盘事件在前台内处理，内层弹层先关闭。可视化的 Esc 经内容消息桥请求收回，宿主核对当前 iframe、opaque origin、产物归属、修订与随机证明；它不会授予 HTML 宿主权限。切到其他前台视图只暂停自动预览资格，手动阅读的 iframe 保留。

## 恢复与成本

刷新恢复任务、内容类型、可视化版本及既有关系草稿；图谱缩放、滚动和轮次展开只保留于当前页面。草稿沿用原来的 workspace、task、浏览器标签页作用域。限定根先读取账本身份，确认是当前有效一世后才应用已有草稿；历史根不叠加或回写当前草稿。空草稿的只读进入不会发起保存。

临时读取故障最多自动退避两次，随后显示失败；网络恢复、页面重新可见和运行时重连可触发补读。切换目标取消旧请求并忽略迟到结果。探索地图沿用免费的投影读取；独立地图在可见时补读，维护仍只由「立即维护」显式点击触发，Done 继续禁止执行。

## 验证

- 导航与恢复：`npm run web:test -- src/expanded-foreground-view`。
- 领域回归：可视化自动投递、iframe 证明、关系草稿恢复、图编辑与地图推送测试。
- 完整身份：`npm run test:guarded -- --project precommit-safe test/runtime/inter-work-unit-relation-ledger/qualified-task-relation-read-selector.test.ts`。
- 浏览器：`npm --prefix web-ui run e2e -- tests/expanded-foreground-view.spec.ts tests/desktop-focus-view-task-workbench.spec.ts --workers=1`。所有 API 在隔离页面中拦截，不对真实关系账本造数据。

浏览器用例检查同一 iframe 的状态和加载次数、图谱视口、未暂存表单、浮层焦点交接、跨项目刷新定位、手机轮次展开及付费维护调用数。构建前需隔离 `dist` 与 `web-ui/dist`，并显式指定 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY`。
