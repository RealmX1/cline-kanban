// 对真实 ACP agent 的协议级冒烟。不经 Kanban 的 UI 与看板状态机，用来最快定位
// 「Kanban 的 ACP 客户端 ↔ agent」之间的协议不匹配。
//
//   npx tsx scripts/acp-protocol-smoke.ts
//
// 前置：`omp` 在 PATH 上，且 omp 已完成 provider 登录（ACP 直接复用 ~/.omp 的凭据）。
// 用别的 ACP agent 冒烟时传 env：KANBAN_ACP_SMOKE_BINARY / KANBAN_ACP_SMOKE_ARGS（逗号分隔）。
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
	ACP_AGENT_METHODS,
	ACP_PROTOCOL_VERSION,
	buildKanbanAcpClientCapabilities,
	connectKanbanAcpClient,
	createAcpNdJsonStreamOverChildProcessStdio,
} from "../src/acp-client-session/acp-protocol-boundary";

const SMOKE_PROMPT = "List the .ts files in the current directory using a tool, then reply with DONE.";

async function main(): Promise<void> {
	const binary = process.env.KANBAN_ACP_SMOKE_BINARY ?? "omp";
	const args = (process.env.KANBAN_ACP_SMOKE_ARGS ?? "acp,--approval-mode,yolo").split(",").filter(Boolean);

	const workdir = mkdtempSync(join(tmpdir(), "kanban-acp-smoke-"));
	writeFileSync(join(workdir, "alpha.ts"), "export const alpha = 1;\n");
	writeFileSync(join(workdir, "beta.ts"), "export const beta = 2;\n");

	const child = spawn(binary, args, {
		cwd: workdir,
		env: { ...process.env, OMP_SKIP_SETUP: "1", PI_NO_TITLE: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildProcessByStdio<Writable, Readable, Readable>;

	let agentStderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		agentStderr += chunk;
	});

	const observedUpdateKinds = new Set<string>();
	let agentText = "";
	const connection = connectKanbanAcpClient(createAcpNdJsonStreamOverChildProcessStdio(child), {
		handleSessionUpdate: (notification) => {
			const update = notification.update;
			observedUpdateKinds.add(update.sessionUpdate);
			if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
				agentText += update.content.text;
			}
		},
		handlePermissionRequest: async (request) => {
			const allowOnce = request.options.find((option) => option.kind === "allow_once") ?? request.options[0];
			console.log(`  [permission] auto-allowing ${request.toolCall.title ?? request.toolCall.toolCallId}`);
			return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
		},
		handleElicitationRequest: async (request) => {
			console.log(`  [elicitation] mode=${request.mode} message=${JSON.stringify(request.message)}`);
			return { action: "cancel" };
		},
	});

	try {
		const initializeResponse = await connection.agent.request(ACP_AGENT_METHODS.initialize, {
			protocolVersion: ACP_PROTOCOL_VERSION,
			clientCapabilities: buildKanbanAcpClientCapabilities(),
		});
		console.log(`initialize   protocolVersion=${initializeResponse.protocolVersion}`);
		console.log(`             agent=${JSON.stringify(initializeResponse.agentInfo ?? null)}`);

		const newSessionResponse = await connection.agent.request(ACP_AGENT_METHODS.session_new, {
			cwd: workdir,
			mcpServers: [],
		});
		console.log(`session/new  sessionId=${newSessionResponse.sessionId}`);
		console.log(`             modes=${JSON.stringify(newSessionResponse.modes ?? null)}`);

		const promptResponse = await connection.agent.request(ACP_AGENT_METHODS.session_prompt, {
			sessionId: newSessionResponse.sessionId,
			prompt: [{ type: "text", text: SMOKE_PROMPT }],
		});
		console.log(`prompt       stopReason=${promptResponse.stopReason}`);
		console.log(`             updates=${[...observedUpdateKinds].sort().join(", ")}`);
		console.log(`             text=${JSON.stringify(agentText.slice(0, 300))}`);

		const assertions: Array<[string, boolean]> = [
			["agent_message_chunk received", observedUpdateKinds.has("agent_message_chunk")],
			["tool_call received", observedUpdateKinds.has("tool_call")],
			["turn ended cleanly", promptResponse.stopReason === "end_turn"],
		];
		let failed = false;
		for (const [label, passed] of assertions) {
			console.log(`${passed ? "PASS" : "FAIL"}  ${label}`);
			failed ||= !passed;
		}
		if (failed) {
			console.log(
				"\nNote: a failing tool_call assertion with a provider error in the agent text means the agent's " +
					"model credentials are unavailable, not that the protocol layer is broken.",
			);
		}
		process.exitCode = failed ? 1 : 0;
	} catch (error) {
		console.error("ACP smoke failed:", error);
		console.error("agent stderr:\n", agentStderr.slice(-4000));
		process.exitCode = 1;
	} finally {
		connection.close();
		child.kill("SIGTERM");
	}
}

void main();
