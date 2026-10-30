# 常规表单的主要操作提交快捷键

macOS 使用 `Command+Enter`，Windows/Linux 使用 `Ctrl+Enter`，触发当前表单的主要保存或提交动作。两种组合键都可识别，按钮提示和 `aria-keyshortcuts` 随平台显示。

## 覆盖与边界

| 区域 | 已接入入口 |
| --- | --- |
| 任务卡 | 便签新增/编辑、评论新增/编辑、置顶原因、任务创建/编辑及批量创建 |
| 工作台 | Finding 保存、查卡问题、回答 Agent 问题、创建会话、主会话交接、分出独立任务、问题反馈 |
| 关系与结案 | 关系详情加入草稿、保存关系变更、添加关系、结案信息、未验证原因 |
| 项目与设置 | 添加项目、初始化 Git、克隆项目、项目图标与颜色、运行时设置 |
| 原生表单 | 路径导航、解锁表单 |
| 会话调试 | Codex 带参数重启弹窗 |

Prompt/Command 库保留自动保存，并在编辑区域消费提交组合键。删除确认、终端输入和停维护的 Cline 专属表单没有新增适配。没有新增快捷键配置、依赖或后端协议。

新接入入口只处理不带 `Shift` / `Alt` 的提交组合键。任务编辑器原有的 `Mod+Shift+Enter` 和 `Alt+Shift+Enter` 保留。普通 `Enter` 继续换行；原生单行表单保留原生提交，目录补全的普通 `Enter` 继续选中候选。

## 接入约定

`web-ui/src/hooks/use-form-primary-action-submit-keyboard-shortcut.ts` 提供 `useFormPrimaryActionSubmitKeyboardShortcut({ onSubmit, disabled })` 与 `FORM_PRIMARY_ACTION_SUBMIT_SHORTCUT_BUTTON_PROPS`。

- 将返回的处理器绑定在表单边界的冒泡阶段 `onKeyDown`，与按钮复用同一业务入口和禁用条件；通用 `Dialog` 支持透传此事件。
- 表单校验、只读限制、图片准备和提交状态继续由业务入口负责。共享处理器也尊重父级禁用的 `fieldset`，并等待异步入口完成后释放快捷提交锁；错误展示与失败重试沿用原入口。
- 组字中的事件不取消浏览器默认动作，也不提交。`repeat`、禁用态、已被子控件消费的事件以及 Portal 外部 DOM 的事件不提交，提交组合键不会继续触发外层表单或 Diff 动作。
- 嵌套表单优先处理。关系详情只加入草稿或消费自动保存详情的按键；保存关系仍须独立提交。已有身份校验、页面 nonce 和审计特征继续保留，传递原始事件，不能用脚本 `.click()` 模拟可信手势。
- `TaskPromptComposer` 仅在有匹配回调时自行提交；没有回调时交给宿主，并避开候选补全。图片准备期间就地消费组合键。自动保存区域由宿主消费，不新增显式保存。

## 自动化验证

| 验证入口 | 证明的行为 |
| --- | --- |
| `use-form-primary-action-submit-keyboard-shortcut.test.tsx` | 组合键、IME 与 legacy keyCode、长按、异步锁、禁用 fieldset、嵌套优先及 Portal 隔离 |
| `use-task-card-stickers.test.tsx` | 便签新增/编辑的快捷保存、失败草稿保留及重试 |
| `task-comments-panel.test.tsx` | 当前评论新增/编辑，保留自动保存语义 |
| `runtime-settings-dialog.test.tsx` | 两种组合键统一保存，失败保留密钥草稿后重试 |
| `passcode-gate.test.tsx`、`remote-file-browser-dialog.test.tsx` | 原生提交校验、请求锁、失败重试及路径导航不触发外层选择 |
| `task-prompt-composer-submit-keyboard-shortcut.test.tsx` | 无回调时冒泡、有回调时消费、图片准备门禁 |
| `agent-session-restart-with-additional-startup-arguments-dialog.test.tsx` | 两种提交组合键复用参数解析、普通 Enter 与组字不重启 |
| `task-editor-dialog.interaction.test.tsx` | 原有快捷动作继续生效，组字事件不穿透到 document 快捷键 |
| `work-unit-relation-asserted-relations-and-add-reference-relation-dialog.test.tsx` | 点击与键盘复用端点校验，原始事件不丢失 |
| `tests/form-primary-action-submit-keyboard-shortcut.spec.ts` | Chromium 真实键盘、CDP 真实组字、长按、Portal 与 Diff 共存、项目添加、嵌套关系和可信事件 |

浏览器测试拦截全部 API，关系写入不连接真实 HOME 的只追加账本。它们证明组件和传输载荷的行为；部署后实际主看板与 Focus View 的挂载、真实保存及重新打开后的回显另由本任务的部署后验证观察。
