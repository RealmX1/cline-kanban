import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectCodexMainSessionHandoverMaterial } from "../../../src/agent-session-history/codex-main-session-handover-material";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";

const directories: string[] = [];
afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(records: unknown[], nativeId = "native") {
	const directory = await mkdtemp(join(tmpdir(), "codex-handover-material-"));
	directories.push(directory);
	const path = join(directory, "native.jsonl");
	await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
	const sourceSummary = runtimeTaskSessionSummarySchema.parse({
		taskId: "task",
		agentId: "codex",
		workspacePath: directory,
		state: "awaiting_review",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: nativeId,
			transcriptPath: path,
			observedAt: 1,
		},
	});
	return {
		path,
		sourceSummary,
		card: {
			id: "task",
			title: "恢复主线",
			prompt: "原始需求",
			baseRef: "main",
			startInPlanMode: false,
			createdAt: 1,
			updatedAt: 1,
		},
		workspacePath: directory,
	};
}
const assistant = (text: string) => ({
	type: "response_item",
	payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
});
describe("Codex 交接材料按可信完整历史采集", () => {
	it("遍历多页、保留内嵌计划来源，去重后提取最后连续正文并排除工具内容", async () => {
		const records: unknown[] = [
			{ type: "session_meta", payload: { id: "native", source: "cli" } },
			assistant("<proposed_plan>旧主线计划\n继续第二阶段</proposed_plan>"),
		];
		for (let index = 0; index < 120; index++)
			records.push(
				{ type: "event_msg", payload: { type: "user_message", message: `历史用户输入 ${index}` } },
				assistant(`历史答复 ${index}`),
			);
		records.push(
			{
				type: "response_item",
				payload: {
					type: "function_call_output",
					call_id: "tool",
					output: "工具伪装正文 <proposed_plan>不是计划</proposed_plan>",
				},
			},
			{ type: "event_msg", payload: { type: "agent_message", message: "先说明现状" } },
			assistant("先说明现状"),
			{ type: "event_msg", payload: { type: "agent_message", message: "然后给出下一步" } },
			assistant("然后给出下一步"),
		);
		const input = await fixture(records);
		const material = await collectCodexMainSessionHandoverMaterial(input);
		expect(material.embeddedPlanReferences).toHaveLength(1);
		expect(material.embeddedPlanReferences?.[0]).toMatchObject({
			text: "旧主线计划\n继续第二阶段",
			approvalStatus: "unconfirmed",
		});
		expect(material.lastAgentMessage?.text).toBe("先说明现状\n\n然后给出下一步");
		expect(material.transcriptReferences).toEqual([input.path]);
		expect(material.embeddedPlanReferences?.[0].sourceReference).toContain("native-history:task:");
	});
	it("原生身份错误或后台整理记录不能成为交接正文", async () => {
		for (const payload of [
			{ id: "other", source: "cli" },
			{ id: "native", source: "memory_consolidation" },
		]) {
			const input = await fixture([{ type: "session_meta", payload }, assistant("错误身份的正文")]);
			const material = await collectCodexMainSessionHandoverMaterial(input);
			expect(material.lastAgentMessage).toBeNull();
			expect(material.missingMaterialDescriptions.length).toBeGreaterThan(0);
		}
	});
	it("存储归属已记录但路径暂缺时，自动找到唯一精确原生入口", async () => {
		const input = await fixture([]);
		const codexHome = join(input.workspacePath, "bound-codex-home");
		await mkdir(join(codexHome, "sessions"), { recursive: true });
		const transcript = join(codexHome, "sessions", "rollout-native.jsonl");
		await writeFile(
			transcript,
			`${JSON.stringify({ type: "session_meta", payload: { id: "native", source: "cli" } })}\n${JSON.stringify(assistant("绑定目录内的正文"))}\n`,
		);
		input.sourceSummary.codexConversationStorageHomeDirectoryPath = codexHome;
		assert(input.sourceSummary.agentNativeConversationSessionIdentity);
		input.sourceSummary.agentNativeConversationSessionIdentity.transcriptPath = null;
		const material = await collectCodexMainSessionHandoverMaterial(input);
		expect(material.lastAgentMessage?.text).toBe("绑定目录内的正文");
		expect(material.transcriptReferences).toEqual([transcript]);
	});
});
