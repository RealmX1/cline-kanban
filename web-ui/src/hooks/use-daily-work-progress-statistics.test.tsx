import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDailyWorkProgressStatistics } from "@/hooks/use-daily-work-progress-statistics";
import { observeDailyWorkProgressStatisticsUpdated } from "@/runtime/daily-work-progress-statistics-invalidation-events";
import type {
	RuntimeClaimDailyWorkProgressCelebrationsRequest,
	RuntimeClaimDailyWorkProgressCelebrationsResponse,
	RuntimeDailyWorkProgressSummary,
} from "@/runtime/types";

const mocks = vi.hoisted(() => ({ read: vi.fn(), claim: vi.fn() }));
vi.mock("@/runtime/daily-work-progress-statistics-query", () => ({
	readDailyWorkProgressSummary: mocks.read,
	claimDailyWorkProgressCelebrations: mocks.claim,
}));
let latest: ReturnType<typeof useDailyWorkProgressStatistics>;
function Harness() {
	latest = useDailyWorkProgressStatistics();
	return (
		<button type="button" onClick={latest.toggleExpanded}>
			{latest.isExpanded ? "展开" : "收起"}
		</button>
	);
}
function fixture(): RuntimeDailyWorkProgressSummary {
	return {
		revision: 1,
		dateKey: "2026-10-23",
		timeZone: "UTC",
		workspaceId: null,
		projects: [{ workspaceId: "project", projectName: "项目" }],
		metrics: [],
		achievements: [],
		celebrationEligibleAchievementIds: [],
		recentAccomplishments: [],
		coverage: { status: "complete", warnings: [] },
	};
}
describe("今日进展的展开与庆祝", () => {
	let root: Root;
	let container: HTMLDivElement;
	let summary: RuntimeDailyWorkProgressSummary;
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
		localStorage.clear();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		summary = fixture();
		mocks.read.mockImplementation(async () => summary);
		mocks.claim.mockImplementation(async (input: RuntimeClaimDailyWorkProgressCelebrationsRequest) =>
			commitCelebrationClaim(input),
		);
		mocks.claim.mockClear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.useRealTimers();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});
	async function mount() {
		await act(async () => {
			root.render(<Harness />);
		});
	}
	function commitCelebrationClaim(input: RuntimeClaimDailyWorkProgressCelebrationsRequest) {
		const achievements = summary.achievements.filter(
			(achievement) =>
				input.achievementIds.includes(achievement.achievementId) &&
				summary.celebrationEligibleAchievementIds.includes(achievement.achievementId),
		);
		summary = {
			...summary,
			celebrationEligibleAchievementIds: summary.celebrationEligibleAchievementIds.filter(
				(achievementId) => !input.achievementIds.includes(achievementId),
			),
		};
		return { achievements };
	}
	function delayNextCommittedClaimReceipt() {
		let deliverReceipt!: (response: RuntimeClaimDailyWorkProgressCelebrationsResponse) => void;
		let committedResponse: RuntimeClaimDailyWorkProgressCelebrationsResponse;
		const receipt = new Promise<RuntimeClaimDailyWorkProgressCelebrationsResponse>((resolve) => {
			deliverReceipt = resolve;
		});
		mocks.claim.mockImplementationOnce((input: RuntimeClaimDailyWorkProgressCelebrationsRequest) => {
			committedResponse = commitCelebrationClaim(input);
			return receipt;
		});
		return async () => {
			await act(async () => {
				deliverReceipt(committedResponse);
			});
		};
	}
	async function milestone() {
		summary = {
			...summary,
			revision: summary.revision + 1,
			achievements: [
				{
					achievementId: "first-done",
					metric: "entered_done",
					kind: "daily_threshold",
					value: 1,
					threshold: 1,
					comparisonValue: null,
				},
			],
			celebrationEligibleAchievementIds: ["first-done"],
		};
		await act(async () => {
			observeDailyWorkProgressStatisticsUpdated();
		});
	}
	it.each(["统计推流", "手动刷新", "窗口聚焦"])("%s 不丢失同范围已领取的延迟回执，成果仅反馈一次", async (trigger) => {
		await mount();
		const deliverClaimReceipt = delayNextCommittedClaimReceipt();
		await milestone();
		await act(async () => {
			if (trigger === "统计推流") observeDailyWorkProgressStatisticsUpdated();
			else if (trigger === "手动刷新") latest.refresh();
			else window.dispatchEvent(new Event("focus"));
		});
		expect(latest.isExpanded).toBe(false);
		await deliverClaimReceipt();
		expect(latest.isExpanded).toBe(true);
		expect(latest.celebrations.map((achievement) => achievement.achievementId)).toEqual(["first-done"]);
		expect(mocks.claim).toHaveBeenCalledTimes(1);
		await act(async () => {
			vi.advanceTimersByTime(8_000);
			observeDailyWorkProgressStatisticsUpdated();
		});
		expect(latest.isExpanded).toBe(false);
		expect(mocks.claim).toHaveBeenCalledTimes(1);
	});
	it("旧领取回执延迟时仍可领取新成就，两次回执合并且不重复领取", async () => {
		await mount();
		const deliverFirstClaimReceipt = delayNextCommittedClaimReceipt();
		await milestone();
		summary = {
			...summary,
			achievements: [
				...summary.achievements,
				{
					achievementId: "prompt-10",
					metric: "human_prompt",
					kind: "daily_threshold",
					value: 10,
					threshold: 10,
					comparisonValue: null,
				},
			],
			celebrationEligibleAchievementIds: ["prompt-10"],
		};
		await act(async () => {
			observeDailyWorkProgressStatisticsUpdated();
		});
		expect(latest.celebrations.map((achievement) => achievement.achievementId)).toEqual(["prompt-10"]);
		await deliverFirstClaimReceipt();
		expect(latest.celebrations.map((achievement) => achievement.achievementId)).toEqual(["prompt-10", "first-done"]);
		expect(mocks.claim).toHaveBeenCalledTimes(2);
		expect(mocks.claim).toHaveBeenLastCalledWith(expect.objectContaining({ achievementIds: ["prompt-10"] }));
	});
	it.each(["项目范围", "日期", "时区", "重连", "切换后返回原范围"])(
		"%s 变更后拒绝旧上下文的延迟领取反馈",
		async (contextChange) => {
			await mount();
			const deliverClaimReceipt = delayNextCommittedClaimReceipt();
			await milestone();
			await act(async () => {
				if (contextChange === "项目范围" || contextChange === "切换后返回原范围") latest.selectWorkspace("project");
				else if (contextChange === "重连") observeDailyWorkProgressStatisticsUpdated(true);
				else {
					if (contextChange === "日期") vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
					else {
						const nextTimeZone =
							Intl.DateTimeFormat().resolvedOptions().timeZone === "Asia/Tokyo" ? "UTC" : "Asia/Tokyo";
						const changedTimeZoneFormatter = Intl.DateTimeFormat("en-US", { timeZone: nextTimeZone });
						vi.spyOn(Intl, "DateTimeFormat").mockReturnValue(changedTimeZoneFormatter);
					}
					window.dispatchEvent(new Event("focus"));
				}
			});
			if (contextChange === "切换后返回原范围") {
				await act(async () => {
					latest.selectWorkspace(null);
				});
			}
			await deliverClaimReceipt();
			expect(latest.isExpanded).toBe(false);
			expect(latest.celebrations).toEqual([]);
			expect(mocks.claim).toHaveBeenCalledTimes(1);
		},
	);
	it("卸载后的领取回执不会污染重新挂载的静默基线", async () => {
		await mount();
		const deliverClaimReceipt = delayNextCommittedClaimReceipt();
		await milestone();
		await act(async () => {
			root.render(null);
		});
		await mount();
		await deliverClaimReceipt();
		expect(latest.isExpanded).toBe(false);
		expect(latest.celebrations).toEqual([]);
		expect(mocks.claim).toHaveBeenCalledTimes(1);
	});
	it.each(["切换按钮", "收起方法"])("延迟领取期间通过%s 手动关闭后不重新展开", async (closeAction) => {
		await mount();
		await act(async () => {
			latest.toggleExpanded();
		});
		const deliverClaimReceipt = delayNextCommittedClaimReceipt();
		await milestone();
		await act(async () => {
			if (closeAction === "切换按钮") latest.toggleExpanded();
			else latest.collapse();
		});
		await deliverClaimReceipt();
		expect(latest.isExpanded).toBe(false);
		expect(latest.celebrations.map((achievement) => achievement.achievementId)).toEqual(["first-done"]);
	});
	it("延迟领取期间主动展开后仍保持手动展开", async () => {
		await mount();
		const deliverClaimReceipt = delayNextCommittedClaimReceipt();
		await milestone();
		await act(async () => {
			latest.toggleExpanded();
		});
		await deliverClaimReceipt();
		await act(async () => {
			vi.advanceTimersByTime(20_000);
		});
		expect(latest.isExpanded).toBe(true);
		expect(latest.isAutomaticallyExpanded).toBe(false);
		expect(latest.celebrations.map((achievement) => achievement.achievementId)).toEqual(["first-done"]);
	});
	it("领取失败后下次统计更新可以重试同一成就", async () => {
		await mount();
		mocks.claim.mockRejectedValueOnce(new Error("模拟领取连接失败"));
		await milestone();
		expect(latest.isExpanded).toBe(false);
		await act(async () => {
			observeDailyWorkProgressStatisticsUpdated();
		});
		expect(mocks.claim).toHaveBeenCalledTimes(2);
		expect(latest.celebrations.map((achievement) => achievement.achievementId)).toEqual(["first-done"]);
	});
	it("初次加载静默，里程碑自动展开八秒后收起，保留输入焦点", async () => {
		await mount();
		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();
		await milestone();
		expect(latest.isExpanded).toBe(true);
		expect(document.activeElement).toBe(input);
		await act(async () => {
			vi.advanceTimersByTime(8_000);
		});
		expect(latest.isExpanded).toBe(false);
		input.remove();
	});
	it("主动展开保持，手动收起立即生效，重连不重复庆祝", async () => {
		await mount();
		await act(async () => {
			latest.toggleExpanded();
			vi.advanceTimersByTime(20_000);
		});
		expect(latest.isExpanded).toBe(true);
		await act(async () => {
			latest.toggleExpanded();
		});
		expect(latest.isExpanded).toBe(false);
		await milestone();
		await act(async () => {
			latest.toggleExpanded();
		});
		await act(async () => {
			observeDailyWorkProgressStatisticsUpdated(true);
		});
		expect(latest.isExpanded).toBe(false);
		expect(mocks.claim).toHaveBeenCalledTimes(1);
	});
	it("初次加载已经达到的成就与历史回填不自动展开", async () => {
		await milestone();
		await mount();
		expect(latest.isExpanded).toBe(false);
		expect(mocks.claim).not.toHaveBeenCalled();
		summary = {
			...summary,
			achievements: [
				...summary.achievements,
				{ ...summary.achievements[0]!, achievementId: "backfilled", threshold: 3 },
			],
			celebrationEligibleAchievementIds: [],
		};
		await act(async () => {
			observeDailyWorkProgressStatisticsUpdated();
		});
		expect(latest.isExpanded).toBe(false);
	});
	it("StrictMode 重放初始化 effect 时仍建立静默基线", async () => {
		summary = {
			...summary,
			achievements: [
				{
					achievementId: "existing",
					metric: "entered_done",
					kind: "daily_threshold",
					value: 1,
					threshold: 1,
					comparisonValue: null,
				},
			],
			celebrationEligibleAchievementIds: ["existing"],
		};
		await act(async () => {
			root.render(
				<StrictMode>
					<Harness />
				</StrictMode>,
			);
		});
		expect(latest.isExpanded).toBe(false);
		expect(mocks.claim).not.toHaveBeenCalled();
	});
	it("新的庆祝窗口展示本轮新成就，不重复显示上一个窗口的成果", async () => {
		await mount();
		await milestone();
		await act(async () => {
			vi.advanceTimersByTime(61_000);
		});
		const promptAchievement = {
			achievementId: "prompt-10",
			metric: "human_prompt" as const,
			kind: "daily_threshold" as const,
			value: 10,
			threshold: 10,
			comparisonValue: null,
		};
		summary = {
			...summary,
			achievements: [...summary.achievements, promptAchievement],
			celebrationEligibleAchievementIds: ["prompt-10"],
		};
		await act(async () => {
			observeDailyWorkProgressStatisticsUpdated();
		});
		expect(latest.isExpanded).toBe(true);
		expect(latest.celebrations.map((achievement) => achievement.achievementId)).toEqual(["prompt-10"]);
	});
});
