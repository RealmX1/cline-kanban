import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCodexConfigurationSync } from "@/hooks/use-codex-configuration-sync";
import { notifyCodexConfigurationSyncUpdated } from "@/runtime/codex-configuration-sync-query";
import type { CodexConfigurationProfileMutationRequest, CodexConfigurationSyncState } from "@/runtime/types";

const queries = vi.hoisted(() => ({ fetch: vi.fn(), profile: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			getCodexConfigurationSyncState: { query: queries.fetch },
			mutateCodexConfigurationProfile: { mutate: queries.profile },
		},
	}),
}));
let container: HTMLDivElement;
let root: Root;
let state: CodexConfigurationSyncState;
let currentSync: ReturnType<typeof useCodexConfigurationSync>;
function HookHarness() {
	currentSync = useCodexConfigurationSync("fixture-workspace");
	return null;
}
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	state = { revision: 1, observationProblem: null, sourceObservations: [], changes: [] };
	queries.fetch.mockReset().mockImplementation(async () => state);
	queries.profile.mockReset();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(<HookHarness />));
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("profile 操作的幂等身份生命周期", () => {
	it.each(["set_default", "bind_session"] as const)("成功的 %s 意图结束后，相同参数的新意图仍执行", async (action) => {
		const receipts = new Set<string>();
		let selectedProfileId: string | undefined;
		queries.profile.mockImplementation(async (input: CodexConfigurationProfileMutationRequest) => {
			if (!receipts.has(input.idempotencyKey)) {
				receipts.add(input.idempotencyKey);
				if (input.action === "set_default" || input.action === "bind_session") selectedProfileId = input.profileId;
			}
			return state;
		});
		for (const profileId of ["profile-b", "profile-a", "profile-b"]) {
			const input: CodexConfigurationProfileMutationRequest =
				action === "set_default"
					? { action, profileId, idempotencyKey: crypto.randomUUID() }
					: {
							action,
							profileId,
							idempotencyKey: crypto.randomUUID(),
							workspaceId: "fixture-workspace",
							conversationSessionId: "fixture-session",
							expectedRuntimeSessionIncarnationId: "same-incarnation",
						};
			await act(async () => {
				await currentSync.profileAction(input);
			});
			expect(selectedProfileId).toBe(profileId);
		}
		expect(new Set(queries.profile.mock.calls.map(([input]) => input.idempotencyKey)).size).toBe(3);
	});
	it.each(["set_default", "bind_session"] as const)(
		"%s 首次已受理但回执丢失，经过另一项成功操作后，相同参数的新意图必须执行",
		async (action) => {
			const receipts = new Set<string>();
			let selectedProfileId: string | undefined;
			queries.profile.mockImplementation(async (input: CodexConfigurationProfileMutationRequest) => {
				if (!receipts.has(input.idempotencyKey)) {
					receipts.add(input.idempotencyKey);
					if (input.action === "set_default" || input.action === "bind_session")
						selectedProfileId = input.profileId;
				}
				if (queries.profile.mock.calls.length === 1) throw new Error("隔离模拟服务端受理后回执丢失");
				return state;
			});
			for (const [index, profileId] of ["profile-a", "profile-b", "profile-a"].entries()) {
				const input: CodexConfigurationProfileMutationRequest =
					action === "set_default"
						? { action, profileId, idempotencyKey: crypto.randomUUID() }
						: {
								action,
								profileId,
								idempotencyKey: crypto.randomUUID(),
								workspaceId: "fixture-workspace",
								conversationSessionId: "fixture-session",
								expectedRuntimeSessionIncarnationId: "same-incarnation",
							};
				await act(async () => {
					expect(await currentSync.profileAction(input)).toBe(index !== 0);
				});
				expect(selectedProfileId).toBe(profileId);
			}
			expect(new Set(queries.profile.mock.calls.map(([input]) => input.idempotencyKey)).size).toBe(3);
		},
	);
	it("连续回执丢失后以原身份重试，收到成功回执后才结束该身份", async () => {
		const receipts = new Set<string>();
		queries.profile.mockImplementation(async (input: CodexConfigurationProfileMutationRequest) => {
			receipts.add(input.idempotencyKey);
			if (queries.profile.mock.calls.length <= 2) throw new Error("隔离模拟服务端受理后回执丢失");
			return state;
		});
		const request = (): CodexConfigurationProfileMutationRequest => ({
			action: "set_default",
			profileId: "profile-b",
			idempotencyKey: crypto.randomUUID(),
		});
		await act(async () => {
			expect(await currentSync.profileAction(request())).toBe(false);
		});
		await act(async () => {
			expect(await currentSync.profileAction(request())).toBe(false);
		});
		await act(async () => {
			expect(await currentSync.profileAction(request())).toBe(true);
		});
		expect(receipts.size).toBe(1);
		await act(async () => {
			await currentSync.profileAction(request());
		});
		expect(receipts.size).toBe(2);
	});
});

describe("配置状态只读查询的界面补读", () => {
	it("首次加载读取持久状态，断线后的失效通知自动补读并清除读取错误", async () => {
		expect(queries.fetch).toHaveBeenCalledTimes(1);
		expect(currentSync.state?.revision).toBe(1);
		queries.fetch.mockRejectedValueOnce(new Error("隔离模拟断线"));
		await act(async () => notifyCodexConfigurationSyncUpdated());
		expect(currentSync.error).toContain("暂时无法读取");
		state = { ...state, revision: 2 };
		await act(async () => notifyCodexConfigurationSyncUpdated());
		expect(currentSync.state?.revision).toBe(2);
		expect(currentSync.error).toBeNull();
		expect(queries.profile).not.toHaveBeenCalled();
	});
	it("较早的查询迟到时不覆盖重连补读的新状态", async () => {
		let resolveEarlierQuery: (value: CodexConfigurationSyncState) => void = () => {};
		queries.fetch.mockImplementationOnce(
			() =>
				new Promise<CodexConfigurationSyncState>((resolve) => {
					resolveEarlierQuery = resolve;
				}),
		);
		await act(async () => notifyCodexConfigurationSyncUpdated());
		state = { ...state, revision: 3 };
		await act(async () => notifyCodexConfigurationSyncUpdated());
		await act(async () => resolveEarlierQuery({ ...state, revision: 2 }));
		expect(currentSync.state?.revision).toBe(3);
	});
});
