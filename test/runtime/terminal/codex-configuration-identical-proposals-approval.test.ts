import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CodexConfigurationSyncService,
	createCodexConfigurationSyncService,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import { readCodexConfigurationSyncStore } from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { prepareManagedCodexConversationStorageHome } from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import type { CodexConfigurationWriterBinding } from "../../../src/core/codex-configuration-sync-contract";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
let storageHome: string;
let services: CodexConfigurationSyncService[];
const modelFieldKey = JSON.stringify(["config.toml", "model"]);

beforeEach(async () => {
	fixture = createTempDir("codex-identical-proposals-approval-");
	fixture.path = await realpath(fixture.path);
	sourceHome = join(fixture.path, ".codex");
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("CODEX_HOME", sourceHome);
	vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.path, "isolated-sqlite"));
	await mkdir(sourceHome);
	await writeFile(
		join(sourceHome, "hooks.json"),
		JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }),
	);
	await writeFile(
		join(sourceHome, "config.toml"),
		stringify({
			model: "initial-model",
			hooks: { state: { [`${sourceHome}/hooks.json:stop:0:0`]: { enabled: true, trusted_hash: "original-trust" } } },
		}),
	);
	storageHome = await prepareManagedCodexConversationStorageHome(sourceHome);
	services = [];
});

afterEach(async () => {
	await Promise.all(services.map((service) => service.close()));
	vi.unstubAllEnvs();
	fixture.cleanup();
});

const createWriter = (conversationSessionId: string) =>
	prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome,
		workspaceId: "identical-proposals-workspace",
		conversationSessionId,
		runtimeSessionIncarnationId: randomUUID(),
	});

function createService() {
	const service = createCodexConfigurationSyncService({
		getSessionSummary: () => null,
		listSessions: () => [],
		onUpdated: () => {},
	});
	services.push(service);
	return service;
}

async function setWriterChoice(
	binding: CodexConfigurationWriterBinding,
	fieldKind: "model" | "hook",
	model = "same-choice",
) {
	const filePath = join(binding.configurationHomeDirectoryPath, "config.toml");
	const configuration = parse(await readFile(filePath, "utf8"));
	if (fieldKind === "model") configuration.model = model;
	else
		configuration.hooks = {
			state: {
				[`${binding.configurationHomeDirectoryPath}/hooks.json:stop:0:0`]: {
					enabled: false,
					trusted_hash: "original-trust",
				},
			},
		};
	await writeFile(filePath, stringify(configuration));
}

async function prepareIdenticalProposals(fieldKind: "model" | "hook" = "model", secondChoice = "same-choice") {
	const first = await createWriter("first-writer");
	const second = await createWriter("second-writer");
	await setWriterChoice(first, fieldKind);
	await setWriterChoice(second, fieldKind, secondChoice);
	const service = createService();
	await service.scan();
	const store = await readCodexConfigurationSyncStore();
	const fieldKey =
		fieldKind === "model"
			? modelFieldKey
			: JSON.stringify(["config.toml", "hooks", "state", `${sourceHome}/hooks.json:stop:0:0`]);
	const items = [first, second].map((binding) => {
		const storedChange = store.changes.find(
			(entry) => entry.sourceWriterId === binding.writerId && entry.fieldKey === fieldKey,
		);
		if (!storedChange) throw new Error("缺少设置提案");
		return {
			entryKind: "settings_proposal" as const,
			changeId: storedChange.changeId,
			expectedVersion: storedChange.version,
			idempotencyKey: randomUUID(),
		};
	});
	return { first, second, service, fieldKey, items };
}

describe("相同设置提案审批不制造冲突", () => {
	it("同字段明确反馈后其余旧建议结束，跨重启重试幂等，未来 writer 采用 profile", async () => {
		const { first, service, items } = await prepareIdenticalProposals();
		const sourceText = await readFile(join(sourceHome, "config.toml"), "utf8");
		const request = { action: "approve" as const, items };
		const approved = await service.batchAction(request);
		expect(approved.results.map((result) => result.status)).toEqual(["applied", "stale_version"]);
		expect(approved.state.changes.find((change) => change.changeId === items[0].changeId)).toMatchObject({
			approvalStatus: "approved",
			mergeStatus: "shared_default_updated",
		});
		expect(approved.state.changes.find((change) => change.changeId === items[1].changeId)).toMatchObject({
			approvalStatus: "historical",
			mergeStatus: "superseded",
		});
		expect((await readCodexConfigurationSyncStore()).sources[first.sourceIdentity].fields[modelFieldKey]).toEqual({
			value: "same-choice",
		});
		await service.close();
		expect((await createService().batchAction(request)).results.map((result) => result.status)).toEqual([
			"replayed",
			"stale_version",
		]);
		const future = await createWriter("future-writer");
		expect(parse(await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8")).model).toBe(
			"same-choice",
		);
		expect(await readFile(join(sourceHome, "config.toml"), "utf8")).toBe(sourceText);
	});

	it.each([
		{ defect: "stale_expected_version", expectedStatus: "stale_version", fieldKind: "model" },
		{ defect: "unverifiable_source_directory", expectedStatus: "source_unverifiable", fieldKind: "model" },
		{ defect: "unreadable_writer", expectedStatus: "source_unverifiable", fieldKind: "model" },
		{ defect: "changed_local_value", expectedStatus: "stale_version", fieldKind: "model" },
	] as const)("例外反馈仍核验 $defect，不能把失效建议广播", async ({ defect, expectedStatus, fieldKind }) => {
		const { second, service, items } = await prepareIdenticalProposals(fieldKind);
		const secondItem = { ...items[1] };
		let unavailableFilePath: string | undefined;
		if (defect === "stale_expected_version") secondItem.expectedVersion++;
		if (defect === "unverifiable_source_directory") unavailableFilePath = sourceHome;
		if (defect === "unreadable_writer")
			unavailableFilePath = join(second.configurationHomeDirectoryPath, "config.toml");
		if (unavailableFilePath) await rename(unavailableFilePath, `${unavailableFilePath}.unavailable`);
		if (defect === "changed_local_value") await setWriterChoice(second, "model", "new-unapproved-choice");
		const request = { action: "approve" as const, items: [secondItem] };
		const rejected = await service.batchAction(request);
		expect(rejected.results[0].status).toBe(expectedStatus);
		expect(rejected.state.changes.find((change) => change.changeId === secondItem.changeId)?.approvalStatus).toBe(
			defect === "changed_local_value" ? "historical" : "pending",
		);
		expect((await readCodexConfigurationSyncStore()).mutationReceipts[secondItem.idempotencyKey]).toBeUndefined();
		if (unavailableFilePath) {
			await rename(`${unavailableFilePath}.unavailable`, unavailableFilePath);
			expect((await service.batchAction(request)).results[0].status).toBe("applied");
		}
	});

	it("明确更新 profile 会结束同字段旧建议，其他会话未提交的建议不能覆盖新版本", async () => {
		const { service, items } = await prepareIdenticalProposals("model", "different-choice");
		const approved = await service.batchAction({ action: "approve", items });
		expect(approved.results.map((result) => result.status)).toEqual(["applied", "stale_version"]);
		expect(approved.state.changes.find((change) => change.changeId === items[1].changeId)).toMatchObject({
			approvalStatus: "historical",
			mergeStatus: "superseded",
		});
	});
});
