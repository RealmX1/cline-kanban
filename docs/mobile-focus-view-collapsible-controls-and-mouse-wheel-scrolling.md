# 手机聚焦视图的独立折叠与滚轮操作

手机断点沿用 `use-is-mobile.ts`（≤768px）。桌面不进入本控制链路。

## 交互与所有权

上方导航与工具、Task Card 详情、下方虚拟按键栏是三个独立展开状态。手动操作任何一处都不能展开或收起另外两处。初次进入及切换项目或主任务时默认展开；30 秒无用户操作后共同收起。收起时保留返回、任务标题与阶段摘要、上方工具入口，以及右下角滚轮与下方按键入口。

`use-mobile-focus-view-collapsible-controls.ts` 管理上下工具状态并复用既有 `use-mobile-focus-view-idle-collapse-controller.ts`。App 中唯一有效的计时器覆盖全局顶栏和详情；独立挂载 CardDetailView 时才启用其本地控制器。Task Card 仍管理自己的展开状态，只消费同一收起通知。组件靠隐藏工具区域保留 agent、当前页签及草稿；虚拟按键栏本身可卸载。

编辑可折叠区域中的输入、选择文字和打开弹窗会暂停收起。任务卡快捷菜单经 Portal 展开时也暂停：菜单带 `data-mobile-focus-view-idle-collapse-suspension`，控制器按其 `data-state="open"` 判断，避免菜单打开后卡体被闲置收起。长按滚轮每一步记录真实用户活动；Agent 输出和程序化 `scroll` 不续期。手机根布局跟随 `visualViewport.height`，使软键盘出现后的常驻按钮仍位于可视区内。

PTY 面板的工具和阅读模式头部共用上方状态；ACP 对话面板的通道工具也跟随该状态，消息与 composer 不折叠。

## 滚轮与长按

`TerminalController.scrollByMouseWheelLines` 向当前 xterm 屏幕中心派发有方向和行单位的滚轮事件，由 xterm 自己决定滚历史、发送鼠标报告或处理 alternate buffer。它不把滚动按钮直接当作方向键。阅读模式通过 Virtuoso 的当前滚动容器滚动，不向背后的 TUI 发输入。

Chrome 的合成 WheelEvent 中旧式 `wheelDeltaY` 与标准 `deltaY` 的符号和单位不一致。xterm 6 的普通历史滚动优先读取旧字段，先除以 120，再乘以固定 50 CSS 像素及 `scrollSensitivity`。投递时按当前渲染器的实际行高和滚动敏感度反向换算 `wheelDeltaY` / `wheelDelta`，并按相邻行的整数像素边界抵消每次取整，避免小数行高下连续操作逐步漂移。DOM 渲染器从屏幕总高度均分行高，WebGL 则用画布设备像素和 DPR，避开屏幕 CSS 总高度取整。标准 `deltaY` 仍为 3 行，鼠标协议与 alternate buffer 保持原生分流。真实浏览器回归必须直接检查普通历史的每步 `viewportY` 差值，并同时覆盖 SGR 鼠标协议；单测看到 `deltaY` 正确不足以证明用户按约定滚动。

`use-accelerating-mouse-wheel-scroll-press.ts` 只服务滚轮按钮，既有虚拟方向键保持固定连发规则：

- 按下立即投递一个 3 行步长；400ms 内不连发。
- 从 400ms 开始，以每秒 8 次为基础，在随后 2 秒线性提速至每秒 24 次，之后保持上限。
- 通过增加重复频率加速，避免只扩大单次 delta 对某些 TUI 无效。
- 捕获指针后允许手指轻微移出键面；捕获失败则离开即停止。
- 抬手、取消、捕获丢失、失焦、页面隐藏、目标会话或显示模式切换、控件卸载立即清理计时器；不补发积压事件，每次按压重新低速起步。
- 指针后的 click 不重复投递；键盘和读屏的零 detail 激活保留。

## 验证入口

- Web UI 单测覆盖加速曲线、上限、停止条件、独立展开、闲置暂停及控制器滚轮投递。
- `web-ui/tests/mobile-focus-view-collapsible-controls.spec.ts` 使用真实 CardDetailView、AgentTerminalPanel 和 xterm；只替换 HTTP / WebSocket 对端，不连接真实运行时。
- 浏览器覆盖 320 / 375 / 390 / 768px、桌面、长按超过 30 秒、SGR 上下滚轮、不同小数行高下连续点击与长按每步三行、alternate buffer、阅读视图和软键盘可视窗口变化。
- 真机触感、Safari 原生触摸取消及部署后 bundle 生效通过任务登记的 Post-Deploy Verification 补验。
