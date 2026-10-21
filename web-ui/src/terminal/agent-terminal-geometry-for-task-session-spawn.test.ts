import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { resolveAgentTerminalGeometryForTaskSessionSpawn } from "@/terminal/agent-terminal-geometry-for-task-session-spawn";
import { clearTerminalGeometry, reportTerminalGeometry } from "@/terminal/terminal-geometry-registry";
import { MOBILE_VIEWPORT_MAX_WIDTH_PX } from "@/utils/mobile-viewport-breakpoint";

vi.mock("@/resize/detail-terminal-panel-width", () => ({ loadDetailTerminalPanelWidth: () => 520 }));
vi.mock("@/resize/use-card-detail-layout", () => ({
	MIN_DETAIL_DIFF_PANEL_WIDTH_PX: 360,
	loadDetailTaskCardsPanelRatioPreference: () => 0.2,
}));

const taskId = "mobile-background-startup-geometry";

beforeEach(() => {
	window.localStorage.clear();
	vi.stubGlobal("innerHeight", 900);
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches:
			query === `(max-width: ${MOBILE_VIEWPORT_MAX_WIDTH_PX}px)` &&
			window.innerWidth <= MOBILE_VIEWPORT_MAX_WIDTH_PX,
	}));
});

afterEach(() => {
	clearTerminalGeometry(taskId);
	vi.unstubAllGlobals();
});

describe("后台启动任务的终端尺寸", () => {
	it.each([
		[320, 35],
		[360, 40],
		[375, 41],
		[390, 43],
		[393, 44],
		[412, 46],
		[430, 48],
		[768, 91],
	])("手机视口 %ipx 使用整页终端宽度，启动为 %i 列", (viewportWidth, expectedColumns) => {
		vi.stubGlobal("innerWidth", viewportWidth);
		expect(resolveAgentTerminalGeometryForTaskSessionSpawn(taskId)).toEqual({ cols: expectedColumns, rows: 53 });
	});

	it.each([
		[769, 46],
		[1440, 60],
	])("桌面视口 %ipx 保留持久化面板宽度与 diff 面板限制", (viewportWidth, expectedColumns) => {
		vi.stubGlobal("innerWidth", viewportWidth);
		window.localStorage.setItem(
			LocalStorageKey.FocusViewDesktopPanelArrangementPreference,
			"agent_left_workbench_right",
		);
		expect(resolveAgentTerminalGeometryForTaskSessionSpawn(taskId)).toEqual({ cols: expectedColumns, rows: 53 });
	});

	it("竖屏桌面后台启动使用内容区整宽和终端高度", () => {
		vi.stubGlobal("innerWidth", 1080);
		vi.stubGlobal("innerHeight", 1920);
		expect(resolveAgentTerminalGeometryForTaskSessionSpawn(taskId)).toEqual({ cols: 102, rows: 69 });
	});
	it.each([
		["手机", true, "automatic"],
		["桌面上下布局", false, "agent_above_workbench_below"],
		["桌面左右布局", false, "agent_left_workbench_right"],
	] as const)("%s 的异常视口宽度回退到持久化终端宽度", (_label, isMobile, preference) => {
		vi.stubGlobal("matchMedia", () => ({ matches: isMobile }));
		window.localStorage.setItem(LocalStorageKey.FocusViewDesktopPanelArrangementPreference, preference);
		for (const viewportWidth of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -100]) {
			vi.stubGlobal("innerWidth", viewportWidth);
			expect(resolveAgentTerminalGeometryForTaskSessionSpawn(taskId).cols).toBe(60);
		}
	});

	it.each(["automatic", "agent_above_workbench_below", "agent_left_workbench_right"])(
		"布局 %s 的异常视口高度仍提供有限的最小行数",
		(preference) => {
			vi.stubGlobal("innerWidth", 1080);
			window.localStorage.setItem(LocalStorageKey.FocusViewDesktopPanelArrangementPreference, preference);
			for (const viewportHeight of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -100]) {
				vi.stubGlobal("innerHeight", viewportHeight);
				expect(resolveAgentTerminalGeometryForTaskSessionSpawn(taskId).rows).toBe(12);
			}
		},
	);

	it("异常视口仍优先使用已实测尺寸", () => {
		vi.stubGlobal("innerWidth", Number.NaN);
		vi.stubGlobal("innerHeight", Number.NaN);
		reportTerminalGeometry(taskId, { cols: 47, rows: 19 });
		expect(resolveAgentTerminalGeometryForTaskSessionSpawn(taskId)).toEqual({ cols: 47, rows: 19 });
	});

	it("实测尺寸优先于手机后台估算", () => {
		vi.stubGlobal("innerWidth", 390);
		reportTerminalGeometry(taskId, { cols: 47, rows: 19 });
		expect(resolveAgentTerminalGeometryForTaskSessionSpawn(taskId)).toEqual({ cols: 47, rows: 19 });
	});

	it("手机软键盘压低视口时保留最小行数", () => {
		vi.stubGlobal("innerWidth", 393);
		vi.stubGlobal("innerHeight", 100);
		expect(resolveAgentTerminalGeometryForTaskSessionSpawn(taskId)).toEqual({ cols: 44, rows: 12 });
	});
});
