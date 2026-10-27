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
	const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
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
	await service.getState();
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
	it("两项同值提案均获批，跨重启重试幂等，未来 writer 采用同一默认", async () => {
		const { first, service, items } = await prepareIdenticalProposals();
		const sourceText = await readFile(join(sourceHome, "config.toml"), "utf8");
		const request = { action: "approve" as const, items };
		const approved = await service.batchAction(request);
		expect(approved.results.map((result) => result.status)).toEqual(["applied", "applied"]);
		for (const item of items)
			expect(approved.state.changes.find((change) => change.changeId === item.changeId)).toMatchObject({
				approvalStatus: "approved",
				mergeStatus: "shared_default_updated",
			});
		expect((await readCodexConfigurationSyncStore()).sources[first.sourceIdentity].fields[modelFieldKey]).toEqual({
			value: "same-choice",
		});
		await service.close();
		expect((await createService().batchAction(request)).results.map((result) => result.status)).toEqual([
			"replayed",
			"replayed",
		]);
		const future = await createWriter("future-writer");
		expect(parse(await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8")).model).toBe(
			"same-choice",
		);
		expect(await readFile(join(sourceHome, "config.toml"), "utf8")).toBe(sourceText);
	});

	it.each([
		{ defect: "stale_expected_version", expectedStatus: "stale_version", fieldKind: "model" },
		{ defect: "unreadable_user_source", expectedStatus: "source_unverifiable", fieldKind: "model" },
		{ defect: "unreadable_writer", expectedStatus: "source_unverifiable", fieldKind: "model" },
		{ defect: "changed_local_value", expectedStatus: "stale_version", fieldKind: "model" },
		{ defect: "changed_hook_definition", expectedStatus: "stale_version", fieldKind: "hook" },
		{ defect: "unreadable_hook_definition", expectedStatus: "source_unverifiable", fieldKind: "hook" },
	] as const)("共享默认同值时仍拒绝 $defect，保留原提案待处理", async ({ defect, expectedStatus, fieldKind }) => {
		const { second, service, items } = await prepareIdenticalProposals(fieldKind);
		expect((await service.batchAction({ action: "approve", items: [items[0]] })).results[0].status).toBe("applied");
		const secondItem = { ...items[1] };
		let unavailableFilePath: string | undefined;
		if (defect === "stale_expected_version") secondItem.expectedVersion++;
		if (defect === "unreadable_user_source") unavailableFilePath = join(sourceHome, "config.toml");
		if (defect === "unreadable_writer")
			unavailableFilePath = join(second.configurationHomeDirectoryPath, "config.toml");
		if (defect === "unreadable_hook_definition")
			unavailableFilePath = join(second.configurationHomeDirectoryPath, "hooks.json");
		if (unavailableFilePath) await rename(unavailableFilePath, `${unavailableFilePath}.unavailable`);
		if (defect === "changed_local_value") await setWriterChoice(second, "model", "new-unapproved-choice");
		if (defect === "changed_hook_definition")
			await writeFile(
				join(second.configurationHomeDirectoryPath, "hooks.json"),
				JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true # 新定义" }] }] } }),
			);
		const request = { action: "approve" as const, items: [secondItem] };
		const rejected = await service.batchAction(request);
		expect(rejected.results[0].status).toBe(expectedStatus);
		expect(rejected.state.changes.find((change) => change.changeId === secondItem.changeId)).toMatchObject({
			approvalStatus: "pending",
			mergeStatus: "pending_approval",
		});
		expect((await readCodexConfigurationSyncStore()).mutationReceipts[secondItem.idempotencyKey]).toBeUndefined();
		if (unavailableFilePath) {
			await rename(`${unavailableFilePath}.unavailable`, unavailableFilePath);
			expect((await service.batchAction(request)).results[0].status).toBe("applied");
		}
	});

	it("同字段的不同决定继续保留真实冲突", async () => {
		const { service, items } = await prepareIdenticalProposals("model", "different-choice");
		const approved = await service.batchAction({ action: "approve", items });
		expect(approved.results.map((result) => result.status)).toEqual(["applied", "conflict"]);
		expect(approved.state.changes.find((change) => change.changeId === items[1].changeId)).toMatchObject({
			approvalStatus: "pending",
			mergeStatus: "conflict",
		});
	});
});
