import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAgentTerminalGeometryForTaskSessionSpawn } from "@/terminal/agent-terminal-geometry-for-task-session-spawn";
import { clearTerminalGeometry, reportTerminalGeometry } from "@/terminal/terminal-geometry-registry";
import { MOBILE_VIEWPORT_MAX_WIDTH_PX } from "@/utils/mobile-viewport-breakpoint";

vi.mock("@/resize/detail-terminal-panel-width", () => ({ loadDetailTerminalPanelWidth: () => 520 }));
vi.mock("@/resize/use-card-detail-layout", () => ({ MIN_DETAIL_DIFF_PANEL_WIDTH_PX: 360 }));

const taskId = "mobile-background-startup-geometry";

beforeEach(() => {
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
		expect(resolveAgentTerminalGeometryForTaskSessionSpawn(taskId)).toEqual({ cols: expectedColumns, rows: 53 });
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
