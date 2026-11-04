import { describe, expect, it } from "vitest";
import {
	assessFilesystemLockProtocolTransitionPreflight,
	type FilesystemLockProtocolRetiringWriterInventory,
} from "../../src/deployment/filesystem-lock-protocol-transition-preflight";

const inventory: FilesystemLockProtocolRetiringWriterInventory = {
	schemaVersion: 1,
	candidateSourceCommit: "a".repeat(40),
	runtimeHomeDirectoryPath: "/isolated-runtime-home",
	writerLaunchAdmissionClosed: true,
	retiringWriterInventoryComplete: true,
	systemBootIdentity: "original-boot",
	retiringWriterProcessIdentities: [{ processId: 10, startIdentity: "10 Sat Oct 31 10:00:00 2026" }],
	retiringWriterCommandPathPrefixes: ["/retiring-release/dist/cli.js"],
};
const assess = (options: Partial<Parameters<typeof assessFilesystemLockProtocolTransitionPreflight>[0]> = {}) =>
	assessFilesystemLockProtocolTransitionPreflight({
		inventory,
		currentSystemBootIdentity: "original-boot",
		currentProcessSnapshot: new Map(),
		pendingSnapshotWorkspaceIds: [],
		direction: "activate_kernel_write_locks",
		...options,
	});

describe("存储锁协议切换部署前置核验", () => {
	it("专用观察器的路径引用不阻断，显式旧 owner 与其他进程的歧义引用仍阻断", () => {
		const observations: NonNullable<
			Parameters<typeof assessFilesystemLockProtocolTransitionPreflight>[0]["currentProcessSnapshot"]
		> = new Map([
			[
				process.pid,
				{
					processPid: process.pid,
					parentProcessPid: 1,
					processGroupId: process.pid,
					startIdentity: `${process.pid} Sat Oct 31 11:00:00 2026`,
					commandArgumentsText:
						"node /retiring-release/check-protocol.ts --runtime-home /retiring-release/runtime-home",
				},
			],
		]);
		const retiringTreeInventory = { ...inventory, retiringWriterCommandPathPrefixes: ["/retiring-release"] };
		expect(assess({ inventory: retiringTreeInventory, currentProcessSnapshot: observations }).status).toBe(
			"ready_for_protocol_switch",
		);
		expect(
			assess({
				inventory: {
					...retiringTreeInventory,
					retiringWriterProcessIdentities: [
						{ processId: process.pid, startIdentity: `${process.pid} Sat Oct 31 11:00:00 2026` },
					],
				},
				currentProcessSnapshot: observations,
			}).blockingProcessIds,
		).toEqual([process.pid]);
		observations.set(20, {
			processPid: 20,
			parentProcessPid: 1,
			processGroupId: 20,
			startIdentity: "20 Sat Oct 31 11:00:00 2026",
			commandArgumentsText: "node /retiring-release-backup active/dist/cli.js hooks",
		});
		expect(
			assess({ inventory: retiringTreeInventory, currentProcessSnapshot: observations }).blockingProcessIds,
		).toEqual([20]);
	});
	it.each([
		{ prefix: "/retiring-release", command: "node /unrelated/../retiring-release/dist/cli.js hooks" },
		{ prefix: "/retiring-release", command: "node //retiring-release/dist/cli.js hooks" },
		{ prefix: "/retiring release", command: "node /retiring release/dist/cli.js hooks" },
		{
			prefix: "/retiring release/v1.2[production]",
			command: 'node "/retiring release/v1.2[production]/dist/cli.js" hooks',
		},
		{ prefix: "/retiring-release/dist/cli.js", command: "node --import=file:///retiring-release/dist/cli.js" },
		{ prefix: "/retiring-release/dist/cli.js", command: "node --import=file:/retiring-release/dist/cli.js" },
		{
			prefix: "/retiring-release/dist/cli.js",
			command: "node --import=file://localhost/retiring-release/dist/cli.js",
		},
		{
			prefix: "/retiring release",
			command: "node --import=file:///retiring%20release/dist/cli.js?version=previous",
		},
		{
			prefix: "/retiring-release/dist/cli.js",
			command: "sh -c 'sleep 10;/retiring-release/dist/cli.js'",
		},
		// biome-ignore lint/suspicious/noTemplateCurlyInString: 回归必须逐字保留 shell 的 IFS 展开语法。
		{ prefix: "/retiring-release/dist/cli.js", command: "sh -c 'sleep 10;/retiring-release/dist/cli.js${IFS}hooks'" },
		{ prefix: "/retiring-release/dist/cli.js", command: "sh -c 'sleep 10;/retiring-release/dist/cli.js* hooks'" },
		{
			prefix: "/retiring-release/dist/cli.js",
			command: "sh -c 'sleep 10;$UNSET/retiring-release/dist/cli.js hooks'",
		},
	])("真实旧入口路径仍阻止切换：$command", ({ prefix, command }) => {
		expect(
			assess({
				inventory: {
					...inventory,
					retiringWriterCommandPathPrefixes: [prefix],
				},
				currentProcessSnapshot: new Map([
					[
						20,
						{
							processPid: 20,
							parentProcessPid: 1,
							processGroupId: 20,
							startIdentity: "20 Sat Oct 31 11:00:00 2026",
							commandArgumentsText: command,
						},
					],
				]),
			}).blockingProcessIds,
		).toEqual([20]);
	});

	it("暂停或仍存活的旧进程不因时间流逝获得切换资格", () => {
		expect(
			assess({
				currentProcessSnapshot: new Map([
					[
						10,
						{
							processPid: 10,
							parentProcessPid: 1,
							processGroupId: 10,
							startIdentity: "10 Sat Oct 31 10:00:00 2026",
						},
					],
				]),
			}).status,
		).toBe("waiting_for_retiring_writers");
		expect(assess().status).toBe("ready_for_protocol_switch");
	});
	it("PID 复用或真实 boot 改变可自动解除旧身份，缺证保留未知", () => {
		expect(
			assess({
				currentProcessSnapshot: new Map([
					[
						10,
						{
							processPid: 10,
							parentProcessPid: 1,
							processGroupId: 10,
							startIdentity: "10 Sat Oct 31 11:00:00 2026",
						},
					],
				]),
			}).status,
		).toBe("ready_for_protocol_switch");
		expect(assess({ currentSystemBootIdentity: "later-boot" }).status).toBe("ready_for_protocol_switch");
		expect(assess({ currentProcessSnapshot: null }).status).toBe("evidence_unavailable");
		expect(assess({ currentSystemBootIdentity: null }).status).toBe("evidence_unavailable");
	});
	it("新派生的旧命令仍阻止切换；回退必须先完成全部日志投影", () => {
		expect(
			assess({
				currentProcessSnapshot: new Map([
					[
						20,
						{
							processPid: 20,
							parentProcessPid: 1,
							processGroupId: 20,
							startIdentity: "20 Sat Oct 31 11:00:00 2026",
							commandArgumentsText: "node /retiring-release/dist/cli.js hooks",
						},
					],
				]),
			}).blockingProcessIds,
		).toEqual([20]);
		expect(assess({ direction: "rollback_to_legacy_locks", pendingSnapshotWorkspaceIds: ["project-a"] }).status).toBe(
			"waiting_for_snapshot_projection",
		);
		expect(assess({ pendingSnapshotWorkspaceIds: null }).status).toBe("evidence_unavailable");
	});
});
