// ACP 与原生核验共享同一个 App Server；这里只桥接帧，不接管 Agent 循环。
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createCodexAppServerLfDelimitedUtf8ResponseDecoder } from "../src/codex-native-session-protocol/codex-app-server-lf-delimited-utf8-response-decoder";

async function main() {
	const binary = process.env.KANBAN_COMPARISON_CODEX_BINARY;
	const socketPath = process.env.KANBAN_COMPARISON_CODEX_SOCKET_PATH;
	if (!binary || !socketPath || process.argv[2] !== "app-server") throw new Error("缺少隔离 App Server 桥接归属。");
	const child = spawn(binary, ["app-server", ...process.argv.slice(3), "--listen", `unix://${socketPath}`], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr.pipe(process.stderr);
	let exited = false;
	let startupError: Error | null = null;
	const closed = new Promise<void>((accept) => {
		child.once("error", (error) => {
			startupError = error;
			exited = true;
			accept();
		});
		child.once("close", () => {
			exited = true;
			accept();
		});
	});
	let socket: WebSocket | undefined;
	const stop = () => {
		socket?.terminate();
		child.kill("SIGTERM");
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	try {
		const deadline = Date.now() + 10_000;
		while (!(await stat(socketPath).catch(() => null))) {
			if (exited || Date.now() > deadline) throw startupError ?? new Error("ACP 所有的 App Server 未就绪。");
			await delay(25);
		}
		socket = new WebSocket(`ws+unix://${socketPath}:/`);
		const connected = socket;
		await new Promise<void>((accept, reject) => {
			connected.once("open", accept);
			connected.once("error", reject);
		});
		const inputDecoder = createCodexAppServerLfDelimitedUtf8ResponseDecoder((frame) => {
			if (frame.trim() && connected.readyState === WebSocket.OPEN) connected.send(frame);
		});
		process.stdin.on("data", (bytes: Buffer) => inputDecoder.write(bytes));
		process.stdin.once("end", stop);
		connected.on("message", (bytes) => process.stdout.write(`${bytes.toString()}\n`));
		await Promise.race([closed, new Promise<void>((accept) => connected.once("close", accept))]);
	} finally {
		stop();
		const escalation = setTimeout(() => child.kill("SIGKILL"), 2_000);
		await closed;
		clearTimeout(escalation);
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
	}
}
main().catch(() => {
	process.stderr.write("隔离 Codex App Server 桥接失败。\n");
	process.exitCode = 1;
});
