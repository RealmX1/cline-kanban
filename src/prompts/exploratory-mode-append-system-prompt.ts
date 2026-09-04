// Exploratory Mode 启动注入段的解析器（蓝图 §A.2 效应 2）：仅当本次启动声明为探索型会话时，
// 物化 Kanban 托管指令文件并把它的绝对路径渲染成一段 append system prompt。
//
// 物化失败绝不阻断会话启动——退化为 null（不注入），与非 exploratory 启动零差异。
// 三条启动通道（Cline SDK / 终端 PTY）各自在既有 append-system-prompt 组合点并入本段；
// ACP 通道没有 system prompt 机制，不经过这里。

import type { RuntimeTaskConversationMode } from "../core/api-contract";
import { ensureExploratoryModeInstructionsFile } from "../state/exploratory-mode-instructions";
import { renderExploratoryModeAppendSystemPrompt } from "./append-system-prompt";

export async function resolveExploratoryModeAppendSystemPrompt(
	taskConversationMode: RuntimeTaskConversationMode | undefined,
): Promise<string | null> {
	if (taskConversationMode !== "exploratory") {
		return null;
	}
	try {
		const instructionsFilePath = await ensureExploratoryModeInstructionsFile();
		return renderExploratoryModeAppendSystemPrompt(instructionsFilePath);
	} catch {
		// 指令文件落盘失败不阻断会话启动：退化为不注入。
		return null;
	}
}
