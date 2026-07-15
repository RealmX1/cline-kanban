import serializeAddonModule from "@xterm/addon-serialize";
import headlessTerminalModule from "@xterm/headless";

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
		});
	}

	async getSnapshot(): Promise<TerminalRestoreSnapshot> {
		await this.operationQueue;
		return {
			// 显式封顶 serialize 的 scrollback，使恢复 payload 不超过约定上限（即便 mirror buffer 更大）。
			// 直接决定客户端回收终端后 revisit 的重连+重放成本。
			snapshot: this.serializeAddon.serialize({ scrollback: TERMINAL_SCROLLBACK }),
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		};
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
}
