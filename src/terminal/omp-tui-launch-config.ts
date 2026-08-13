// Kanban 托管的 omp 设置 overlay：每次启动 omp TUI 会话前落一份文件，用 `--config <path>` 传给它。
//
// 为什么用 overlay 而不是改用户的 `~/.omp`：这些取值是「Kanban 托管会话」这个语境的要求，不是用户
// 的偏好。写进用户全局设置会把它们泄漏到用户自己在终端里跑的 omp 上。overlay 只对本次启动生效，
// 用户的项目级 / 全局设置照常参与合并（omp 的 Settings 按层 deepMerge，overlay 优先级最高）。
//
// 文件格式：omp 用 YAML.parse 读 overlay，且**要求是 mapping**；键路径按设置 id 的点号拆成嵌套结构
//（`tui.titleState` → `{tui: {titleState: …}}`，见 settings.ts 的 SETTING_PATH_SEGMENTS）。
// JSON 是 YAML 1.2 的严格子集，所以这里直接写 JSON —— 免得为了产出几个键引入一个 YAML 序列化依赖。
// 注意 omp 对 `--config` 用的是**严格**加载器：文件缺失或格式错是硬报错，不会静默回落。
import { join } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";

export interface OmpTuiLaunchConfigOverlayInput {
	// 本次启动是否要以 plan 模式开局。仅**首次**启动（非续跑）传 true：续跑时用户已在对话中途，
	// omp 自己的会话记录里就存着当前模式，重新按 plan 起步会把它按回去。
	startInPlanMode: boolean;
}

export interface OmpTuiLaunchConfigOverlay {
	configFilePath: string;
	// 落盘的 overlay 内容（测试与诊断读它，避免为断言去解析文件）。
	overlaySettings: Record<string, unknown>;
}

// omp 的大粘贴菜单默认在 100 行触发（`paste.largeMenuThreshold`）：达到阈值就弹一个三选一
// （包成代码块 / 包成 XML 标签 / 存成文件）并**挂住会话等人选**。Kanban 的 task-chat 与 RVF 都走
// bracketed paste 做程序化投递，长文本极常见，这个菜单会把投递永久卡在那里。0 = 关掉菜单
//（大粘贴仍会折叠成 [Paste] 标记，只是不再拦人）。
const OMP_PASTE_LARGE_MENU_THRESHOLD_DISABLED = 0;

export function buildOmpTuiLaunchConfigOverlaySettings(input: OmpTuiLaunchConfigOverlayInput): Record<string, unknown> {
	return {
		paste: {
			largeMenuThreshold: OMP_PASTE_LARGE_MENU_THRESHOLD_DISABLED,
		},
		startup: {
			// 全屏动画 splash 会切 alt-screen、盖住 TUI，也会让「初始 prompt 是否已提交」的观测失真。
			// omp 的默认已是 false，这里显式压住，免得用户的全局设置把它打开。
			showSplash: false,
		},
		tui: {
			// 状态编码进 OSC 终端标题——Kanban 的 omp 会话状态判定全靠它（omp-terminal-title-state.ts）。
			// 默认已是 true，同样显式压住：用户关掉它，Kanban 这边就再也翻不动卡片状态了。
			titleState: true,
		},
		...(input.startInPlanMode
			? {
					plan: {
						enabled: true,
						// omp 在 mode.init() 里对 fresh session 应用它，且 init() 先于位置 prompt 的提交，
						// 于是「以 plan 起步 + 自动提交首个 prompt」是正确的顺序。
						// **不要**改用 `--plan-yolo` 表达 plan 起步：那个旗标会在模型第一次 propose 时自动批准
						// 计划、恢复写工具并 steer 一条 handoff 立刻开始实现（session/prewalk.ts），
						// 静默吃掉审批环节——与「plan 起步」的语义相反。
						defaultOnStartup: true,
					},
				}
			: {}),
	};
}

// overlay 落在 Kanban 自己的 hook agent 目录下（与 gemini / droid / opencode 的托管配置同一范式）。
// 每个 task 一份：并发启动的多个 omp 会话不能互相覆写彼此的 plan 起步位。
export function getOmpTuiLaunchConfigOverlayPath(hookAgentDirectory: string, taskId: string): string {
	return join(hookAgentDirectory, `${encodeURIComponent(taskId)}.launch-config.json`);
}

export async function writeOmpTuiLaunchConfigOverlay(input: {
	hookAgentDirectory: string;
	taskId: string;
	startInPlanMode: boolean;
}): Promise<OmpTuiLaunchConfigOverlay> {
	const overlaySettings = buildOmpTuiLaunchConfigOverlaySettings({ startInPlanMode: input.startInPlanMode });
	const configFilePath = getOmpTuiLaunchConfigOverlayPath(input.hookAgentDirectory, input.taskId);
	await lockedFileSystem.writeTextFileAtomic(configFilePath, `${JSON.stringify(overlaySettings, null, 2)}\n`);
	return { configFilePath, overlaySettings };
}
