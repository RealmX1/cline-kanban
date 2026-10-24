import { resolve } from "node:path";
import type { Command } from "commander";
import { loadWorkspaceContext } from "../state/workspace-state";
import { createRuntimeTrpcClient, printJson } from "./task";

export function registerCodexConversationStorageCommand(program: Command) {
	const command = program
		.command("codex-conversation-storage")
		.description("隔离看板 Codex 历史；活跃会话始终延后处理。");
	for (const operation of ["status", "migrate-stopped", "rollback-stopped"] as const) {
		command
			.command(operation)
			.option("--project-path <path>", "已注册项目的主仓库路径")
			.option("--conversation-session-id <id>", "仅处理指定的看板会话；省略时列出或处理该工作区全部已停止会话")
			.action(async (options: { projectPath?: string; conversationSessionId?: string }) => {
				try {
					const workspace = await loadWorkspaceContext(resolve(options.projectPath ?? process.cwd()), {
						autoCreateIfMissing: false,
					});
					const client = createRuntimeTrpcClient(workspace.workspaceId);
					const result = await client.runtime.operateCodexConversationStorage.mutate({
						operation:
							operation === "migrate-stopped"
								? "migrate_stopped"
								: operation === "rollback-stopped"
									? "rollback_stopped"
									: "status",
						conversationSessionId: options.conversationSessionId,
					});
					printJson({ ok: !result.entries.some((entry) => entry.status === "refused"), ...result });
					if (result.entries.some((entry) => entry.status === "refused")) process.exitCode = 1;
				} catch (error) {
					printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
					process.exitCode = 1;
				}
			});
	}
}
