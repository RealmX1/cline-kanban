// 终端 agent 输出反应框架的组装入口。
//
// session-manager 通过 `getDefaultOutputReactionEngine()` 拿到一个模块级单例引擎；
// 所有 per-session 状态由引擎的 createSessionState() 产出、session-manager 持有。

import { createConnectionDropAutoContinueReaction } from "./connection-drop-auto-continue";
import { createOutputReactionEngine, type OutputReaction, type OutputReactionEngine } from "./output-reaction";

export function buildDefaultOutputReactions(): OutputReaction[] {
	return [
		createConnectionDropAutoContinueReaction(),
		// 后续新增 reaction（配额提示自动处理、特定提示符自动应答等）在此追加。
	];
}

let cachedEngine: OutputReactionEngine | null = null;

export function getDefaultOutputReactionEngine(): OutputReactionEngine {
	if (cachedEngine === null) {
		cachedEngine = createOutputReactionEngine(buildDefaultOutputReactions());
	}
	return cachedEngine;
}

export type {
	OutputReactionActions,
	OutputReactionContext,
	OutputReactionEngine,
	OutputReactionSessionState,
} from "./output-reaction";
