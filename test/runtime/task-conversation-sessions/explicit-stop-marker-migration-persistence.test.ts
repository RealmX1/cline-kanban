import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskConversationSessionOperationStore } from "../../../src/task-conversation-sessions/task-conversation-session-operation-store";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const scope = { workspaceId: "workspace-1", workspacePath: "/repo" };
const migration = { operationId: "operation-1", sourceWorkspaceId: "source-workspace" };

async function isolatedStore() {
	const directory = await mkdtemp(join(tmpdir(), "explicit-stop-migration-"));
	directories.push(directory);
	return {
		directory,
		operations: createTaskConversationSessionOperationStore(directory),
		markerPath: join(
			directory,
			"explicit-session-stop-markers",
			`${createHash("sha256").update(scope.workspaceId).digest("hex")}.json`,
		),
	};
}

describe("显式 Stop 的合并复制边界", () => {
	it("旧的会话 ID 数组仍可读，普通解除继续写回数组", async () => {
		const { operations, markerPath } = await isolatedStore();
		await operations.recordExplicitStopMarkers(scope, ["kept", "cleared"]);
		expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual(["kept", "cleared"]);
		await operations.clearExplicitStopMarker(scope, "cleared");
		expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual(["kept"]);
		expect((await operations.read(scope)).explicitlyStoppedSessionIds).toEqual(["kept"]);
	});

	it("一次复制与名单同文件提交，解除后同一合并不再加回，后续来源 Stop 也不补进", async () => {
		const { operations, markerPath } = await isolatedStore();
		await operations.recordExplicitStopMarkers(scope, ["already-there"]);
		await operations.migrateTransferredExplicitStopMarkers(scope, migration, ["already-there", "from-source"]);
		expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual({
			schemaVersion: 1,
			sessionIds: ["already-there", "from-source"],
			appliedDuplicateProjectStopMigrations: [migration],
		});
		await operations.clearExplicitStopMarker(scope, "from-source");
		await operations.migrateTransferredExplicitStopMarkers(scope, migration, [
			"already-there",
			"from-source",
			"appeared-later",
		]);
		expect((await operations.read(scope)).explicitlyStoppedSessionIds).toEqual(["already-there"]);
		expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({
			sessionIds: ["already-there"],
			appliedDuplicateProjectStopMigrations: [migration],
		});
	});

	it("另一次合并仍可复制自己的 Stop，空来源且没有独立文件时不制造空名单", async () => {
		const { operations, markerPath } = await isolatedStore();
		await operations.migrateTransferredExplicitStopMarkers(scope, migration, []);
		await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		await operations.migrateTransferredExplicitStopMarkers(
			scope,
			{ operationId: "operation-2", sourceWorkspaceId: "other-source" },
			["other-stop"],
		);
		expect((await operations.read(scope)).explicitlyStoppedSessionIds).toEqual(["other-stop"]);
	});
});
