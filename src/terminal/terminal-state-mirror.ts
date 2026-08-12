import serializeAddonModule from "@xterm/addon-serialize";
import headlessTerminalModule from "@xterm/headless";

import type { TerminalScreenLineSnapshot, TerminalScreenSnapshot } from "./terminal-input-box-reader";

const { SerializeAddon } = serializeAddonModule as typeof import("@xterm/addon-serialize");
const { Terminal } = headlessTerminalModule as typeof import("@xterm/headless");

// 全局「保留最近 2 万行」语义，须与客户端 TERMINAL_SCROLLBACK_LINES
// (web-ui/src/terminal/terminal-options.ts) 一致，且 server ≥ client：mirror 持有完整 scrollback，
// 客户端回收/重连时从这里整段恢复，故服务端不能比客户端短，否则恢复后丢可见历史。
const TERMINAL_SCROLLBACK = 20_000;

export interface TerminalRestoreSnapshot {
	snapshot: string;
	cols: number;
	rows: number;
}

interface TerminalStateMirrorOptions {
	onInputResponse?: (data: string) => void;
}

export class TerminalStateMirror {
	private readonly terminal: InstanceType<typeof Terminal>;
	private readonly serializeAddon = new SerializeAddon();
	private operationQueue: Promise<void> = Promise.resolve();
	// 序列化 20,000 行 scrollback 是一次同步、阻塞事件循环的重活。连续 attach 多个空闲（stalled）终端会把
	// 多次 serialize 背靠背排上事件循环。dirty-flag 缓存：仅当自上次 serialize 以来终端状态确有变化时才重新
	// 序列化，否则直接返回上次结果，让「打开一个没有新输出的终端」从重跑 20k 行坍缩为瞬时命中。
	//
	// 正确性依赖两点严格有序（都挂在同一个 operationQueue 上）：
	//   (1) dirty 只在写入/resize「被应用时」（队列任务体内）置位，绝不在入队时置位——否则一个在
	//       serialize 清位之后才应用的写入会被误清、导致缓存漏掉该写入；
	//   (2) serialize 本身也作为一个队列任务运行，故它只会在此刻之前入队的所有写入应用完成后执行，
	//       且之后到达的写入排在其后、会重新置位 dirty。
	private isSnapshotDirty = true;
	private cachedSnapshot: TerminalRestoreSnapshot | null = null;

	constructor(cols: number, rows: number, options: TerminalStateMirrorOptions = {}) {
		this.terminal = new Terminal({
			allowProposedApi: true,
			cols,
			rows,
			scrollback: TERMINAL_SCROLLBACK,
		});
		this.terminal.loadAddon(this.serializeAddon);
		this.terminal.onData((data) => {
			options.onInputResponse?.(data);
		});
	}

	applyOutput(chunk: Buffer): void {
		const chunkCopy = new Uint8Array(chunk);
		this.enqueueOperation(
			() =>
				new Promise<void>((resolve) => {
					this.terminal.write(chunkCopy, () => {
						// 写入「被应用」的时刻置 dirty（见类注释 (1)）。
						this.isSnapshotDirty = true;
						resolve();
					});
				}),
		);
	}

	resize(cols: number, rows: number): void {
		if (cols === this.terminal.cols && rows === this.terminal.rows) {
			return;
		}
		this.enqueueOperation(() => {
			this.terminal.resize(cols, rows);
			this.isSnapshotDirty = true;
		});
	}

	async getSnapshot(): Promise<TerminalRestoreSnapshot> {
		return await this.enqueueSnapshot();
	}

	// 只序列化当前活动屏（scrollback: 0，成本 rows×cols 级），供「提示符就绪判定」这类
	// 只看最后一屏的消费者使用。serialize 是同步的、执行期间阻塞整个事件循环——全量
	// getSnapshot() 最坏序列化 2 万行 scrollback，周期性调用（如 15s stall 扫描）会造成
	// 事件循环尖峰、冻结所有任务的键盘回显；就绪判定语义上本就只按当前视口判定，用本方法。
	async getViewportSnapshot(): Promise<TerminalRestoreSnapshot> {
		await this.operationQueue;
		return {
			snapshot: this.serializeAddon.serialize({ scrollback: 0 }),
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		};
	}

	// 按「行 + 软折行标记」读取当前活动屏，供 terminal-input-box-reader 做结构化读框
	// （提示符就绪判定、人机争用让路判定、Ctrl+S 暂存取文）。
	//
	// 为什么不复用 getViewportSnapshot()：那条路返回 serialize() 出来的**带 ANSI 的字符串**，
	// 行边界已被压平、逐行的软折行标记也没了，消费者只能再用正则去屏幕文本里捞特征。
	// 这里直接交出行结构，让消费者按「框的形状」判定，并且能原样取到框内文本（Ctrl+S 暂存需要）。
	//
	// 成本远低于 getViewportSnapshot：只遍历 rows 行、不做序列化，也不吃 serialize 那份
	// 阻塞事件循环的开销。仍排进 operationQueue，保证相对写入严格有序（否则会读到写入尚未
	// 应用的中间态）。
	async getScreenSnapshot(): Promise<TerminalScreenSnapshot> {
		await this.operationQueue;
		const buffer = this.terminal.buffer.active;
		const lines: TerminalScreenLineSnapshot[] = [];
		for (let rowOffset = 0; rowOffset < this.terminal.rows; rowOffset += 1) {
			const line = buffer.getLine(buffer.baseY + rowOffset);
			lines.push({
				// translateToString(false)：保留行内空白。输入框的续行缩进与提示符后的 U+00A0
				// 都是有意义的定位信息，去掉就没法剥前缀了。
				text: line?.translateToString(false) ?? "",
				isWrapped: line?.isWrapped ?? false,
			});
		}
		return { lines, columnCount: this.terminal.cols };
	}

	dispose(): void {
		this.terminal.dispose();
	}

	private enqueueOperation(operation: () => void | Promise<void>): void {
		this.operationQueue = this.operationQueue
			.catch(() => undefined)
			.then(async () => {
				await operation();
			});
	}

	// 把 serialize 排进 operationQueue（见类注释 (2)），使其相对写入严格有序，再据 dirty-flag 决定
	// 复用缓存还是重新序列化。
	private enqueueSnapshot(): Promise<TerminalRestoreSnapshot> {
		return new Promise<TerminalRestoreSnapshot>((resolve, reject) => {
			this.operationQueue = this.operationQueue
				.catch(() => undefined)
				.then(() => {
					try {
						resolve(this.serializeWithCache());
					} catch (error) {
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				});
		});
	}

	private serializeWithCache(): TerminalRestoreSnapshot {
		if (!this.isSnapshotDirty && this.cachedSnapshot !== null) {
			return this.cachedSnapshot;
		}
		const snapshot: TerminalRestoreSnapshot = {
			// 显式封顶 serialize 的 scrollback，使恢复 payload 不超过约定上限（即便 mirror buffer 更大）。
			// 直接决定客户端回收终端后 revisit 的重连+重放成本。
			snapshot: this.serializeAddon.serialize({ scrollback: TERMINAL_SCROLLBACK }),
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		};
		this.cachedSnapshot = snapshot;
		this.isSnapshotDirty = false;
		return snapshot;
	}
}
