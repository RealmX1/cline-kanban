import { describe, expect, it, vi } from "vitest";
import { createCodexPluginRemoteRevisionProbeTransaction } from "../../../src/codex-configuration-sync/codex-plugin-remote-revision-probe-transaction";

describe("一次来源锁内的远端 revision 核验", () => {
	it("同 URL/ref 的并发与后续读取只执行一次，来源与安装事实变化后重新查询", async () => {
		const probe = vi.fn(async () => "a".repeat(40));
		const transaction = createCodexPluginRemoteRevisionProbeTransaction(probe);
		await Promise.all([transaction.read("source-a", "main"), transaction.read("source-a", "main")]);
		await transaction.read("source-a", "main");
		expect(probe).toHaveBeenCalledTimes(1);
		await transaction.read("source-b", "main");
		await transaction.read("source-a", "other");
		expect(probe).toHaveBeenCalledTimes(3);
		transaction.invalidateAfterSourceInstallationFactsChanged();
		await transaction.read("source-a", "main");
		expect(probe).toHaveBeenCalledTimes(4);
		await createCodexPluginRemoteRevisionProbeTransaction(probe).read("source-a", "main");
		expect(probe).toHaveBeenCalledTimes(5);
	});

	it("超时产生的未知结果在本轮复用，不能成为更新成功证据，下轮仍重新核验", async () => {
		const probe = vi.fn(async (): Promise<string | undefined> => undefined);
		const transaction = createCodexPluginRemoteRevisionProbeTransaction(probe);
		expect(await transaction.read("source", null)).toBeUndefined();
		expect(await transaction.read("source", null)).toBeUndefined();
		expect(probe).toHaveBeenCalledTimes(1);
		expect(await transaction.hasUnverifiedRevisionProbes()).toBe(true);
		probe.mockResolvedValue("b".repeat(40));
		transaction.invalidateAfterSourceInstallationFactsChanged();
		expect(await transaction.read("source", null)).toBe("b".repeat(40));
		expect(await transaction.hasUnverifiedRevisionProbes()).toBe(false);
	});
});
