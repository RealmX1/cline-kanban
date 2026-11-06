import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCodexConfigurationSyncHistory } from "@/hooks/use-codex-configuration-sync-history";
import type { CodexConfigurationSyncState } from "@/runtime/types";

const requests = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock("@/runtime/codex-configuration-sync-query", () => ({ fetchCodexConfigurationSyncHistory: requests.history }));
let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useCodexConfigurationSyncHistory>;
const active: CodexConfigurationSyncState = {
	revision: 1,
	changes: [],
	sourceObservations: [],
	observationProblem: null,
	stateResponseScope: "active",
	storageIdentity: "isolated-storage",
	storageGeneration: 1,
	historyTotalCount: 100,
	historyMaximumSequence: 100,
	historyProjectionGeneration: 0,
};
const page = (maximum = 100) => ({
	changes: [],
	sourceObservations: [],
	totalCount: 100,
	nextCursor: "next-page",
	storageIdentity: "isolated-storage",
	storageGeneration: 1,
	historyMaximumSequence: maximum,
	historyProjectionGeneration: 0,
});
function Harness({
	enabled,
	search = "",
	state = active,
}: {
	enabled: boolean;
	search?: string;
	state?: CodexConfigurationSyncState;
}) {
	const history = useCodexConfigurationSyncHistory("workspace", enabled, search, "all", state);
	useEffect(() => {
		current = history;
	});
	return null;
}
beforeEach(() => {
	requests.history.mockReset().mockResolvedValue(page());
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});
it("历史隐藏时不请求，进入后按页加载，新增只提示刷新", async () => {
	await act(async () => root.render(<Harness enabled={false} />));
	expect(requests.history).not.toHaveBeenCalled();
	await act(async () => root.render(<Harness enabled />));
	expect(requests.history).toHaveBeenCalledTimes(1);
	await act(async () => current.loadMore());
	expect(requests.history.mock.calls[1]?.[1]).toMatchObject({ cursor: "next-page", limit: 50 });
	await act(async () => root.render(<Harness enabled state={{ ...active, historyMaximumSequence: 101 }} />));
	expect(current.hasNewHistory).toBe(true);
	expect(requests.history).toHaveBeenCalledTimes(2);
});
it("搜索切换后丢弃迟到页面，既有历史重分类时重取首页", async () => {
	let resolveOld: (value: ReturnType<typeof page>) => void = () => {};
	requests.history.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				resolveOld = resolve;
			}),
	);
	await act(async () => root.render(<Harness enabled search="旧来源" />));
	await act(async () => root.render(<Harness enabled search="新来源" />));
	await act(async () => resolveOld({ ...page(), totalCount: 999 }));
	expect(current.totalCount).toBe(100);
	await act(async () =>
		root.render(<Harness enabled search="新来源" state={{ ...active, historyProjectionGeneration: 1 }} />),
	);
	expect(requests.history).toHaveBeenCalledTimes(3);
	expect(requests.history.mock.calls[2]?.[1].cursor).toBeUndefined();
});
