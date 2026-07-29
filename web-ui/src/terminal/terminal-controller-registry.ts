import type { TerminalScrollbackTranscriptLogicalLine } from "@/terminal/terminal-scrollback-transcript-extraction";

export interface TerminalController {
	input: (text: string) => boolean;
	paste: (text: string) => boolean;
	waitForLikelyPrompt?: (timeoutMs: number) => Promise<boolean>;
	readScrollbackTranscript?: () => TerminalScrollbackTranscriptLogicalLine[];
	hasScrollbackTranscriptContent?: () => boolean;
	scrollToLatest?: () => void;
}

const controllersByTaskId = new Map<string, TerminalController>();

export function getTerminalController(taskId: string): TerminalController | null {
	return controllersByTaskId.get(taskId) ?? null;
}

export async function waitForTerminalLikelyPrompt(taskId: string, timeoutMs: number): Promise<boolean> {
	const controller = getTerminalController(taskId);
	if (!controller?.waitForLikelyPrompt) {
		return false;
	}
	return await controller.waitForLikelyPrompt(timeoutMs);
}

/**
 * 读取该任务终端的可阅读 transcript。终端未挂载（会话面板型 agent / 终端被泊车回收）时返回空数组，
 * 调用方据此隐藏阅读视图入口。
 */
export function readTerminalScrollbackTranscript(taskId: string): TerminalScrollbackTranscriptLogicalLine[] {
	return getTerminalController(taskId)?.readScrollbackTranscript?.() ?? [];
}

/**
 * 该任务终端是否存在值得单独阅读的 scrollback。alt-screen agent（Codex 等）在自己的
 * alternate buffer 里原地重绘、normal buffer 不增长，故这里返回 false、入口自动隐藏，
 * 而不是给出一个空壳阅读视图。
 */
export function hasTerminalScrollbackTranscriptContentForTask(taskId: string): boolean {
	return getTerminalController(taskId)?.hasScrollbackTranscriptContent?.() ?? false;
}

export function registerTerminalController(taskId: string, controller: TerminalController): () => void {
	controllersByTaskId.set(taskId, controller);
	return () => {
		if (controllersByTaskId.get(taskId) === controller) {
			controllersByTaskId.delete(taskId);
		}
	};
}
