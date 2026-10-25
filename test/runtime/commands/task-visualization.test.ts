import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRPCClientError } from "@trpc/client";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTaskVisualizationCommand } from "../../../src/commands/task-visualization";

const runtimeMocks = vi.hoisted(() => ({
	runtimeHomeDirectoryPath: "",
	publish: vi.fn(),
	printJson: vi.fn(),
}));
vi.mock("../../../src/state/workspace-state", () => ({
	loadWorkspaceContext: async () => ({ workspaceId: "workspace-a", repoPath: "/registered-project" }),
}));
vi.mock("../../../src/state/runtime-home-path", () => ({
	getRuntimeHomePath: () => runtimeMocks.runtimeHomeDirectoryPath,
}));
vi.mock("../../../src/commands/task", () => ({
	createRuntimeTrpcClient: () => ({ taskVisualizationArtifacts: { publish: { mutate: runtimeMocks.publish } } }),
	printJson: runtimeMocks.printJson,
}));

let rootDirectoryPath: string;
let previousExitCode: typeof process.exitCode;
beforeEach(async () => {
	rootDirectoryPath = await mkdtemp(join(tmpdir(), "task-visualization-cli-rejection-"));
	runtimeMocks.runtimeHomeDirectoryPath = join(rootDirectoryPath, "runtime-home");
	runtimeMocks.publish.mockReset();
	runtimeMocks.printJson.mockReset();
	previousExitCode = process.exitCode;
	process.exitCode = undefined;
	await writeFile(join(rootDirectoryPath, "chart.html"), "<h1>持久发布包</h1>");
});
afterEach(async () => {
	process.exitCode = previousExitCode;
	await rm(rootDirectoryPath, { recursive: true, force: true });
});

async function runPublish() {
	const program = new Command();
	registerTaskVisualizationCommand(program.command("task"));
	await program.parseAsync(
		[
			"task",
			"visualization",
			"publish",
			"--task-id",
			"task-a",
			"--project-path",
			"/registered-project",
			"--source-html-file",
			join(rootDirectoryPath, "chart.html"),
			"--title",
			"图表",
		],
		{ from: "user" },
	);
	return runtimeMocks.printJson.mock.calls[0][0];
}

function apiError(code: string, message: string) {
	return TRPCClientError.from({ error: { code: -32000, message, data: { code } } });
}

describe("可视化 CLI 区分确定性拒绝与等待恢复", () => {
	it.each([
		["NOT_FOUND", "任务不存在"],
		["FORBIDDEN", "Done 任务只允许读取"],
		["BAD_REQUEST", "可视化发布包归属不匹配"],
	])("%s 返回失败退出并持久保留拒绝证据", async (code, message) => {
		runtimeMocks.publish.mockRejectedValue(apiError(code, message));
		const result = await runPublish();
		expect(process.exitCode).toBe(1);
		expect(result).toMatchObject({ ok: false, status: "runtime_acceptance_rejected", error: message });
		const publicationDirectory = result.pendingPublicationDirectoryPath;
		expect(JSON.parse(await readFile(join(publicationDirectory, "publication.json"), "utf8"))).toMatchObject({
			publicationRequestId: result.publicationRequestId,
		});
		expect(await readFile(join(publicationDirectory, "files", "chart.html"), "utf8")).toContain("持久发布包");
		expect(
			JSON.parse(await readFile(join(publicationDirectory, "runtime-acceptance-rejection.json"), "utf8")),
		).toMatchObject({ publicationRequestId: result.publicationRequestId, failureCode: code, failure: message });
		await expect(readFile(join(publicationDirectory, "accepted-artifact.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it.each([
		["网络断开", TRPCClientError.from(new Error("fetch failed"))],
		["服务端内部暂时错误", apiError("INTERNAL_SERVER_ERROR", "暂时无法写入磁盘")],
	])("%s 保留 durable pending，避免把未知结果记录为拒绝", async (_description, failure) => {
		runtimeMocks.publish.mockRejectedValue(failure);
		const result = await runPublish();
		expect(process.exitCode).toBeUndefined();
		expect(result).toMatchObject({ ok: true, status: "awaiting_runtime_acceptance" });
		const publicationDirectory = result.pendingPublicationDirectoryPath;
		expect(await readFile(join(publicationDirectory, "publication.json"), "utf8")).toContain(
			result.publicationRequestId,
		);
		await expect(readFile(join(publicationDirectory, "runtime-acceptance-rejection.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
