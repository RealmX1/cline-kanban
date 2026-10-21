// 此进程由原有 PTY host 持有；runtime 热重启不结束它，TUI 与 app-server 则与它同寿。
import { type ChildProcess, spawn } from "node:child_process";
import { open, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { appendDiagnosticEventToRotatingJsonlJournal } from "../diagnostics/rotating-jsonl-diagnostic-event-journal";
import { withRunningCodexAppServerControlSocketConnection } from "../rvf-automatic-closeout/codex-app-server-request-connection";
import {
	codexNativeSessionControlHostLaunchSpecificationSchema,
	removeOwnedCodexNativeSessionControlHostDirectories,
} from "./codex-native-session-control-host-launch-specification";
import { bootstrapCodexRemoteConversationBeforeTuiAttach } from "./codex-remote-conversation-bootstrap";

interface OwnedChildExit {
	code: number | null;
	error?: Error;
}

function observeOwnedChildExit(child: ChildProcess): Promise<OwnedChildExit> {
	return new Promise((resolveExit) => {
		child.once("error", (error) => resolveExit({ code: null, error }));
		child.once("close", (code) => resolveExit({ code }));
	});
}

async function stopOwnedChild(child: ChildProcess, exited: Promise<OwnedChildExit>) {
	if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
	child.kill("SIGTERM");
	const escalation = setTimeout(() => child.kill("SIGKILL"), 2_000);
	try {
		await exited;
	} finally {
		clearTimeout(escalation);
	}
}

async function waitUntilUnixSocketAcceptsConnections(socketPath: string, cancellation: AbortSignal) {
	const deadline = Date.now() + 10_000;
	while (!cancellation.aborted && Date.now() < deadline) {
		const acceptsConnections = await new Promise<boolean>((resolveConnected) => {
			const socket = connect(socketPath);
			const finish = (connected: boolean) => {
				socket.destroy();
				resolveConnected(connected);
			};
			socket.once("connect", () => finish(true));
			socket.once("error", () => finish(false));
			socket.setTimeout(200, () => finish(false));
		});
		if (acceptsConnections) return;
		await delay(50);
	}
	throw new Error(cancellation.aborted ? "原生控制宿主启动已取消。" : "原生控制宿主未在启动期限内就绪。");
}

async function runOwnedCodexNativeSessionControlHost() {
	const specificationPath = process.argv[2];
	if (!specificationPath) throw new Error("缺少本代原生控制宿主启动描述。");
	const specification = codexNativeSessionControlHostLaunchSpecificationSchema.parse(
		JSON.parse(await readFile(specificationPath, "utf8")),
	);
	const cancellation = new AbortController();
	let stopRequested!: () => void;
	const stopped = new Promise<void>((resolveStopped) => {
		stopRequested = resolveStopped;
	});
	let terminationExitCode: number | null = null;
	const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
	const listeners = signals.map((signal) => {
		const listener = () => {
			terminationExitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
			cancellation.abort();
			stopRequested();
		};
		process.on(signal, listener);
		return listener;
	});
	const children: { child: ChildProcess; exited: Promise<OwnedChildExit> }[] = [];
	let logFile: Awaited<ReturnType<typeof open>> | undefined;
	try {
		logFile = await open(join(specification.ownedLaunchDirectory.path, "app-server.stderr.log"), "wx", 0o600);
		const server = spawn(
			specification.codexBinary,
			[
				...specification.appServerRootArguments,
				"app-server",
				"--listen",
				`unix://${specification.endpoint.socketPath}`,
			],
			{
				cwd: specification.workingDirectoryPath,
				stdio: ["ignore", logFile.fd, logFile.fd],
			},
		);
		const serverExit = observeOwnedChildExit(server);
		children.push({ child: server, exited: serverExit });
		await Promise.race([
			waitUntilUnixSocketAcceptsConnections(specification.endpoint.socketPath, cancellation.signal),
			serverExit.then((exit) => {
				throw exit.error ?? new Error(`本代 Codex app-server 在就绪前退出（${exit.code}）。`);
			}),
			stopped.then(() => {
				throw new Error("本代原生控制宿主在启动期间收到停止信号。");
			}),
		]);
		const runTui = async (tuiArguments: string[]) => {
			const tui = spawn(
				specification.codexBinary,
				["--remote", `unix://${specification.endpoint.socketPath}`, ...tuiArguments],
				{ cwd: specification.workingDirectoryPath, stdio: "inherit" },
			);
			const tuiExit = observeOwnedChildExit(tui);
			children.push({ child: tui, exited: tuiExit });
			const outcome = await Promise.race([
				tuiExit.then((exit) => ({ kind: "tui" as const, exit })),
				serverExit.then((exit) => ({ kind: "server" as const, exit })),
				stopped.then(() => ({ kind: "stopped" as const })),
			]);
			if (outcome.kind === "tui") {
				if (outcome.exit.error) throw outcome.exit.error;
				process.exitCode = outcome.exit.code ?? 1;
			} else if (outcome.kind === "server") {
				throw outcome.exit.error ?? new Error("当前会话的原生控制宿主已退出，TUI 无法继续使用旧端点。");
			}
		};
		const plan = specification.remoteConversationLaunchPlan;
		if (plan) {
			await withRunningCodexAppServerControlSocketConnection(
				async (port) => {
					const receipt = await bootstrapCodexRemoteConversationBeforeTuiAttach(port, plan);
					const evidence = {
						...specification.endpoint,
						operation: plan.operation,
						nativeSessionId: receipt.nativeSessionId,
						nativeTranscriptPath: receipt.nativeTranscriptPath,
						effectiveApprovalPolicy: receipt.effectiveApprovalPolicy,
						effectiveSandbox: receipt.effectiveSandbox,
					};
					await writeFile(
						join(specification.ownedLaunchDirectory.path, "remote-conversation-bootstrap-receipt.json"),
						JSON.stringify(evidence),
						{ mode: 0o600, flag: "wx" },
					);
					appendDiagnosticEventToRotatingJsonlJournal("codex-remote-conversation-bootstrap-confirmed", evidence);
					// 保持启动连接存活，直到 TUI 退出；避免接入间隙中原生 thread 被卸载而丢失已核对的配置。
					await runTui(receipt.tuiArguments);
				},
				{
					socketPath: specification.endpoint.socketPath,
					clientName: "kanban_owned_conversation_bootstrap",
					requestTimeoutMs: 20_000,
					signal: cancellation.signal,
				},
			);
		} else {
			await runTui(specification.codexTuiArguments);
		}
	} finally {
		cancellation.abort();
		// 先同时停止所有子进程并撤销本代端点，不能等慢子进程耗尽外层强杀窗口后才删除目录。
		const stoppedChildren = Promise.all(children.map(({ child, exited }) => stopOwnedChild(child, exited)));
		try {
			await removeOwnedCodexNativeSessionControlHostDirectories([
				specification.ownedSocketDirectory,
				specification.ownedLaunchDirectory,
			]);
		} finally {
			await stoppedChildren;
			await logFile?.close();
		}
		for (const [index, signal] of signals.entries()) process.off(signal, listeners[index]);
		if (terminationExitCode !== null) process.exitCode = terminationExitCode;
	}
}

runOwnedCodexNativeSessionControlHost().catch((error: unknown) => {
	process.stderr.write(`Kanban 原生控制宿主失败：${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
