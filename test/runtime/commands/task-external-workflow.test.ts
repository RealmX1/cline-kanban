import type { TRPCClient } from "@trpc/client";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerTaskExternalWorkflowCommands } from "../../../src/commands/task-external-workflow";
import type { RuntimeAppRouter } from "../../../src/trpc/app-router";

vi.mock("node:fs/promises", () => ({
	readFile: async () =>
		JSON.stringify({
			taskId: "task-1",
			expectedTaskIncarnationCreatedAtEpochMs: 1,
			externalWorkflowRunBinding: {
				workflowProviderId: "software-factory",
				workflowKind: "research",
				workItemId: "item-1",
				runId: "run-1",
				workflowDatabasePath: "/persistent/workflows.sqlite",
				artifactDirectoryPath: "/persistent/artifacts",
			},
		}),
}));

describe("task external-workflow CLI", () => {
	it("get 只读；无绑定或换代引用不创建、派发或重绑", async () => {
		const mutation = vi.fn();
		const state = { board: { columns: [{ cards: [{ id: "task-1", createdAt: 1 }] }] } };
		const query = vi.fn(async () => state);
		const outputs: Record<string, unknown>[] = [];
		const program = new Command();
		registerTaskExternalWorkflowCommands(program, {
			resolveWorkspace: async () => "workspace-1",
			createClient: () =>
				({
					workspace: { getState: { query } },
					taskCardAction: { updateTaskCardFieldValues: { mutate: mutation } },
				}) as unknown as TRPCClient<RuntimeAppRouter>,
			run: async (action) => {
				outputs.push(await action());
			},
		});
		await program.parseAsync(["external-workflow", "get", "--task-id", "task-1"], { from: "user" });
		expect(outputs[0]).toMatchObject({ bindingAvailability: "unbound", externalWorkflowRunBinding: null });
		expect(query).toHaveBeenCalledOnce();
		expect(mutation).not.toHaveBeenCalled();
	});
	it("bind 只把归属齐全的引用送进已有 runtime 写漏斗", async () => {
		const mutation = vi.fn(async (request) => ({
			taskCardSnapshotAfterAction: {
				taskCard: {
					externalWorkflowRunBinding:
						request.taskCardFieldUpdate.taskCardFieldValuePatch.externalWorkflowRunBinding,
				},
			},
		}));
		const program = new Command();
		registerTaskExternalWorkflowCommands(program, {
			resolveWorkspace: async () => "workspace-1",
			createClient: () =>
				({
					taskCardAction: { updateTaskCardFieldValues: { mutate: mutation } },
				}) as unknown as TRPCClient<RuntimeAppRouter>,
			run: async (action) => {
				await action();
			},
		});
		await program.parseAsync(["external-workflow", "bind", "--request-file", "/persistent/binding.json"], {
			from: "user",
		});
		expect(mutation).toHaveBeenCalledOnce();
		expect(mutation.mock.calls[0]?.[0]).toMatchObject({
			taskId: "task-1",
			expectedTaskIncarnationCreatedAtEpochMs: 1,
			taskCardFieldUpdate: {
				taskCardFieldValuePatch: {
					externalWorkflowRunBinding: {
						owningWorkspaceId: "workspace-1",
						owningTaskId: "task-1",
						owningTaskIncarnationCreatedAtEpochMs: 1,
					},
				},
			},
		});
	});
});
