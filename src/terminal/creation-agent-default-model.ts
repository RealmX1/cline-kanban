import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";

import type { RuntimeAgentId } from "../core/api-contract";
import { getTerminalAgentModelSelectionOptions } from "./terminal-agent-model-selection";

async function readOmpDefaultModelWithoutStartingModelTurn(workingDirectory: string): Promise<string> {
	const child = spawn("omp", ["--mode", "rpc", "--no-session"], {
		cwd: workingDirectory,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const lines = createInterface({ input: child.stdout });
	try {
		return await new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error("OMP 默认模型读取超时，未创建侧会话或发送模型请求。")),
				15_000,
			);
			const settle = (error?: Error, modelId?: string) => {
				clearTimeout(timeout);
				if (error) reject(error);
				else if (modelId) resolve(modelId);
			};
			child.once("error", (error) => settle(error));
			child.stdin.once("error", (error) => settle(error));
			child.once("close", () => settle(new Error("OMP 未返回默认模型，保留创建草稿。")));
			child.stderr.resume();
			lines.on("line", (line) => {
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					return;
				}
				const response = z
					.object({
						id: z.literal("kanban-creation-default-model"),
						type: z.literal("response"),
						success: z.boolean(),
						data: z.object({ model: z.object({ provider: z.string(), id: z.string() }) }).optional(),
					})
					.safeParse(value);
				if (!response.success) return;
				const model = response.data.data?.model;
				settle(
					model ? undefined : new Error("OMP 当前默认模型不可用。"),
					model ? `${model.provider}/${model.id}` : undefined,
				);
			});
			child.stdin.write(`${JSON.stringify({ id: "kanban-creation-default-model", type: "get_state" })}\n`);
		});
	} finally {
		lines.close();
		child.kill("SIGKILL");
	}
}

// 读取创建时的 Agent 默认配置，不探测或继承来源会话的临时模型。
export async function readCreationAgentDefaultModel(
	agentId: RuntimeAgentId,
	workingDirectory: string,
	explicitModelId?: string,
): Promise<{ modelId: string | null }> {
	if (agentId === "claude") return { modelId: explicitModelId ?? "default" };
	// Codex 的原生 profile、项目层和启动参数共同决定模型，建卡时只物化明确的模型选择。
	if (agentId === "codex") return { modelId: explicitModelId ?? null };

	if (explicitModelId) return { modelId: explicitModelId };
	if (agentId === "omp") {
		return { modelId: await readOmpDefaultModelWithoutStartingModelTurn(workingDirectory) };
	}
	if (agentId === "cursor" || agentId === "kimi")
		return { modelId: (await getTerminalAgentModelSelectionOptions(agentId)).defaultModelId };
	return { modelId: null };
}

/**
 * 默认模型探测失败时，未要求原生会话初始化的建卡继续进行。
 * 显式模型由调用方另传；这里只避免离线探测挡住 Backlog。
 */
export async function readCreationAgentDefaultModelWithoutBlockingBacklogCard(
	readDefaultModel: () => Promise<{ modelId: string | null }>,
	input: { taskAgentSessionInitialization?: unknown },
): Promise<{ modelId: string | null }> {
	try {
		return await readDefaultModel();
	} catch (error) {
		if (input.taskAgentSessionInitialization) throw error;
		return { modelId: null };
	}
}
