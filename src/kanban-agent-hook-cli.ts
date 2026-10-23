import { Command } from "commander";
import { registerHooksCommand } from "./commands/hooks";
import {
	installCliFatalErrorHandlers,
	installCliHardTimeoutIfNeeded,
	registerCliProcessExit,
	safeErrorMessage,
} from "./core/cli-process-guards";

// 独立 CLI 边界：只装载 hook 处理器，不初始化 runtime、Cline SDK 或遥测。
registerCliProcessExit((code) => process.exit(code));
installCliFatalErrorHandlers();

async function runKanbanAgentHookCli(): Promise<void> {
	const argv = process.argv.slice(2);
	// wrapper 持有 agent 整个生命周期，不能套用一次性 hook 的硬超时。
	const isLongRunningCodexWrapper = argv[0] === "hooks" && argv[1] === "codex-wrapper";
	const cancelHardTimeout = installCliHardTimeoutIfNeeded(argv, isLongRunningCodexWrapper);
	try {
		const program = new Command().name("kanban-agent-hook-cli").showHelpAfterError();
		registerHooksCommand(program);
		await program.parseAsync(argv, { from: "user" });
	} catch (error) {
		process.exitCode = 1;
		process.stderr.write(`Kanban hook 执行失败：${safeErrorMessage(error)}\n`);
	} finally {
		await Promise.allSettled(
			[process.stdout, process.stderr].map(
				(stream) =>
					new Promise<void>((resolve, reject) => {
						stream.write("", (error) => {
							if (error) reject(error);
							else resolve();
						});
					}),
			),
		);
		cancelHardTimeout();
		process.exit(process.exitCode ?? 0);
	}
}

void runKanbanAgentHookCli();
