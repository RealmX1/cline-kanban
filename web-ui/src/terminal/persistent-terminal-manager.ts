import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { type ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { getTerminalThemeColors, type ThemeTerminalColors } from "@/hooks/use-theme";
import { estimateTaskSessionGeometry, SHELL_SESSION_TERMINAL_COLS } from "@/runtime/task-session-geometry";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskSessionSummary,
	RuntimeTerminalWsClientMessage,
	RuntimeTerminalWsResizeMessage,
	RuntimeTerminalWsServerMessage,
} from "@/runtime/types";
import { sliceRestoreSnapshotForIncrementalWrite } from "@/terminal/restore-snapshot-slicing";
import {
	forgetStaleSessionAutoResumeCooldownsForWorkspace,
	type StaleAgentTerminalSessionAutomaticResumePhase,
	StaleAgentTerminalSessionAutomaticResumeScheduler,
} from "@/terminal/stale-agent-terminal-session-automatic-resume-scheduler";
import { clearTerminalGeometry, reportTerminalGeometry } from "@/terminal/terminal-geometry-registry";
import {
	isStashTerminalInputBoxToPromptLibraryShortcut,
	stashTerminalInputBoxToPromptLibrary,
} from "@/terminal/terminal-input-box-stash-shortcut";
import { createKanbanTerminalOptions } from "@/terminal/terminal-options";
import {
	appendTerminalHeuristicText,
	hasInterruptAcknowledgement,
	hasLikelyShellPrompt,
} from "@/terminal/terminal-prompt-heuristics";
import {
	extractTerminalScrollbackTranscriptLogicalLines,
	hasTerminalScrollbackTranscriptContent,
	type TerminalScrollbackTranscriptLogicalLine,
} from "@/terminal/terminal-scrollback-transcript-extraction";
import { shouldHandOffKeyboardFocusToAgentEntryNow } from "@/utils/keyboard-focus-handoff-to-agent-entry";
import { isMacPlatform, isSafari } from "@/utils/platform";

const SHIFT_ENTER_SEQUENCE = "\n";
const RESIZE_DEBOUNCE_MS = 50;
const INTERRUPT_IDLE_SETTLE_MS = 250;
const TERMINAL_RECONNECT_INITIAL_DELAY_MS = 250;
const TERMINAL_RECONNECT_MAX_DELAY_MS = 5_000;
const VIEWER_QUEUE_STALL_MS = 5_000;
// 可见性恢复门控的兜底超时:request_restore 后恢复快照最长等待时间,超时解除门控防白屏。
const AWAITING_RESTORE_SNAPSHOT_TIMEOUT_MS = 5_000;
// 「重新同步画面」（resyncTerminalViewFromServerMirrorWithoutRestartingAgentSession）等第一份服务端快照的
// 截止时间。刻意远短于上面那个 5s 被动兜底：那是「标签页切回来了，顺手要一份新快照」，等久一点无所谓；
// 这里是用户盯着一块冻住的屏幕、刚刚亲手点下按钮，1.5s 还没等到就说明服务端那条 viewer 大概率已经僵死
// （restoreComplete 永远为 false，把实时输出全扣在 pendingOutputChunks 里），继续干等只是让人多盯 3.5s。
const RESYNC_TERMINAL_VIEW_RESTORE_SNAPSHOT_DEADLINE_MS = 1_500;
// 升级重连之后再等一次的截止时间。给得比上面宽，是因为这一程要重新握手两条 WebSocket 并在服务端
// 重建一份 viewerState，本来就比「往已连着的 control socket 上发一条 request_restore」慢一个数量级。
const RESYNC_TERMINAL_VIEW_ESCALATED_RECONNECT_RESTORE_SNAPSHOT_DEADLINE_MS = 4_000;
const PARKING_ROOT_ID = "kb-persistent-terminal-parking-root";
const HOME_TERMINAL_TASK_ID = "__home_terminal__";
const DETAIL_TERMINAL_TASK_PREFIX = "__detail_terminal__:";
const SEARCH_DECORATIONS: NonNullable<ISearchOptions["decorations"]> = {
	activeMatchBackground: "#0084FF",
	activeMatchBorder: "#66B7FF",
	activeMatchColorOverviewRuler: "#0084FF",
	matchBackground: "#D29922",
	matchBorder: "#D4A72C",
	matchOverviewRuler: "#D29922",
};

export interface TerminalSearchResultState {
	resultCount: number;
	resultIndex: number;
}

interface PersistentTerminalAppearance {
	cursorColor: string;
	terminalBackgroundColor: string;
	themeColors?: ThemeTerminalColors;
}

interface PersistentTerminalSubscriber {
	onConnectionReady?: (taskId: string) => void;
	onLastError?: (message: string | null) => void;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onOutputText?: (text: string) => void;
	onSearchOpenRequested?: () => void;
	onSearchResults?: (results: TerminalSearchResultState) => void;
	/** 用户是否已把视口从最新输出处滚开 —— 驱动「跳到最新」按钮的显隐。 */
	onScrolledAwayFromLatestChange?: (isScrolledAwayFromLatest: boolean) => void;
	/**
	 * 这个终端到目前为止有没有渲染出过任何内容（恢复快照或实时输出）。
	 *
	 * 用来把「TUI 区域一片空白」这个哑状态变成可解释、可操作的空态。硬中断后会话进程随上一个 runtime
	 * 一起没了，服务端既没有快照可发、也不会再有输出，用户看到的就是一块纯白 div——既不知道发生了什么，
	 * 也不知道能做什么。双向：实时输出/非空恢复快照把它抬为 true，空恢复快照（xterm 刚被 reset 清成白板）
	 * 把它落回 false；只在值真的变化时通知。
	 */
	onTerminalContentPresenceChange?: (hasRenderedAnyTerminalContent: boolean) => void;
	/** 陈旧会话自动续跑进行到哪一步（null = 没有在进行）；面板据此在续跑途中禁用「重启」并给出说明。 */
	onAutomaticStaleSessionResumePhaseChange?: (phase: StaleAgentTerminalSessionAutomaticResumePhase | null) => void;
}

interface MountPersistentTerminalOptions {
	autoFocus?: boolean;
	isVisible?: boolean;
	/**
	 * 这次挂载所处的视图是不是「相邻卡片导航热键（alt+↑/↓）的接管者」——即它自己在 document 上注册了
	 * 那两条 useHotkeys。只有为 true 时终端才会把 alt+↑/↓ 放行给 document；详见
	 * shouldReleaseAdjacentTaskCardNavigationShortcutToDocumentHotkeyOwner 的说明。
	 */
	isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView?: boolean;
}

interface EnsurePersistentTerminalInput extends PersistentTerminalAppearance {
	deferAutomaticSessionResumeUntilVisibleMount?: boolean;
	taskId: string;
	workspaceId: string;
}

function generateTerminalClientId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `terminal-${Math.random().toString(36).slice(2, 10)}`;
}

function getTerminalIoWebSocketUrl(taskId: string, workspaceId: string, clientId: string): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/terminal/io`);
	url.searchParams.set("taskId", taskId);
	url.searchParams.set("workspaceId", workspaceId);
	url.searchParams.set("clientId", clientId);
	return url.toString();
}

function getTerminalControlWebSocketUrl(taskId: string, workspaceId: string, clientId: string): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/terminal/control`);
	url.searchParams.set("taskId", taskId);
	url.searchParams.set("workspaceId", workspaceId);
	url.searchParams.set("clientId", clientId);
	return url.toString();
}

function decodeTerminalSocketChunk(decoder: TextDecoder, data: string | ArrayBuffer | Blob): string {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return decoder.decode(new Uint8Array(data), { stream: true });
	}
	return "";
}

function getTerminalSocketWriteData(data: string | ArrayBuffer | Blob): string | Uint8Array | null {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data);
	}
	return null;
}

function getTerminalSocketChunkByteLength(data: string | ArrayBuffer | Blob): number {
	if (typeof data === "string") {
		return new TextEncoder().encode(data).byteLength;
	}
	if (data instanceof ArrayBuffer) {
		return data.byteLength;
	}
	return 0;
}

function isCopyShortcut(event: KeyboardEvent): boolean {
	return (
		event.type === "keydown" &&
		((isMacPlatform && event.metaKey && !event.shiftKey && event.key.toLowerCase() === "c") ||
			(!isMacPlatform && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "c"))
	);
}

function isFindShortcut(event: KeyboardEvent): boolean {
	return (
		event.type === "keydown" &&
		((isMacPlatform && event.metaKey && !event.ctrlKey) || (!isMacPlatform && event.ctrlKey && !event.metaKey)) &&
		!event.altKey &&
		!event.shiftKey &&
		event.key.toLowerCase() === "f"
	);
}

// 详情视图把「切换到上/下一张 task 卡」绑在 alt+↑/↓（见 card-detail-view 的 shouldIgnoreAdjacentCardHotkey）。
// 这里放行的按键集合必须与那条热键声明的修饰键集合**精确**一致，一个都不能多：react-hotkeys-hook 对
// 未声明的修饰键做精确拒绝（dist/index.js 的匹配函数里 `declaredShift !== event.shiftKey` 即 return
// false），所以 `alt+up` 在 shift/ctrl/meta 任一置位时都不匹配。这里一旦放行得比热键宽（例如漏掉
// shift），Shift+Alt+↑/↓ 就会掉进两不管地带——xterm 因为放行而既不发字节也不 preventDefault，事件
// 冒泡到 document 后又被热键精确拒绝，按键既不切卡也不进 agent。排除 ctrl/meta 同理，且 Windows 的
// AltGr 会同时置位 ctrl 与 alt。
function isAdjacentTaskCardNavigationShortcut(event: KeyboardEvent): boolean {
	return (
		event.altKey &&
		!event.ctrlKey &&
		!event.metaKey &&
		!event.shiftKey &&
		(event.key === "ArrowUp" || event.key === "ArrowDown")
	);
}

// 「这个按键长得像切卡热键」还不足以放行——放行只有在**确实有人接管**时才成立。
//
// 那两条 useHotkeys("alt+up"/"alt+down") 只在 CardDetailView 挂载期间注册，而 PersistentTerminal 还
// 被另外两处没有详情视图的地方挂载：首页底部 shell 终端（App.tsx）与首页侧栏 agent 终端
// （use-home-sidebar-agent-panel.tsx）。在那些上下文里无条件放行 = 两不管地带：xterm 因为放行既不发
// escape sequence 也不 preventDefault，事件冒泡到 document 后又没有任何热键接住，用户按 alt+↑/↓
// 什么都不会发生（按键被静默吞掉）。
//
// 所以放行必须由挂载点显式声明「我就是那个接管者」——没声明的挂载点一律把按键留给 agent。
function shouldReleaseAdjacentTaskCardNavigationShortcutToDocumentHotkeyOwner(
	event: KeyboardEvent,
	isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView: boolean,
): boolean {
	return isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView && isAdjacentTaskCardNavigationShortcut(event);
}

function getParkingRoot(): HTMLDivElement {
	const existingRoot = document.getElementById(PARKING_ROOT_ID);
	if (existingRoot instanceof HTMLDivElement) {
		return existingRoot;
	}
	const root = document.createElement("div");
	root.id = PARKING_ROOT_ID;
	root.setAttribute("aria-hidden", "true");
	Object.assign(root.style, {
		position: "fixed",
		left: "-10000px",
		top: "-10000px",
		width: "1px",
		height: "1px",
		overflow: "hidden",
		opacity: "0",
		pointerEvents: "none",
	});
	document.body.appendChild(root);
	return root;
}

function buildKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}:${taskId}`;
}

function isShellTerminalTaskId(taskId: string): boolean {
	return taskId === HOME_TERMINAL_TASK_ID || taskId.startsWith(DETAIL_TERMINAL_TASK_PREFIX);
}

function estimateInitialTerminalGeometry(taskId: string): { cols: number; rows: number } {
	const geometry = estimateTaskSessionGeometry(window.innerWidth, window.innerHeight);
	if (!isShellTerminalTaskId(taskId)) {
		return geometry;
	}
	return {
		...geometry,
		cols: SHELL_SESSION_TERMINAL_COLS,
	};
}

function resizeMessagesEqual(left: RuntimeTerminalWsResizeMessage, right: RuntimeTerminalWsResizeMessage): boolean {
	return (
		left.cols === right.cols &&
		left.rows === right.rows &&
		left.pixelWidth === right.pixelWidth &&
		left.pixelHeight === right.pixelHeight
	);
}

class PersistentTerminal {
	private readonly terminal: Terminal;
	private readonly fitAddon = new FitAddon();
	private readonly searchAddon = new SearchAddon({ highlightLimit: 3000 });
	private readonly hostElement: HTMLDivElement;
	private readonly subscribers = new Set<PersistentTerminalSubscriber>();
	private readonly parkingRoot: HTMLDivElement;
	private readonly unicode11Addon = new Unicode11Addon();
	// This identifies one browser viewer, not the PTY session itself.
	// The server uses it to keep per-tab restore and socket state while all tabs
	// still share the same taskId backed PTY.
	//
	// 可变而非 readonly：「重新同步画面」升级到强制重连时会轮换它。服务端的 viewerState 以 clientId 为键，
	// 沿用旧键就会重新拿到那条已经僵死的条目（restoreComplete 卡在 false、还挂在 backpressuredViewerIds
	// 里），重连也就白连了。
	private clientId = generateTerminalClientId();
	private appearance: PersistentTerminalAppearance;
	private latestSummary: RuntimeTaskSessionSummary | null = null;
	private lastError: string | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private visibleContainer: HTMLDivElement | null = null;
	private isMountedContainerVisible = false;
	// 当前这次挂载所处的视图是否自己注册了 alt+↑/↓ 切卡热键（见同名 mount option）。随 mount 写入、
	// 随 unmount 归零——泊车终端没有任何可见容器，自然也就不在任何接管者内部。
	private isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView = false;
	private ioSocket: WebSocket | null = null;
	private controlSocket: WebSocket | null = null;
	private connectionReady = false;
	private restoreCompleted = false;
	private hasRenderedAnyTerminalContent = false;
	// 「用户打开 / 回到这个任务时把已经不在的 PTY agent 会话接回来」：资格、停留门槛、按活体计的闩与跨实例
	// 冷却都在调度器里（见 stale-agent-terminal-session-automatic-resume-scheduler.ts），本类只在各个
	// 「打开 / 回到」信号上叫它评估一次。
	private readonly staleAgentTerminalSessionAutomaticResumeScheduler: StaleAgentTerminalSessionAutomaticResumeScheduler;
	private outputTextDecoder = new TextDecoder();
	private terminalWriteQueue: Promise<void> = Promise.resolve();
	// 写队列的代次。discardStalledTerminalWriteQueue 换得掉 terminalWriteQueue 这个「队尾指针」，却取消不了
	// 已经排在旧链上、正等着前驱 write 回调的那些 link——而写队列卡死最常见的成因（xterm 写缓冲积压、
	// rAF/setTimeout 被节流）恰恰会稍后解冻，把整条旧链排空。每次入队记下当时的代次，执行体里发现代次
	// 已被推进就自认属于「已丢弃的旧链」并让路，不再往刚 reset 过的屏幕里补写陈旧字节。
	private discardedTerminalWriteQueueGeneration = 0;
	private slowFlushLogged = false;
	private lastSentResizeMessage: RuntimeTerminalWsResizeMessage | null = null;
	private reconnectTimer: number | null = null;
	private reconnectAttempt = 0;
	private disposed = false;
	// User-initiated refresh swaps the backing PTY but should NOT wipe the visible
	// scrollback. The hook reads and clears this flag before deciding whether the
	// new sessionStartedAt warrants resetting the xterm instance.
	private suppressNextRestartReset = false;
	// While the browser tab is hidden the renderer (xterm's requestAnimationFrame loop)
	// is paused by the browser, so writing live output would pile up a backlog that
	// replays as a multi-minute "time-lapse" when the tab is shown again. Instead we
	// suspend rendering while hidden (still acking so the agent keeps running) and snap
	// straight to a fresh server snapshot on return.
	private documentVisible: boolean;
	private renderingSuspended: boolean;
	private needsSnapshotResync = false;
	// 可见性恢复竞态门控:标签页回归可见、已发出 request_restore、恢复快照尚未到达的窗口内,
	// 实时 io chunk 只 ack + 丢弃(不写 xterm)——否则这些 chunk 会先写进过期屏幕(time-lapse
	// 闪帧),随后又被 reset+快照整段覆盖(双重渲染)。丢弃无损:请求前的在途 chunk 已进服务端
	// mirror(必含于快照),之后的 chunk 被服务端 restoreComplete=false 缓冲、restore_complete
	// 后重放。5s 兜底超时防控制消息丢失导致白屏。
	private awaitingRestoreSnapshot = false;
	private awaitingRestoreSnapshotTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
	// 「重新同步画面」期间抑制陈旧会话自动续跑的一次性闩（与上面 suppressNextRestartReset 同构）。
	//
	// 非它不可的理由：resync 升级重连后，服务端在 control socket 连上时**无条件**重推一份快照，客户端照常
	// 走 applyRestore → 落到自动续跑的评估点。若此时服务端 mirror 恰好是空的、而客户端
	// 手里那份 latestSummary 又是控制通道僵死前的陈旧值（pid 为 null），自动续跑的全部判据就都命中了——
	// 用户点的是「只把画面解冻，别动 agent」，结果反而打出一次 refreshTaskTerminal 把活着的 agent 杀了。
	// 这正是本功能存在的意义的反面，所以 resync 路径上必须显式压掉这条自动路径。
	private suppressNextStaleSessionAutoResumeTriggeredByViewResync = false;
	// 恢复快照的「到达序号」与「已落屏的最新到达序号」，外加等待者集合。resync 用它判断服务端到底有没有把
	// **它这次请求的**那份快照送到并写进屏幕：序号没前进 = 服务端那条 viewer 僵死，该升级成换 clientId 重连了。
	//
	// 为什么按到达序号而不是只数「应用了几次」：resync 发起时可能已经有一份更早的快照在途（写队列慢、还没
	// 落屏），它恰好在 resync 的等待窗口里落屏时，会把「只数次数」的等待顺手满足——resync 于是提前收尾、
	// finally 清掉抑制闩，而本次真正请求到的那份快照随后才落地、不再被抑制。若它恰是空快照且 latestSummary
	// 是控制通道僵死前的陈旧值（pid 为 null），自动续跑的判据就全中，「只解冻画面」当场
	// 变成一次杀掉活 agent 的 refreshTaskTerminal。按序号比较即把「早于本次请求到达的快照」整类排除在外。
	private restoreSnapshotArrivalSequence = 0;
	private latestAppliedRestoreSnapshotArrivalSequence = 0;
	private readonly restoreSnapshotApplicationWaiters = new Set<() => void>();
	private scrolledAwayFromLatest = false;
	// 最近一份落屏的 restore 是否「快照为空、且不是画面重同步引起的」——自动续跑「服务端 mirror 已丢」证据的
	// 前两条（第三条「之后没渲染过内容」见 readLatestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss）。
	//
	// resync 引起的那份快照落屏时把它压成 false：resync 是在 viewer 通路坏掉时发起的，拿到的空快照不可信，
	// 而它也盖掉了先前那份快照留在屏幕上的结论（预热泊车期间的空 restore 之后又 resync，可见挂载时不续跑）。
	// 但 resync 只作废这条证据、**不封锁评估本身**：回收分支依赖的是服务端回收记录，与快照无关；若在 resync
	// 之后把整条评估挡到下一份 restore 为止，活会话 resync 后被回收、泊车再挂回（socket 没断、没有新 restore）
	// 时就永远续不上了。resync 进行中自己触发的评估由 suppressNextStaleSessionAutoResumeTriggeredByViewResync 挡。
	private latestAppliedRestoreWasEmptyAndNotTriggeredByViewResync = false;

	constructor(
		private readonly taskId: string,
		private readonly workspaceId: string,
		appearance: PersistentTerminalAppearance,
		private shouldDeferAutomaticSessionResumeUntilVisibleMount = false,
	) {
		this.appearance = appearance;
		this.staleAgentTerminalSessionAutomaticResumeScheduler = new StaleAgentTerminalSessionAutomaticResumeScheduler({
			workspaceId,
			taskId,
			isAllowedToEvaluateAutomaticResumeNow: () => this.isAllowedToEvaluateStaleSessionAutomaticResumeNow(),
			readLatestSummary: () => this.latestSummary,
			readLatestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: () =>
				this.readLatestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss(),
			requestAutomaticResume: async () => await this.refresh("stale_session_client_auto_resume"),
			onPhaseChange: (phase) => this.notifyAutomaticStaleSessionResumePhase(phase),
		});
		this.parkingRoot = getParkingRoot();
		this.hostElement = document.createElement("div");
		Object.assign(this.hostElement.style, {
			width: "100%",
			height: "100%",
		});
		this.parkingRoot.appendChild(this.hostElement);
		const initialGeometry = estimateInitialTerminalGeometry(this.taskId);

		this.terminal = new Terminal({
			...createKanbanTerminalOptions({
				cursorColor: this.appearance.cursorColor,
				isMacPlatform,
				terminalBackgroundColor: this.appearance.terminalBackgroundColor,
				themeColors: this.appearance.themeColors ?? getTerminalThemeColors(),
			}),
			cols: initialGeometry.cols,
			rows: initialGeometry.rows,
		});
		this.terminal.loadAddon(this.fitAddon);
		this.terminal.loadAddon(new ClipboardAddon());
		this.terminal.loadAddon(this.searchAddon);
		this.terminal.loadAddon(new WebLinksAddon());
		this.terminal.loadAddon(this.unicode11Addon);
		this.terminal.unicode.activeVersion = "11";
		this.terminal.open(this.hostElement);
		this.terminal.onData((data) => {
			this.sendIoData(data);
		});
		this.terminal.onBinary((data) => {
			const bytes = new Uint8Array(data.length);
			for (let index = 0; index < data.length; index += 1) {
				bytes[index] = data.charCodeAt(index) & 0xff;
			}
			this.sendIoData(bytes);
		});
		this.terminal.attachCustomKeyEventHandler((event) => {
			if (
				shouldReleaseAdjacentTaskCardNavigationShortcutToDocumentHotkeyOwner(
					event,
					this.isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView,
				)
			) {
				// alt+↑/↓ 是详情视图的切卡热键。不放行的话 xterm 会把它转成 escape sequence 发进
				// agent TUI 并 preventDefault，焦点落在终端里时就永远切不了卡。返回 false 表示
				// 「xterm 不要处理」——既不发字节也不 preventDefault，事件继续冒泡到 document 级热键。
				// 只有确实挂在接管者内部时才这么做，否则按键会被吞进两不管地带（见上面那个判定函数）。
				return false;
			}
			if (event.key === "Enter" && event.shiftKey) {
				if (event.type === "keydown") {
					this.terminal.input(SHIFT_ENTER_SEQUENCE);
				}
				return false;
			}
			if (isCopyShortcut(event) && this.terminal.hasSelection()) {
				void navigator.clipboard.writeText(this.terminal.getSelection()).catch(() => {
					// Ignore clipboard failures.
				});
				return false;
			}
			if (isFindShortcut(event)) {
				event.preventDefault();
				this.notifySearchOpenRequested();
				return false;
			}
			if (!isShellTerminalTaskId(this.taskId) && isStashTerminalInputBoxToPromptLibraryShortcut(event)) {
				// 只接管 agent 任务终端。shell 终端里 Ctrl+S 是 XOFF、没有可读的输入框，接管它等于改掉
				// 一个与本特性无关的终端语义。
				//
				// preventDefault 挡的是 macOS 上 Cmd+S 漏给浏览器的「存储页面」对话框；返回 false 让 xterm
				// 不要把这个字节发给 PTY——它由服务端在写库成功之后才转发，从而保证「库里没有 ⇒ 框里还在」。
				event.preventDefault();
				void stashTerminalInputBoxToPromptLibrary({ workspaceId: this.workspaceId, taskId: this.taskId });
				return false;
			}
			return true;
		});
		this.searchAddon.onDidChangeResults((results) => {
			this.notifySearchResults(results);
		});
		this.terminal.onScroll(() => {
			this.refreshScrolledAwayFromLatest();
		});

		if (!isSafari) {
			// Safari 走 xterm 的 DOM 渲染器：它在 Cmd +/- 缩放时始终清晰（Safari 不改变
			// window.devicePixelRatio，WebGL canvas 缓冲区不会按新 DPR 重新光栅化、文字发虚），
			// 同时也规避了较新 Safari 的 WebGL 渲染破损（xterm.js #5816）。
			try {
				const webglAddon = new WebglAddon();
				webglAddon.onContextLoss(() => {
					webglAddon.dispose();
				});
				this.terminal.loadAddon(webglAddon);
			} catch {
				// Fall back to the default DOM renderer when WebGL is unavailable.
			}
		}

		this.documentVisible = typeof document === "undefined" || document.visibilityState === "visible";
		this.renderingSuspended = !this.documentVisible;
		if (typeof document !== "undefined") {
			document.addEventListener("visibilitychange", this.handleVisibilityChange);
		}
		// 焦点点进终端也算「回到这个任务」：覆盖标签页一直可见、人离开数小时后回来直接点进终端的情形——
		// 那时既没有新的挂载，也没有可见性变化。
		this.hostElement.addEventListener("focusin", this.handleTerminalFocusIn);

		this.ensureConnected();
	}

	private readonly handleVisibilityChange = (): void => {
		this.setDocumentVisible(document.visibilityState === "visible");
	};

	private readonly handleTerminalFocusIn = (): void => {
		this.staleAgentTerminalSessionAutomaticResumeScheduler.evaluateOnUserOpenSignal();
	};

	// 只有用户此刻真的看着这个终端时才评估自动续跑：可见挂载、标签页可见、已有一份落屏的 restore
	// （快照空不空是资格判据之一），且没有被预热延迟或进行中的「重新同步画面」抑制。
	private isAllowedToEvaluateStaleSessionAutomaticResumeNow(): boolean {
		return (
			this.visibleContainer !== null &&
			this.isMountedContainerVisible &&
			this.documentVisible &&
			this.restoreCompleted &&
			!this.shouldDeferAutomaticSessionResumeUntilVisibleMount &&
			!this.suppressNextStaleSessionAutoResumeTriggeredByViewResync
		);
	}

	// 「服务端 mirror 已随旧 runtime 丢失」这条证据必须反映 mirror 的**当前**状态，而不是某一刻的历史结论：
	// 空 restore 之后只要渲染过任何内容——续跑后服务端写进新 mirror 的「Refreshing terminal session」banner、
	// agent 输出——就说明 mirror 已经有东西了，证据随即作废。否则续跑出来的新活体之后在用户眼前自然退出，
	// 过了冷却再回来，仍会被这份陈旧的空快照当成「mirror 已丢」再拉起一次（refresh 不会再要一份快照来纠正它）。
	// hasRenderedAnyTerminalContent 正是「自最近一次空 restore 以来」的那一位：空快照落屏把它落回 false，
	// 任何输出或非空快照把它置 true。
	private readLatestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss(): boolean {
		return this.latestAppliedRestoreWasEmptyAndNotTriggeredByViewResync && !this.hasRenderedAnyTerminalContent;
	}

	private notifyAutomaticStaleSessionResumePhase(phase: StaleAgentTerminalSessionAutomaticResumePhase | null): void {
		for (const subscriber of this.subscribers) {
			subscriber.onAutomaticStaleSessionResumePhaseChange?.(phase);
		}
	}

	private setDocumentVisible(visible: boolean): void {
		if (this.documentVisible === visible) {
			return;
		}
		this.documentVisible = visible;
		this.renderingSuspended = !visible;
		if (visible && this.needsSnapshotResync) {
			this.needsSnapshotResync = false;
			// 先武装 awaiting 门控再发请求:恢复快照到达前的实时 chunk 不再写进过期屏幕
			// (见 awaitingRestoreSnapshot 字段注释的竞态说明)。
			this.beginAwaitingRestoreSnapshotGate();
			this.requestSnapshotResync();
		}
		// 标签页切回来 = 用户回到这个任务；切走时还在等停留时长的那一次作废。
		if (visible) {
			this.staleAgentTerminalSessionAutomaticResumeScheduler.evaluateOnUserOpenSignal();
		} else {
			this.staleAgentTerminalSessionAutomaticResumeScheduler.cancelPendingVisibleDwell();
		}
	}

	private requestSnapshotResync(): void {
		// We discarded live output while hidden, so the visible terminal is stale. Ask the
		// server for a fresh snapshot (the server-side mirror stays current in real time) to
		// jump straight to the latest screen — no frame-by-frame catch-up. If the control
		// socket is currently closed, the pending reconnect already sends a restore snapshot,
		// so this is a no-op in that case.
		this.sendControlMessage({ type: "request_restore" });
	}

	private beginAwaitingRestoreSnapshotGate(): void {
		this.awaitingRestoreSnapshot = true;
		this.clearAwaitingRestoreSnapshotTimeoutTimer();
		this.awaitingRestoreSnapshotTimeoutTimer = setTimeout(() => {
			this.awaitingRestoreSnapshotTimeoutTimer = null;
			// 兜底:恢复快照迟迟未到(控制消息丢失 / 服务端异常)。解除门控恢复实时渲染,
			// 宁可屏幕内容从过期状态续写,也不能白屏卡死。
			this.awaitingRestoreSnapshot = false;
		}, AWAITING_RESTORE_SNAPSHOT_TIMEOUT_MS);
	}

	private endAwaitingRestoreSnapshotGate(): void {
		this.awaitingRestoreSnapshot = false;
		this.clearAwaitingRestoreSnapshotTimeoutTimer();
	}

	private clearAwaitingRestoreSnapshotTimeoutTimer(): void {
		if (this.awaitingRestoreSnapshotTimeoutTimer !== null) {
			clearTimeout(this.awaitingRestoreSnapshotTimeoutTimer);
			this.awaitingRestoreSnapshotTimeoutTimer = null;
		}
	}

	// 快照应用完成时按「它自己的到达序号」抬高水位——落屏顺序未必等于到达顺序（写队列可能把更早的一份卡在
	// 后面），故取 max 而非直接赋值，水位只前进不回退。
	private notifyRestoreSnapshotApplied(appliedRestoreSnapshotArrivalSequence: number): void {
		if (appliedRestoreSnapshotArrivalSequence > this.latestAppliedRestoreSnapshotArrivalSequence) {
			this.latestAppliedRestoreSnapshotArrivalSequence = appliedRestoreSnapshotArrivalSequence;
		}
		for (const waiter of [...this.restoreSnapshotApplicationWaiters]) {
			waiter();
		}
	}

	private async waitForRestoreSnapshotApplication(
		restoreSnapshotArrivalSequenceBeforeWait: number,
		deadlineMs: number,
	): Promise<boolean> {
		if (this.latestAppliedRestoreSnapshotArrivalSequence > restoreSnapshotArrivalSequenceBeforeWait) {
			return true;
		}
		return await new Promise<boolean>((resolve) => {
			let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
			const waiter = (): void => {
				// 只有「到达序号晚于本次等待起点」的快照才算数：更早在途、此刻才落屏的那份顶替不了，继续等。
				if (this.latestAppliedRestoreSnapshotArrivalSequence <= restoreSnapshotArrivalSequenceBeforeWait) {
					return;
				}
				if (deadlineTimer !== null) {
					clearTimeout(deadlineTimer);
					deadlineTimer = null;
				}
				this.restoreSnapshotApplicationWaiters.delete(waiter);
				resolve(true);
			};
			this.restoreSnapshotApplicationWaiters.add(waiter);
			deadlineTimer = setTimeout(() => {
				deadlineTimer = null;
				this.restoreSnapshotApplicationWaiters.delete(waiter);
				resolve(false);
			}, deadlineMs);
		});
	}

	// 丢掉卡住的写队列。applyRestore 的第一句就是 await 这条链，而链上任何一次 terminal.write 的回调没被
	// 触发就会让它永久悬着——恢复快照于是永远排在一条死队列后面，画面再也不会更新。
	//
	// 换掉队尾指针只是把新写入接到一条干净的链上，**取消不了**旧链：旧链上每个 link 都已经作为前驱的
	// then 回调注册好了，前驱的 write 回调一旦迟到触发（卡死最常见的成因就是「渲染只是被节流、后来还是
	// 回来了」），整条旧链会照常排空。所以这里必须同时推进代次，让旧链上的 link 在自己的执行体里认出
	// 「我已经被丢弃了」——否则那些陈旧字节会插进 sliceRestoreSnapshotForIncrementalWrite 按固定字符数
	// 硬切出来的快照分片之间，把跨片的 ANSI 序列截断成重影或乱码。
	private discardStalledTerminalWriteQueue(): void {
		this.terminalWriteQueue = Promise.resolve();
		this.discardedTerminalWriteQueueGeneration += 1;
		this.slowFlushLogged = false;
	}

	// 换一个 clientId 重连两条 socket。服务端按 clientId 存 viewerState，所以「同一个 clientId 重连」拿回的
	// 还是那条僵死条目；换 id 才等于要一份干净的 viewer。旧条目在两条 socket 关闭后被服务端
	// cleanupViewerStateIfUnused 回收，顺带从 backpressuredViewerIds 里摘掉——如果共享 PTY 正是被这一个
	// 慢 viewer 单独按住的，这一下也把 PTY 放开了。
	//
	// 先把字段置空再 close：两条 socket 的**每一个**事件处理器（onopen / onmessage / onerror / onclose）以及
	// applyRestore 的 then/catch 续体，都以 `this.xxxSocket !== socket` 作为「我已经不是当前连接」的判据，先
	// 置空即让它们静默退出，不会反过来把新连接的状态清掉、也不会再排一次 scheduleReconnect 与这里的
	// ensureConnected 抢。onmessage 上那道守卫和 onclose 上的一样是必需的：close() 只是发起关闭握手，此前
	// 已入队的 message 事件仍会派发（服务端 restore 迟到，本就是走到这个升级分支的条件本身）。
	private reconnectTerminalSocketsUnderRotatedClientId(): void {
		if (this.disposed) {
			return;
		}
		this.clientId = generateTerminalClientId();
		const stalledIoSocket = this.ioSocket;
		const stalledControlSocket = this.controlSocket;
		this.ioSocket = null;
		this.controlSocket = null;
		this.connectionReady = false;
		this.restoreCompleted = false;
		this.lastSentResizeMessage = null;
		this.outputTextDecoder = new TextDecoder();
		try {
			stalledIoSocket?.close(1000, "Resyncing terminal view.");
			stalledControlSocket?.close(1000, "Resyncing terminal view.");
		} catch {
			// 关不掉就让它自己超时；重要的是本实例已经不再认它。
		}
		this.clearReconnectTimer();
		this.reconnectAttempt = 0;
		this.ensureConnected();
	}

	private notifyLastError(): void {
		for (const subscriber of this.subscribers) {
			subscriber.onLastError?.(this.lastError);
		}
	}

	private notifySummary(summary: RuntimeTaskSessionSummary): void {
		this.latestSummary = summary;
		for (const subscriber of this.subscribers) {
			subscriber.onSummary?.(summary);
		}
	}

	private notifyOutputText(text: string): void {
		this.markTerminalContentPresent();
		for (const subscriber of this.subscribers) {
			subscriber.onOutputText?.(text);
		}
	}

	// 跟随「屏幕上此刻是否真的有内容」的双向标志，而非一次性闸门：运行时 redeploy 时两条 socket 只是关闭
	// 重连（scheduleReconnect → ensureConnected 都作用在同一个实例上，dispose 只由关面板/换任务/LRU 回收触发），
	// 所以「此前渲染过内容的终端」会活着看到 applyRestore 的 reset + 空快照——不落回 false 的话，屏幕已被清成
	// 白板而空态卡片却不显示。只在值真的变化时通知订阅者，避免每次 restore 都刷一遍。
	private setHasRenderedAnyTerminalContent(nextHasRenderedAnyTerminalContent: boolean): void {
		if (this.hasRenderedAnyTerminalContent === nextHasRenderedAnyTerminalContent) {
			return;
		}
		this.hasRenderedAnyTerminalContent = nextHasRenderedAnyTerminalContent;
		for (const subscriber of this.subscribers) {
			subscriber.onTerminalContentPresenceChange?.(nextHasRenderedAnyTerminalContent);
		}
	}

	private markTerminalContentPresent(): void {
		this.setHasRenderedAnyTerminalContent(true);
	}

	private notifyConnectionReady(): void {
		this.connectionReady = true;
		for (const subscriber of this.subscribers) {
			subscriber.onConnectionReady?.(this.taskId);
		}
	}

	private notifySearchOpenRequested(): void {
		for (const subscriber of this.subscribers) {
			subscriber.onSearchOpenRequested?.();
		}
	}

	private notifySearchResults(results: TerminalSearchResultState): void {
		for (const subscriber of this.subscribers) {
			subscriber.onSearchResults?.(results);
		}
	}

	// 复用写入路径的贴底判据（shouldKeepScrolledToBottom）的反面，两处保持同一个阈值语义：
	// 写入侧用它决定「要不要跟随输出」，这里用它决定「要不要提示用户跳回最新」。
	private refreshScrolledAwayFromLatest(): void {
		const nextScrolledAwayFromLatest = !this.shouldKeepScrolledToBottom();
		if (nextScrolledAwayFromLatest === this.scrolledAwayFromLatest) {
			return;
		}
		this.scrolledAwayFromLatest = nextScrolledAwayFromLatest;
		for (const subscriber of this.subscribers) {
			subscriber.onScrolledAwayFromLatestChange?.(nextScrolledAwayFromLatest);
		}
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer !== null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.reconnectTimer !== null) {
			return;
		}
		const delay = Math.min(
			TERMINAL_RECONNECT_INITIAL_DELAY_MS * 2 ** this.reconnectAttempt,
			TERMINAL_RECONNECT_MAX_DELAY_MS,
		);
		this.reconnectAttempt += 1;
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			this.ensureConnected();
			if (!this.disposed && (!this.ioSocket || !this.controlSocket)) {
				this.scheduleReconnect();
			}
		}, delay);
	}

	private markSocketOpen(): void {
		this.reconnectAttempt = 0;
		this.clearReconnectTimer();
		this.lastError = null;
		this.notifyLastError();
	}

	private sendControlMessage(message: RuntimeTerminalWsClientMessage): boolean {
		if (!this.controlSocket || this.controlSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.controlSocket.send(JSON.stringify(message));
		return true;
	}

	private sendIoData(data: string | Uint8Array): boolean {
		if (
			this.shouldDeferAutomaticSessionResumeUntilVisibleMount ||
			!this.ioSocket ||
			this.ioSocket.readyState !== WebSocket.OPEN
		) {
			return false;
		}
		this.ioSocket.send(data);
		return true;
	}

	private enqueueTerminalWrite(
		data: string | Uint8Array,
		options: {
			ackBytes?: number;
			notifyText?: string | null;
			keepScrolledToBottom?: boolean;
		} = {},
	): Promise<void> {
		const ackBytes = options.ackBytes ?? 0;
		const notifyText = options.notifyText ?? null;
		const enqueuedAt = performance.now();
		const generationAtEnqueue = this.discardedTerminalWriteQueueGeneration;
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(
				async () =>
					await new Promise<void>((resolve) => {
						if (this.disposed) {
							resolve();
							return;
						}
						if (generationAtEnqueue !== this.discardedTerminalWriteQueueGeneration) {
							// 这条 link 属于已被 discardStalledTerminalWriteQueue 丢弃的旧链：不落屏、不发文本通知、
							// 不动滚动位置——这些字节已经被随后那份恢复快照整段覆盖，补写只会把快照分片撕开。
							//
							// 但 ackBytes 必须照发：服务端在**发送**时就把它们计入了 unacknowledgedOutputBytes，
							// 而「只发 request_restore、control socket 不重连」这条非升级路径不会触发服务端的
							// resetUnacknowledgedOutputAccounting。漏发就等于把这批字节的记账永久悬空，PTY 会在
							// 画面看似已恢复之后继续被背压按住，直到 30s 逐出兜底才放开。
							if (ackBytes > 0) {
								this.sendControlMessage({
									type: "output_ack",
									bytes: ackBytes,
								});
							}
							resolve();
							return;
						}
						const shouldKeepScrolledToBottom =
							options.keepScrolledToBottom === false ? false : this.shouldKeepScrolledToBottom();
						this.terminal.write(data, () => {
							const elapsed = performance.now() - enqueuedAt;
							if (elapsed > VIEWER_QUEUE_STALL_MS) {
								if (!this.slowFlushLogged) {
									console.warn(
										`[tui-freeze] viewer-queue taskId=${this.taskId} elapsedMs=${Math.round(elapsed)}`,
									);
									this.slowFlushLogged = true;
								}
							} else if (this.slowFlushLogged) {
								this.slowFlushLogged = false;
							}
							if (notifyText) {
								this.notifyOutputText(notifyText);
							}
							if (ackBytes > 0) {
								this.sendControlMessage({
									type: "output_ack",
									bytes: ackBytes,
								});
							}
							this.keepScrolledToBottom(shouldKeepScrolledToBottom);
							resolve();
						});
					}),
			);
		return this.terminalWriteQueue;
	}

	private async applyRestore(
		snapshot: string,
		cols: number | null | undefined,
		rows: number | null | undefined,
	): Promise<void> {
		const shouldKeepScrolledToBottom = this.shouldKeepScrolledToBottom();
		await this.terminalWriteQueue.catch(() => undefined);
		this.terminal.reset();
		if (cols && rows && (this.terminal.cols !== cols || this.terminal.rows !== rows)) {
			this.terminal.resize(cols, rows);
		}
		if (!snapshot) {
			// 空快照 = 服务端 mirror 已随运行时重启丢失：上面的 reset() 刚把 xterm 清成白板，屏幕上确实
			// 一无所有，标志必须跟着落回 false，「会话已随运行时结束」的空态卡片才会出现。
			this.setHasRenderedAnyTerminalContent(false);
			this.keepScrolledToBottom(shouldKeepScrolledToBottom);
			return;
		}
		this.markTerminalContentPresent();
		// 快照分片写入:整段写会让 xterm 在一次 write 里同步解析数 MB(其 12ms 时间预算只在
		// chunk 之间生效),页面冻结且 restore_complete 被推迟。切片后写队列逐段解析,主线程
		// 在片间保持可响应。滚动定位保持在全部写完之后。
		let lastSnapshotSliceWrite: Promise<void> = Promise.resolve();
		for (const snapshotSlice of sliceRestoreSnapshotForIncrementalWrite(snapshot)) {
			lastSnapshotSliceWrite = this.enqueueTerminalWrite(snapshotSlice, { keepScrolledToBottom: false });
		}
		await lastSnapshotSliceWrite;
		this.keepScrolledToBottom(shouldKeepScrolledToBottom);
	}

	private getRenderedPixelSize(): { pixelWidth?: number; pixelHeight?: number } {
		const screenElement = this.terminal.element?.querySelector<HTMLElement>(".xterm-screen");
		if (!screenElement) {
			return {};
		}
		const bounds = screenElement.getBoundingClientRect();
		const pixelWidth = Math.round(bounds.width);
		const pixelHeight = Math.round(bounds.height);
		return {
			pixelWidth: pixelWidth > 0 ? pixelWidth : undefined,
			pixelHeight: pixelHeight > 0 ? pixelHeight : undefined,
		};
	}

	private requestResize(): void {
		// 隐藏挂载仍有容器；尺寸观察、socket 打开与 restore 回调都不得因此调整活 PTY。
		if (!this.visibleContainer || !this.isMountedContainerVisible) {
			return;
		}
		const proposedDimensions = this.fitAddon.proposeDimensions();
		const nextCols =
			proposedDimensions && Number.isFinite(proposedDimensions.cols)
				? Math.max(1, Math.floor(proposedDimensions.cols))
				: this.terminal.cols;
		// 行数与列数一样如实跟随可视高度（含移动端）。曾短暂尝试过「移动端把行数钉在首次
		// 适配值以躲开软键盘抖动」，已移除：(1) 其依据——codex resize 触发 ESC[2J ESC[3J 全量
		// 重印 + 20k 行 mirror 重放——是 `--no-alt-screen` 强制 inline 专属的历史顽疾，codex 现在
		// 跑原生 alt-screen（`agent-session-adapters.test.ts` 有防回灌断言），resize 只原地重绘
		// 一屏，服务端 resize 路径也不回放 mirror；(2) app 根布局是 `h-[100svh]`（静态小视口
		// 单位），软键盘开合只改 visual viewport，本就不会驱动这里的 ResizeObserver；(3) 钉住
		// 行数会让 TUI 把输入行/选择区绘到已被裁掉且不属于 scrollback 的底部行里，用户无法靠
		// 滚动找回，直接毁掉「手机上就地回答 AskUserQuestion」这一目标。
		const nextRows =
			proposedDimensions && Number.isFinite(proposedDimensions.rows)
				? Math.max(1, Math.floor(proposedDimensions.rows))
				: this.terminal.rows;
		if (nextCols !== this.terminal.cols || nextRows !== this.terminal.rows) {
			this.terminal.resize(nextCols, nextRows);
		}
		const renderedPixelSize = this.getRenderedPixelSize();
		reportTerminalGeometry(this.taskId, {
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		});
		const resizeMessage: RuntimeTerminalWsResizeMessage = {
			type: "resize",
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			pixelWidth: renderedPixelSize.pixelWidth,
			pixelHeight: renderedPixelSize.pixelHeight,
		};
		if (this.lastSentResizeMessage && resizeMessagesEqual(this.lastSentResizeMessage, resizeMessage)) {
			return;
		}
		if (this.sendControlMessage(resizeMessage)) {
			this.lastSentResizeMessage = resizeMessage;
		}
	}

	private shouldKeepScrolledToBottom(): boolean {
		const buffer = this.terminal.buffer.active;
		return buffer.baseY - buffer.viewportY <= 1;
	}

	private keepScrolledToBottom(shouldKeepScrolledToBottom: boolean): void {
		if (!shouldKeepScrolledToBottom) {
			return;
		}
		window.requestAnimationFrame(() => {
			if (this.disposed) {
				return;
			}
			this.terminal.scrollToBottom();
		});
	}

	private connectIo(): void {
		if (this.ioSocket) {
			return;
		}
		const ioSocket = new WebSocket(getTerminalIoWebSocketUrl(this.taskId, this.workspaceId, this.clientId));
		ioSocket.binaryType = "arraybuffer";
		ioSocket.addEventListener("message", (event) => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			const writeData = getTerminalSocketWriteData(event.data);
			if (!writeData) {
				return;
			}
			const ackBytes = getTerminalSocketChunkByteLength(event.data);
			// Decode every chunk regardless of visibility so the streaming TextDecoder and
			// activity notifications stay consistent across the hidden window.
			const decoded = decodeTerminalSocketChunk(this.outputTextDecoder, event.data);
			if (this.renderingSuspended) {
				// Tab is hidden: skip the xterm write (the renderer is paused, so it would
				// only build a backlog). Ack immediately to keep the agent's PTY flowing,
				// keep activity notifications alive, and remember to resync on return.
				this.sendControlMessage({ type: "output_ack", bytes: ackBytes });
				if (decoded) {
					this.notifyOutputText(decoded);
				}
				this.needsSnapshotResync = true;
				return;
			}
			if (this.awaitingRestoreSnapshot) {
				// 标签页已回归可见、恢复快照在途:这段实时 chunk 属于「将被快照整段覆盖」的
				// 过期窗口——ack + 丢弃,但**不**置 needsSnapshotResync(快照本就在途,置位会
				// 自触发下一轮 request_restore 死循环)。丢弃无损,见 awaitingRestoreSnapshot 注释。
				this.sendControlMessage({ type: "output_ack", bytes: ackBytes });
				if (decoded) {
					this.notifyOutputText(decoded);
				}
				return;
			}
			void this.enqueueTerminalWrite(writeData, {
				ackBytes,
				notifyText: decoded || null,
			});
		});
		this.ioSocket = ioSocket;
		ioSocket.onopen = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.markSocketOpen();
			if (this.restoreCompleted && this.visibleContainer) {
				this.requestResize();
			}
			if (this.restoreCompleted) {
				this.notifyConnectionReady();
			}
		};
		ioSocket.onerror = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.lastError = "Terminal stream failed.";
			this.notifyLastError();
		};
		ioSocket.onclose = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.ioSocket = null;
			this.outputTextDecoder = new TextDecoder();
			this.connectionReady = false;
			this.lastError = "Terminal stream closed. Reconnecting...";
			this.notifyLastError();
			this.scheduleReconnect();
		};
	}

	private connectControl(): void {
		if (this.controlSocket) {
			return;
		}
		const controlSocket = new WebSocket(getTerminalControlWebSocketUrl(this.taskId, this.workspaceId, this.clientId));
		this.controlSocket = controlSocket;
		this.lastSentResizeMessage = null;
		controlSocket.onopen = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.markSocketOpen();
		};
		controlSocket.onmessage = (event) => {
			// 与 onopen / onerror / onclose 同源的守卫，必须在解析帧之前：升级重连
			// （reconnectTerminalSocketsUnderRotatedClientId）先把 this.controlSocket 置空再 close()，而 close()
			// 只是发起关闭握手——此前已入队的 message 事件仍会照常派发。旧连接上迟到的一帧 restore 若不挡下，
			// 会拆掉刚为新连接武装好的恢复门控、把 restoreCompleted 永久压回 false（它自己的 .then() 又被下面
			// 那道同款守卫挡住，再也没人把它置回 true），并用陈旧快照盖掉刚重画好的画面。
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			let payload: RuntimeTerminalWsServerMessage;
			try {
				payload = JSON.parse(String(event.data)) as RuntimeTerminalWsServerMessage;
			} catch {
				// Ignore malformed control frames.
				return;
			}

			if (payload.type === "restore") {
				// 恢复快照已到达:解除可见性恢复门控。此后到 restore_complete 之间服务端不再
				// 转发实时输出(restoreComplete=false 缓冲),不存在门控漏窗。
				this.endAwaitingRestoreSnapshotGate();
				this.restoreCompleted = false;
				// 到达序号在此刻定死（而非等落屏时再取），resync 才能分辨「本次请求到的那一份」与「更早在途、
				// 恰好此刻才落屏的那一份」。
				this.restoreSnapshotArrivalSequence += 1;
				const arrivedRestoreSnapshotArrivalSequence = this.restoreSnapshotArrivalSequence;
				void this.applyRestore(payload.snapshot, payload.cols, payload.rows)
					.then(() => {
						if (this.disposed || this.controlSocket !== controlSocket) {
							return;
						}
						this.restoreCompleted = true;
						this.sendControlMessage({ type: "restore_complete" });
						if (this.ioSocket && this.visibleContainer) {
							this.requestResize();
						}
						if (this.ioSocket) {
							this.notifyConnectionReady();
						}
						// 「重新同步画面」引发的 restore 绝不允许升级成一次杀 agent 的 refreshTaskTerminal，
						// 见 suppressNextStaleSessionAutoResumeTriggeredByViewResync 的字段注释；它的快照也不作为
						// 「mirror 已丢」的证据，见 latestAppliedRestoreWasEmptyAndNotTriggeredByViewResync。判定放在
						// notifyRestoreSnapshotApplied 之前：那个通知会唤醒 resync 的等待者，而等待者返回后
						// resync 的 finally 就把闩清了。
						this.latestAppliedRestoreWasEmptyAndNotTriggeredByViewResync =
							!payload.snapshot && !this.suppressNextStaleSessionAutoResumeTriggeredByViewResync;
						this.staleAgentTerminalSessionAutomaticResumeScheduler.evaluateOnUserOpenSignal();
						this.notifyRestoreSnapshotApplied(arrivedRestoreSnapshotArrivalSequence);
					})
					.catch(() => {
						if (this.disposed || this.controlSocket !== controlSocket) {
							return;
						}
						this.lastError = "Terminal restore failed.";
						this.notifyLastError();
					});
				return;
			}
			if (payload.type === "state") {
				this.notifySummary(payload.summary);
				return;
			}
			if (payload.type === "exit") {
				const label = payload.code == null ? "session exited" : `session exited with code ${payload.code}`;
				void this.enqueueTerminalWrite(`\r\n[kanban] ${label}\r\n`);
				return;
			}
			if (payload.type === "error") {
				this.lastError = payload.message;
				this.notifyLastError();
				void this.enqueueTerminalWrite(`\r\n[kanban] ${payload.message}\r\n`);
			}
		};
		controlSocket.onerror = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.lastError = "Terminal control connection failed.";
			this.notifyLastError();
		};
		controlSocket.onclose = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.controlSocket = null;
			this.connectionReady = false;
			this.restoreCompleted = false;
			this.lastError = "Terminal control connection closed. Reconnecting...";
			this.notifyLastError();
			this.scheduleReconnect();
		};
	}

	private ensureConnected(): void {
		if (this.disposed) {
			return;
		}
		if (!this.ioSocket) {
			this.connectIo();
		}
		if (!this.controlSocket) {
			this.connectControl();
		}
	}

	private updateAppearance(appearance: PersistentTerminalAppearance): void {
		this.appearance = appearance;
		this.terminal.options.theme = {
			...this.terminal.options.theme,
			...createKanbanTerminalOptions({
				cursorColor: appearance.cursorColor,
				isMacPlatform,
				terminalBackgroundColor: appearance.terminalBackgroundColor,
				themeColors: appearance.themeColors ?? getTerminalThemeColors(),
			}).theme,
		};
	}

	deferAutomaticSessionResumeUntilVisibleMount(): void {
		if (this.isParked()) this.shouldDeferAutomaticSessionResumeUntilVisibleMount = true;
	}

	setAppearance(appearance: PersistentTerminalAppearance): void {
		this.updateAppearance(appearance);
	}

	subscribe(subscriber: PersistentTerminalSubscriber): () => void {
		this.subscribers.add(subscriber);
		subscriber.onLastError?.(this.lastError);
		subscriber.onTerminalContentPresenceChange?.(this.hasRenderedAnyTerminalContent);
		if (this.latestSummary) {
			subscriber.onSummary?.(this.latestSummary);
		}
		if (this.connectionReady) {
			subscriber.onConnectionReady?.(this.taskId);
		}
		subscriber.onAutomaticStaleSessionResumePhaseChange?.(
			this.staleAgentTerminalSessionAutomaticResumeScheduler.getPhase(),
		);
		return () => {
			this.subscribers.delete(subscriber);
		};
	}

	mount(
		container: HTMLDivElement,
		appearance: PersistentTerminalAppearance,
		options: MountPersistentTerminalOptions,
	): void {
		if (this.disposed) {
			return;
		}
		this.ensureConnected();
		this.updateAppearance(appearance);
		this.isMountedContainerVisible = options.isVisible !== false;
		this.isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView =
			options.isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView === true;
		const shouldKeepScrolledToBottom = this.shouldKeepScrolledToBottom();
		if (this.visibleContainer !== container) {
			this.visibleContainer = container;
			container.appendChild(this.hostElement);
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
		}
		this.resizeObserver = new ResizeObserver(() => {
			if (this.resizeTimer !== null) {
				clearTimeout(this.resizeTimer);
			}
			this.resizeTimer = setTimeout(() => {
				this.resizeTimer = null;
				this.requestResize();
			}, RESIZE_DEBOUNCE_MS);
		});
		this.resizeObserver.observe(container);
		if (options.isVisible !== false) {
			window.requestAnimationFrame(() => {
				this.requestResize();
				this.keepScrolledToBottom(shouldKeepScrolledToBottom);
				// 排下这一帧到回调真正执行之间，本终端可能已经被下一次切卡 unmount 到隐藏的 parking
				// root 去了——连按 alt+↑/↓ 翻卡时，两次 React commit 落在同一帧里就正好这样。此时若
				// 仍然 focus，就是把键盘焦点打进屏幕外那个**旧 task** 的终端：用户看着新卡，后续击键
				// 与 Ctrl+S 暂存却全进了旧 task 的 PTY。更糟的是这之后
				// `shouldHandOffKeyboardFocusToAgentEntryNow()` 会把泊车终端的 helper textarea 认成
				// 「用户正在编辑」，把随后每一次焦点交接请求都否决掉，焦点从此永久滞留在屏幕外。
				// 所以这里补上与 `requestResize()` 里 `if (!this.visibleContainer) return;` 同源的那道
				// 门：只有本终端此刻仍挂在发起这次 mount 的那个容器上，autoFocus 才算数。
				const isStillMountedOnMountRequestContainer = this.visibleContainer === container;
				// 每一次可见挂载都是「用户打开了这个任务」，包括从泊车区重新挂回来：那时 socket 没断、
				// 不会有新的 restore，以前的「只在 restore 落屏时判」在这里永远轮不到。
				if (isStillMountedOnMountRequestContainer) {
					this.shouldDeferAutomaticSessionResumeUntilVisibleMount = false;
					this.staleAgentTerminalSessionAutomaticResumeScheduler.evaluateOnUserOpenSignal();
				}
				if (
					options.autoFocus &&
					isStillMountedOnMountRequestContainer &&
					shouldHandOffKeyboardFocusToAgentEntryNow()
				) {
					this.terminal.focus();
				}
			});
		}
	}

	unmount(container: HTMLDivElement | null): void {
		if (this.disposed && this.visibleContainer === null) {
			return;
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.resizeTimer !== null) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		if (container && this.visibleContainer !== container) {
			return;
		}
		this.visibleContainer = null;
		this.isMountedContainerVisible = false;
		// 用户已经离开这个任务：还在等停留时长的自动续跑作废（快速翻卡时沿途的卡都走这里）。
		this.staleAgentTerminalSessionAutomaticResumeScheduler.cancelPendingVisibleDwell();
		// 泊车终端不在任何视图内部，接管者身份随之作废：否则一个曾在详情视图里挂过的终端被泊车后
		// 仍然放行 alt+↑/↓，而此刻详情视图早已卸载、热键无人注册，按键又落回被静默吞掉的老路。
		this.isMountedInsideAdjacentTaskCardNavigationHotkeyOwnerView = false;
		clearTerminalGeometry(this.taskId);
		this.parkingRoot.appendChild(this.hostElement);
	}

	// 「泊车」= 已 unmount 到隐藏 parkingRoot、当前没有任何可见容器挂载它（visibleContainer===null）。
	// 泊车终端仍持有 WebGL 上下文 + 两条 socket + scrollback，是 LRU 回收的唯一合法对象；
	// mounted（visibleContainer 非 null）的终端仍被 hook 的 terminalRef 引用，回收会调用已 dispose 实例。
	isParked(): boolean {
		return this.visibleContainer === null;
	}

	focus(): void {
		this.terminal.focus();
	}

	input(text: string): boolean {
		if (
			this.shouldDeferAutomaticSessionResumeUntilVisibleMount ||
			!this.ioSocket ||
			this.ioSocket.readyState !== WebSocket.OPEN
		) {
			return false;
		}
		this.terminal.input(text);
		return true;
	}

	paste(text: string): boolean {
		if (
			this.shouldDeferAutomaticSessionResumeUntilVisibleMount ||
			!this.ioSocket ||
			this.ioSocket.readyState !== WebSocket.OPEN
		) {
			return false;
		}
		this.terminal.paste(text);
		return true;
	}

	readScrollbackTranscript(): TerminalScrollbackTranscriptLogicalLine[] {
		return extractTerminalScrollbackTranscriptLogicalLines(this.terminal);
	}

	hasScrollbackTranscriptContent(): boolean {
		return hasTerminalScrollbackTranscriptContent(this.terminal);
	}

	isScrolledAwayFromLatest(): boolean {
		return this.scrolledAwayFromLatest;
	}

	scrollToLatest(): void {
		this.terminal.scrollToBottom();
		this.refreshScrolledAwayFromLatest();
	}

	clear(): void {
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(() => {
				if (this.disposed) {
					return;
				}
				this.terminal.clear();
			});
	}

	searchNext(query: string, options: Pick<ISearchOptions, "caseSensitive"> = {}): boolean {
		const normalizedQuery = query.trim();
		if (!normalizedQuery) {
			this.clearSearch();
			this.notifySearchResults({ resultCount: 0, resultIndex: -1 });
			return false;
		}
		return this.searchAddon.findNext(normalizedQuery, {
			...options,
			decorations: SEARCH_DECORATIONS,
			incremental: true,
		});
	}

	searchPrevious(query: string, options: Pick<ISearchOptions, "caseSensitive"> = {}): boolean {
		const normalizedQuery = query.trim();
		if (!normalizedQuery) {
			this.clearSearch();
			this.notifySearchResults({ resultCount: 0, resultIndex: -1 });
			return false;
		}
		return this.searchAddon.findPrevious(normalizedQuery, {
			...options,
			decorations: SEARCH_DECORATIONS,
		});
	}

	clearSearch(): void {
		this.searchAddon.clearDecorations();
		this.terminal.clearSelection();
	}

	reset(): void {
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(() => {
				if (this.disposed) {
					return;
				}
				this.terminal.reset();
			});
	}

	// 会话重启（sessionStartedAt 变了）时的清屏，清完立刻向服务端 mirror 要一份快照。只清不补会永久白屏：
	// sessionStartedAt 也会因为摘要错配而变（跨项目切换时同号任务的旧摘要残留），这时 PTY 根本没换，
	// agent 停在那里不会再有新输出。真重启时 mirror 本就是新会话的画面，补一份也无害。顺序有保证：
	// applyRestore 先等写队列（含这次 reset）再清屏写快照。
	resetForSessionRestartAndRequestServerMirrorSnapshot(): void {
		this.reset();
		this.requestSnapshotResync();
	}

	waitForLikelyPrompt(timeoutMs: number): Promise<boolean> {
		if (timeoutMs <= 0) {
			return Promise.resolve(false);
		}

		return new Promise((resolve) => {
			let buffer = "";
			let sawInterruptAcknowledgement = false;
			let settled = false;
			let idleTimer: number | null = null;

			const cleanup = (result: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				window.clearTimeout(timeoutId);
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				unsubscribe();
				resolve(result);
			};

			const scheduleIdleCompletion = () => {
				if (!sawInterruptAcknowledgement) {
					return;
				}
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				idleTimer = window.setTimeout(() => {
					cleanup(true);
				}, INTERRUPT_IDLE_SETTLE_MS);
			};

			const unsubscribe = this.subscribe({
				onOutputText: (text) => {
					buffer = appendTerminalHeuristicText(buffer, text);
					if (hasLikelyShellPrompt(buffer)) {
						cleanup(true);
						return;
					}
					if (hasInterruptAcknowledgement(buffer)) {
						sawInterruptAcknowledgement = true;
					}
					scheduleIdleCompletion();
				},
			});

			const timeoutId = window.setTimeout(() => {
				cleanup(false);
			}, timeoutMs);
		});
	}

	async stop(): Promise<void> {
		this.sendControlMessage({ type: "stop" });
		const trpcClient = getRuntimeTrpcClient(this.workspaceId);
		await trpcClient.runtime.stopTaskSession.mutate({ taskId: this.taskId });
	}

	// 只把画面重新同步一遍，**不碰 PTY、不碰 agent 进程**——与下面那个 refresh() 是彻底不同的两件事。
	//
	// 服务端始终维护一份独立于任何 viewer、实时更新的终端 mirror；「TUI 冻住了」几乎总是这条 viewer 侧的
	// 通路坏了（客户端写队列卡死、服务端 restoreComplete 闸门永远解不开、半开的 socket 不触发 onclose），
	// 而不是 agent 出了事。这个方法就是把这条通路整条重建一遍，屏幕从 mirror 重画，agent 全程不知情。
	//
	// 递进自愈，一个按钮覆盖已知的全部卡死形态：
	//   ① 解掉可能正卡着的可见性恢复门控，并按当前真实的 visibilityState 重算派生位（修状态漂移）；
	//   ② 丢掉可能已经死掉的写队列，否则快照永远排在它后面；
	//   ③ 重新武装门控、发 request_restore，等一份新快照落屏；
	//   ④ 等不到就升级：换 clientId 重连两条 socket，服务端在 control 连上时无条件重推快照，握手整条重来。
	//
	// 不变式：这条路径上不存在任何能到达 refreshTaskTerminal 的分支——全程只有 WebSocket 上的
	// request_restore，不进 tRPC、不产生 TaskSessionStartOrigin、不参与自动重启熔断记账、不改
	// sessionStartedAt。唯一一处需要显式堵的漏是陈旧会话自动续跑（它在每次 restore 应用上评估），
	// 由 suppressNextStaleSessionAutoResumeTriggeredByViewResync 这道闩压住。
	async resyncTerminalViewFromServerMirrorWithoutRestartingAgentSession(): Promise<void> {
		if (this.disposed) {
			return;
		}
		// 闩必须在发出 request_restore **之前**置起，才能覆盖本次 resync 引发的每一次 restore 应用——
		// 包括升级重连后服务端无条件重推的那一份。
		this.suppressNextStaleSessionAutoResumeTriggeredByViewResync = true;
		try {
			this.endAwaitingRestoreSnapshotGate();
			const documentVisible = typeof document === "undefined" || document.visibilityState === "visible";
			this.documentVisible = documentVisible;
			this.renderingSuspended = !documentVisible;
			this.needsSnapshotResync = false;
			this.discardStalledTerminalWriteQueue();
			this.beginAwaitingRestoreSnapshotGate();
			// 基线卡在发出请求的这一刻：在此之前就已到达、只是还没落屏的快照都不算「本次 resync 请求到的
			// 那一份」，不能拿来提前满足下面的等待（否则闩会在本次快照落地之前就被 finally 清掉）。
			const restoreSnapshotArrivalSequenceBeforeResyncRequest = this.restoreSnapshotArrivalSequence;
			this.requestSnapshotResync();
			if (
				await this.waitForRestoreSnapshotApplication(
					restoreSnapshotArrivalSequenceBeforeResyncRequest,
					RESYNC_TERMINAL_VIEW_RESTORE_SNAPSHOT_DEADLINE_MS,
				)
			) {
				return;
			}
			// 升级。重连后服务端会重新走一遍 restore 握手，所以这里不必再发 request_restore；写队列再清一次，
			// 因为上一轮那份迟到的快照可能已经把切片排进了那条卡死的队列。
			this.discardStalledTerminalWriteQueue();
			// 第二段的基线独立重取：它等的是**重连之后**才到达的那份快照。第一段那份迟到的快照虽然已被
			// applyRestore().then() 里的 `this.controlSocket !== controlSocket` 守卫挡在水位之外，但把这条
			// 不变式押在另一个函数的守卫上太脆——在本地把基线取准，两段等待各自的语义才是自洽的。
			const restoreSnapshotArrivalSequenceBeforeEscalatedReconnect = this.restoreSnapshotArrivalSequence;
			this.reconnectTerminalSocketsUnderRotatedClientId();
			await this.waitForRestoreSnapshotApplication(
				restoreSnapshotArrivalSequenceBeforeEscalatedReconnect,
				RESYNC_TERMINAL_VIEW_ESCALATED_RECONNECT_RESTORE_SNAPSHOT_DEADLINE_MS,
			);
		} finally {
			// 无条件清闩（成功应用 / 整体超时放弃都算流程终结）：留着不清等于把「自动接回陈旧会话」这个
			// 功能在这个终端实例上永久关掉。
			this.suppressNextStaleSessionAutoResumeTriggeredByViewResync = false;
		}
	}

	// taskSessionStartOriginDeclaredByClient 纯归因、不改行为：默认不传即由服务端记成 refresh_task_terminal
	// （人点的刷新），只有陈旧会话自动续跑这条自动路径显式声明自己。不这样声明的话，服务端
	// 收到的两种请求逐字相同，而 refresh 实测占 pty 创建量的 68%——「这 68% 里有多少是程序自己点的」
	// 正是排查会话反复重建时的第一个问题。
	//
	// adoptExistingAgentConversationAsTaskSessionIdentity：「从既有对话迁入」——服务端先把这段对话复制进本会话的
	// 工作目录并钉成身份，再按 id 续跑（见 api-contract 的同名字段）。只由人在终端面板上选定后传入。
	async refresh(
		taskSessionStartOriginDeclaredByClient?: "stale_session_client_auto_resume",
		adoptExistingAgentConversationAsTaskSessionIdentity?: RuntimeTaskAgentSessionInitialization,
		// 「停止后台会话并在这里续跑」：只有人在终端面板上确认后才传 true（服务端语义见 api-contract 同名字段）。
		forceStopHarnessBackgroundSessionHoldingResumeTargetConfirmedByUser?: boolean,
	): Promise<{ ok: boolean; error?: string; mode?: "resume" | "fresh" }> {
		this.suppressNextRestartReset = true;
		const trpcClient = getRuntimeTrpcClient(this.workspaceId);
		try {
			const result = await trpcClient.runtime.refreshTaskTerminal.mutate({
				taskId: this.taskId,
				cols: this.terminal.cols,
				rows: this.terminal.rows,
				taskSessionStartOriginDeclaredByClient,
				...(adoptExistingAgentConversationAsTaskSessionIdentity
					? { adoptExistingAgentConversationAsTaskSessionIdentity }
					: {}),
				...(forceStopHarnessBackgroundSessionHoldingResumeTargetConfirmedByUser
					? { forceStopHarnessBackgroundSessionHoldingResumeTargetConfirmedByUser: true }
					: {}),
			});
			if (!result.ok) {
				this.suppressNextRestartReset = false;
			}
			return { ok: result.ok, error: result.error, mode: result.mode };
		} catch (error) {
			this.suppressNextRestartReset = false;
			throw error;
		}
	}

	consumeRestartResetSuppression(): boolean {
		const value = this.suppressNextRestartReset;
		this.suppressNextRestartReset = false;
		return value;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.staleAgentTerminalSessionAutomaticResumeScheduler.dispose();
		if (typeof document !== "undefined") {
			document.removeEventListener("visibilitychange", this.handleVisibilityChange);
		}
		this.clearReconnectTimer();
		this.clearAwaitingRestoreSnapshotTimeoutTimer();
		// 在途的 resync 等待者不再可能被唤醒；丢掉引用，让它们各自到点以「没等到」收场。
		this.restoreSnapshotApplicationWaiters.clear();
		this.unmount(this.visibleContainer);
		this.ioSocket?.close();
		this.controlSocket?.close();
		this.ioSocket = null;
		this.controlSocket = null;
		this.subscribers.clear();
		this.terminal.dispose();
		this.hostElement.remove();
	}
}

const terminals = new Map<string, PersistentTerminal>();

// 同时存活的客户端 xterm 上限：保留全部 mounted（可见挂载中）的 + 最近 MAX_PARKED_TERMINALS 个 parked 的，
// 其余 dispose 回收（释放 WebGL 上下文 + 两条 socket + scrollback）。曾经的实现只「泊车」不回收，导致一个
// 标签页里每看过一个任务就泄漏一个活终端、无上限（还会撞浏览器约 16 个 WebGL 上下文的硬上限）。
// 服务端 mirror 持完整 scrollback，被回收任务 revisit 时重连并从快照完整恢复，故回收对用户几乎无感。
// N=2 让最近来回切的两三个任务仍即时；更久以前看过的回收掉，回到时走一次与「切回隐藏标签页/刷新页面」相同的重连。
// ponytail: Map 迭代严格按插入序 = LRU；cache hit 时 delete 再 set 重排为 MRU（Map.set 对已存在 key 不改顺序），无需额外时间戳。
const MAX_PARKED_TERMINALS = 2;

function reclaimParkedTerminalsBeyondLimit(): void {
	const parkedKeys: string[] = [];
	for (const [key, terminal] of terminals) {
		if (terminal.isParked()) {
			parkedKeys.push(key);
		}
	}
	// parkedKeys 头部最旧、尾部最新（Map 插入序）；只回收超出上限的最旧若干个。
	// 必须 Math.max(0, …) clamp：slice(0, 负数) 会从尾部反向取值，反而错误驱逐最近的终端。
	const evictCount = Math.max(0, parkedKeys.length - MAX_PARKED_TERMINALS);
	for (const key of parkedKeys.slice(0, evictCount)) {
		terminals.get(key)?.dispose();
		terminals.delete(key);
	}
}

export function ensurePersistentTerminal(input: EnsurePersistentTerminalInput): PersistentTerminal {
	const key = buildKey(input.workspaceId, input.taskId);
	const existing = terminals.get(key);
	if (existing) {
		if (input.deferAutomaticSessionResumeUntilVisibleMount) existing.deferAutomaticSessionResumeUntilVisibleMount();
		existing.setAppearance({
			cursorColor: input.cursorColor,
			terminalBackgroundColor: input.terminalBackgroundColor,
			themeColors: input.themeColors,
		});
		// 重排为 MRU：Map.set 对已存在 key 不改插入顺序，必须先 delete 再 set 才能移到末尾。
		terminals.delete(key);
		terminals.set(key, existing);
		reclaimParkedTerminalsBeyondLimit();
		return existing;
	}
	const terminal = new PersistentTerminal(
		input.taskId,
		input.workspaceId,
		{
			cursorColor: input.cursorColor,
			terminalBackgroundColor: input.terminalBackgroundColor,
			themeColors: input.themeColors,
		},
		input.deferAutomaticSessionResumeUntilVisibleMount,
	);
	terminals.set(key, terminal);
	// 刚创建的终端尚未 mount（isParked()===true）但处于 parkedKeys 末尾（最新），不会被本次 sweep 回收。
	reclaimParkedTerminalsBeyondLimit();
	return terminal;
}

export function disposePersistentTerminal(workspaceId: string, taskId: string): void {
	const key = buildKey(workspaceId, taskId);
	const terminal = terminals.get(key);
	if (!terminal) {
		return;
	}
	terminal.dispose();
	terminals.delete(key);
}

export function disposeAllPersistentTerminalsForWorkspace(workspaceId: string): void {
	for (const [key, terminal] of terminals.entries()) {
		if (!key.startsWith(`${workspaceId}:`)) {
			continue;
		}
		terminal.dispose();
		terminals.delete(key);
	}
	// 这个 workspace 的终端被整体拆掉了，它的续跑冷却也一并作废：冷却拦的是「实例 churn 导致
	// 重复放电」，而整体拆除是一条粗粒度的、由外部显式触发的边界，不属于那种 churn。
	// 注意与 disposePersistentTerminal 的区别——**那**条恰恰是切卡片时的实例 churn 本身，
	// 在那里清冷却等于把这道守卫整个废掉。
	forgetStaleSessionAutoResumeCooldownsForWorkspace(workspaceId);
}
