import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
	it("复开只能清除授权时观察到的 Stop，后来重复 Stop 也不能被旧请求清除", async () => {
		const { operations } = await isolatedStore();
		await operations.recordExplicitStopMarkers(scope, ["main-session"]);
		const observed = await operations.observeExplicitStopMarkerVersion(scope);
		await operations.recordExplicitStopMarkers(scope, ["main-session"]);
		expect(await operations.clearExplicitStopMarkersIfObservationUnchanged(scope, ["main-session"], observed)).toBe(
			false,
		);
		expect((await operations.read(scope)).explicitlyStoppedSessionIds).toContain("main-session");
		const authorized = await operations.observeExplicitStopMarkerVersion(scope);
		expect(await operations.clearExplicitStopMarkersIfObservationUnchanged(scope, ["main-session"], authorized)).toBe(
			true,
		);
		// 清除已完成而复开回执尚未保存时，重启可用当前事实补齐，不能重写 Stop。
		expect(await operations.clearExplicitStopMarkersIfObservationUnchanged(scope, ["main-session"], authorized)).toBe(
			true,
		);
	});
	it("旧的会话 ID 数组仍可读，解除时原子保存名单与观察身份", async () => {
		const { operations, markerPath } = await isolatedStore();
		await mkdir(dirname(markerPath), { recursive: true });
		await writeFile(markerPath, JSON.stringify(["kept", "cleared"]));
		expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual(["kept", "cleared"]);
		await operations.clearExplicitStopMarker(scope, "cleared");
		expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({
			sessionIds: ["kept"],
			observationId: expect.any(String),
		});
		expect((await operations.read(scope)).explicitlyStoppedSessionIds).toEqual(["kept"]);
	});

	it("一次复制与名单同文件提交，解除后同一合并不再加回，后续来源 Stop 也不补进", async () => {
		const { operations, markerPath } = await isolatedStore();
		await operations.recordExplicitStopMarkers(scope, ["already-there"]);
		await operations.migrateTransferredExplicitStopMarkers(scope, migration, ["already-there", "from-source"]);
		expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({
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
