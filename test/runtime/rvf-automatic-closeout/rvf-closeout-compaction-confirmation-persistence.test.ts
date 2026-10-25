import { readFile, unlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateRvfAutomaticCloseoutRecords } from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-store";
import { resolveRvfCloseoutCompactionConfirmationPersistence } from "../../../src/rvf-automatic-closeout/rvf-closeout-compaction-confirmation-persistence";
import { createRvfCloseoutCompactionConfirmationIsolatedFixture } from "./rvf-closeout-compaction-confirmation-isolated-fixture";

afterEach(() => vi.unstubAllEnvs());
describe("压缩等待只对精确绑定的自动收尾启用", () => {
	it("绑定 task/token/run/handoff/原生代际和正文；恢复可以从原绑定重建正文", async () => {
		const fixture = await createRvfCloseoutCompactionConfirmationIsolatedFixture();
		const input = {
			workspaceId: fixture.workspaceId,
			summary: fixture.summary,
			idempotencyKey: fixture.record.promptDeliveryIdempotencyKey,
		};
		const context = await resolveRvfCloseoutCompactionConfirmationPersistence(input);
		expect(context?.promptText).toBe(fixture.promptText);
		expect(await context?.persistSnapshot(fixture.initialSnapshot, null)).toBe(true);
		expect(
			await resolveRvfCloseoutCompactionConfirmationPersistence({
				...input,
				promptText: `${fixture.promptText}额外正文`,
			}),
		).toBeNull();
		expect(
			await resolveRvfCloseoutCompactionConfirmationPersistence({ ...input, idempotencyKey: "other-key" }),
		).toBeNull();
		if (!fixture.record.handoffPath) throw new Error("隔离交接缺失");
		await writeFile(fixture.record.handoffPath, "变化的交接");
		expect(await resolveRvfCloseoutCompactionConfirmationPersistence(input)).toBeNull();
	});
	it.each(["paused", "completed"] as const)("%s 只读拒绝，不改写旧结果，不授予新预算", async (status) => {
		const fixture = await createRvfCloseoutCompactionConfirmationIsolatedFixture();
		await updateRvfAutomaticCloseoutRecords(fixture.storePath, () => ({
			records: [{ ...fixture.record, status }],
			value: null,
		}));
		const before = await readFile(fixture.storePath, "utf8");
		expect(
			await resolveRvfCloseoutCompactionConfirmationPersistence({
				workspaceId: fixture.workspaceId,
				summary: fixture.summary,
				idempotencyKey: fixture.record.promptDeliveryIdempotencyKey,
			}),
		).toBeNull();
		expect(await readFile(fixture.storePath, "utf8")).toBe(before);
	});
	it("已提交快照的接管只核验历史绑定；后来交接文件缺失不能否定原提交，初次发送仍拒绝", async () => {
		const fixture = await createRvfCloseoutCompactionConfirmationIsolatedFixture();
		const input = {
			workspaceId: fixture.workspaceId,
			summary: fixture.summary,
			idempotencyKey: fixture.record.promptDeliveryIdempotencyKey,
		};
		const context = await resolveRvfCloseoutCompactionConfirmationPersistence(input);
		expect(await context?.persistSnapshot(fixture.initialSnapshot, null)).toBe(true);
		if (!fixture.record.handoffPath) throw new Error("隔离交接缺失");
		await unlink(fixture.record.handoffPath);
		const resumed = await resolveRvfCloseoutCompactionConfirmationPersistence({
			...input,
			resumeExistingSubmissionOnly: true,
		});
		expect(resumed?.promptText).toBe(fixture.promptText);
		expect(await resumed?.validateStillAuthorized()).toBe(true);
		await expect(resolveRvfCloseoutCompactionConfirmationPersistence(input)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
