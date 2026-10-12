// agent session PTY host 进程入口（打包为 dist/agent-session-pty-host.js；源码态由 tsx 直接运行本文件）。
// 主逻辑与进程形态说明见 agent-session-pty-host-process-main.ts；本文件只负责注入 process.exit。

import { runAgentSessionPtyHostProcess } from "./agent-session-pty-host-process-main";

void runAgentSessionPtyHostProcess(process.argv.slice(2), (exitCode) => process.exit(exitCode)).catch(
	(error: unknown) => {
		process.stderr.write(
			`agent session pty host failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(1);
	},
);
