# 非模态填写浮窗与跨页面编辑会话

独立填写窗共用 `NonModalFloatingFormWindow` 与页面级 `NonModalFloatingFormWindowHostProvider`。用户可以在填写时操作、滚动和复制背景信息；切换任务或项目后，已打开窗口继续存在。此保证覆盖当前页面会话，刷新后的恢复仍沿用各表单原有能力。

## 窗口交互与层级

展开保留各表单原有宽度上限。标题栏显示用途和打开时的归属，支持拖动、收起、展开与关闭。收起后的宽度最多 320px，只隐藏正文和底栏，不卸载字段、附件控件或业务组件；选区、正文滚动和校验状态留在原节点上。再次展开恢复输入焦点；收起期间拖动后，从新位置展开。

窗口根据 `visualViewport` 的尺寸及偏移约束位置和高度，监听窗口缩放、旋转及软键盘引起的可视区域变化。布局约束由 portal 内的挂载节点安装，避免在父布局 effect 中过早读取未挂载的 Radix portal，也避免在 Radix 合成 ref 回调中发布状态导致更新循环。

背景视图最高为 z40，普通浮窗为 z44，当前激活浮窗为 z45，已有模态确认、菜单与提示继续使用其更高层级。关联卡片的只读预览使用 z45，随后打开的填写窗位于它之上；填写窗交互不关闭源预览，预览也不被误判为模态确认。打开新窗口时适度错开位置；点击或聚焦窗口将其置前。Focus View 的展开视图在存在浮窗时暂停自身焦点捕获，PDV 面板也降到填写窗之下。

快捷键按 DOM 包含关系判断归属，不能沿 React Portal 的组件树误触宿主表单。收起内容不能快捷提交，背景 Escape 不关闭填写窗，IME Escape 交给输入法。模态确认存在时，表单不接管其提交与 Escape。

填写窗按 Radix 的 `FocusScope → DismissableLayer → 正文` 顺序加入原生层级栈，但不提供外部点击关闭动作。这样下层 Popover 的 document 捕获监听不会提前消费填写窗的 Escape，上层确认框与选择器仍保留优先级；该顺序也有嵌套确认框的浏览器回归。该依赖在原锁文件中已作为 Radix 的传递依赖存在，现在显式声明为 Web UI 的直接依赖。

## 常驻实例与归属

`NonModalFloatingFormWindowHostProvider` 位于 `App` 的稳定 provider 层，覆盖项目导航及连接失败页面。入口调用 `openWindow` 或通过 `hostNonModalFloatingForm` 登记请求，宿主持有实际表单及其 controller。入口卸载、背景项目变化或源控制器重置均不关闭窗口。

窗口键由表单种类及业务对象身份组成。任务键包含 workspace、task、incarnation；会话和 Finding 还包含来源身份。任务创建与全局设置各保持一个编辑会话，设置始终绑定首次打开的项目。重复打开只展开、置前并聚焦已有窗口，不替换其 render 快照或覆盖草稿。不同对象可以同时填写。

每次实际开窗分配独立实例 token。关闭及迟到结果只能结算所属 token，不能关闭同一对象后来重开的窗口。重复唤起时更新入口关闭通知，但保留原业务快照，兼顾草稿存续与当前入口状态同步。

每次显式打开都携带新的请求序号、请求对象或 token。背景 props 的身份变化不代表一次打开，持续为 true 的布尔状态也不能代替新的打开请求。置顶、Finding、关系、带参数重启及各结案入口都遵循这一约定；同一世任务的结案请求保留评论和幂等 ID，不同 workspace、task 或 incarnation 的请求可并存。看板结案核对在动作发起时捕获 workspace 和看板快照，迟到响应不再读取当前背景项目来补归属。

任务编辑器的打开请求身份独立于异步回调使用的会话失效标记。关闭与重置只能使旧回调失效，不能发布新的打开请求；否则异步收尾期间可能先读到新身份、后读到关闭状态，让宿主在关闭后又创建空白窗口。

关闭时只在焦点仍属于该窗口时归还焦点，不抢走用户已移到背景的焦点。卡片按钮可能阻止默认聚焦，入口可显式传入实际触发元素；保存导致按钮被替换时，回落到打开时捕获且仍挂载的可聚焦祖先。关系预览的全局 Escape 捕获也必须让开预览外正在填写的浮窗。

任务编辑器的入口 `useTaskEditor` 使用 `isTaskEditorOpeningRequestOnlyController`，仅提供打开请求；窗口内另建真正的编辑 controller，复用原字段、提交与持久草稿协议。入口不能与实际窗口对同一草稿键同时去抖写入，也不能在导航或关闭入口时删除窗口已保存的草稿。

## 迁移范围

| 类别 | 常驻填写窗 |
| --- | --- |
| 任务 | 创建与编辑、评论、置顶原因、Finding、添加关系 |
| 会话 | 创建侧会话、主会话交接、分出独立任务、带参数重启 |
| 结案 | 结案核对、结案填写、未验证原因、结果修正 |
| 项目与设置 | 添加／初始化／克隆项目、项目标识、脚本快捷方式、设置、问题反馈、引导配置 |

只共享窗口与生命周期；字段和业务 controller 仍由各表单维护。纯确认、检索、只读历史、目录选择、解锁门禁和内联编辑保留原形态；停维护的 Cline 专属表单沿用现状。

## 保存、失败与重试

保存始终使用打开时固定的目标。评论、任务编辑、关系、置顶、会话来源和结案沿用原有身份门禁；必要时提交前重新读取绑定的任务与 incarnation。来源无法读取或身份失效时显示错误，保留输入和重试入口，不转向当前背景对象。带参数重启捕获具体 terminal 及运行实例，提交时再次核对实例代次。

快捷方式提交前读取原项目的最新列表再追加，避免打开窗口后后台新增项被旧快照覆盖。结案继续使用现有服务端 Done 门禁及 PDV token 协议，不直接写 `verifiedAt`。每个结案实例保存已完成移列的回执，核对确认失败后的重试只补确认。不同任务的结案填写请求独立等待，同一世任务复用原请求。

设置保存不提交未改动的快捷方式列表。PDV 面板核对窗固定原部署，保留已选结案内容、核对原因和确认 token；移列响应未知时沿用原命令的幂等恢复，已确认移列成功后只补确认。带参数重启在任一端缺少会话代次时保留参数并阻止执行。

窗口关闭后仍可能完成已接受的请求，迟到结果只能影响原实例。新增窗口存续不提供通用服务端草稿库，也不扩展提交、同步或部署授权。

## 验证入口

- `non-modal-floating-form-window-host-provider.test.tsx`：入口卸载与重挂、重复唤起、不同对象并存、旧关闭通知隔离。
- `retained-post-deploy-verification-review-session.test.tsx`：核对导航、补充结案及提交保持原 workspace、task 和 incarnation。
- `complete-task-closure-from-bound-floating-form.test.ts`：确认要求变化时阻止提交，确认重试不重复移列。
- `post-deploy-verification-task-closure-form-request.test.ts`：多任务并行等待、同对象去重及精确结算。
- `non-modal-floating-form-retained-object-entrypoints.test.tsx`：置顶、Finding 和带参数重启再次打开时恢复原节点与草稿。
- `use-task-comment-before-move-into-done.test.tsx`：同一世任务重复唤起及不同 workspace、task、incarnation 的独立请求。
- `use-post-deploy-verification-done-entry-closure-dialog-for-board-moves-into-done.test.tsx`：A 的迟到核对请求在背景 B 中仍绑定原项目快照。
- `use-task-editor.test.tsx`：打开请求控制器不能覆盖或删除真正窗口的持久草稿。
- `use-shortcut-actions.test.tsx`：跨项目后保存原项目并保留最新快捷方式。
- `playwright.non-modal-floating-form-windows-isolated.config.ts`：桌面／320px 手机、附件、选区、滚动、拖动、旋转、软键盘可视区域、模态边界、展开视图、真实任务编辑器与 Finding 跨项目保存。接口受控隔离，不写真实项目。
- `playwright.task-editor-isolated.config.ts`：原任务编辑器创建／编辑与项目归属回归。

独立浮窗的浏览器截图和测试结果写入仓库外：优先使用 `KANBAN_TASK_CROSS_TASK_HANDOFF_ARTIFACT_DIRECTORY`，未设置时使用 `~/.cline/kanban/browser-test-artifacts/`；配置文件路径的哈希用于区分工作树。一次性验证的隔离 HOME、源码副本与完整构建分发也应直接放在任务的持久交接目录，不再创建仓库内的 `.cache` 或占位软链。

真实运行实例的项目导航、实时更新及设备键盘叠放另由本任务注册的 PDV 观察项承接，不把隔离浏览器通过记为部署后已核验。
