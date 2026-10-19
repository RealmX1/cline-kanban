import { describe, expect, it } from "vitest";
import {
	getDefaultProjectVisualIdentity,
	PROJECT_PRESET_ICON_IDS,
	PROJECT_VISUAL_COLOR_IDS,
} from "../../src/core/project-visual-identity";

describe("项目默认标识", () => {
	it.each([
		["cline-kanban", "KanbanSquare", "blue"],
		["vibe-kanban", "LayoutDashboard", "cyan"],
		["my-kanban", "ClipboardList", "teal"],
		["review-validate-fix", "ShieldCheck", "green"],
		["Trace-of-Thought", "BrainCircuit", "purple"],
		["Trace-of-Thought-Landing-Page", "Globe", "cyan"],
		["Trace-of-Thought-Marketing", "Megaphone", "orange"],
		["Trace-of-Thought-Legal", "Scale", "slate"],
		["Philosophy-of-AI-Systems", "Lightbulb", "amber"],
		["doctoral-research-proposal", "GraduationCap", "indigo"],
		["ai-analysis", "ChartNoAxesCombined", "blue"],
		["team-knowledge", "LibraryBig", "green"],
		["novel", "PenLine", "rose"],
		["Summer-Camp-Projects", "Rocket", "orange"],
		["workflow-plugin-design-system", "Workflow", "indigo"],
		["orchestration-infra", "Network", "slate"],
		["my-ai-setup", "Settings2", "cyan"],
		["agent-skills", "Puzzle", "purple"],
		["iii", "Plug", "teal"],
		["orca", "Waves", "cyan"],
		["better-ccflare", "Flame", "amber"],
		["oh-my-pi", "Terminal", "purple"],
		["diff-level-agent-work-attribution", "GitCompareArrows", "orange"],
		["Fractelier", "Layers", "rose"],
		["agent-conversation-exploration-thread-graph", "GitBranch", "purple"],
		["Project Theseus", "Ship", "teal"],
		["openrig", "Wrench", "orange"],
		["Instrumentality", "Shapes", "red"],
	])("%s 首次升级与恢复默认使用批准组合", (name, presetIconId, colorId) => {
		expect(getDefaultProjectVisualIdentity("workspace-id", name)).toEqual({
			iconSource: "preset",
			presetIconId,
			colorId,
			imageAssetId: null,
		});
	});
	it("提供批准的 36 个图标和 12 色", () => {
		expect(PROJECT_PRESET_ICON_IDS).toHaveLength(36);
		expect(PROJECT_VISUAL_COLOR_IDS).toHaveLength(12);
	});
	it("建议映射忽略名称大小写，恢复后不依赖旧配置", () => {
		expect(getDefaultProjectVisualIdentity("id", "Philosophy-of-AI-Systems")).toEqual({
			iconSource: "preset",
			presetIconId: "Lightbulb",
			colorId: "amber",
			imageAssetId: null,
		});
		expect(getDefaultProjectVisualIdentity("id", "cline-kanban").presetIconId).toBe("KanbanSquare");
		expect(getDefaultProjectVisualIdentity("id", "Instrumentality").colorId).toBe("red");
	});
	it("未知项目由 workspace ID 稳定选色", () => {
		const identity = getDefaultProjectVisualIdentity("unknown-workspace", "new-project");
		expect(identity.presetIconId).toBe("FolderGit2");
		expect(getDefaultProjectVisualIdentity("unknown-workspace", "renamed-project")).toEqual(identity);
	});
	it.each(["constructor", "CONSTRUCTOR", "__proto__"])("继承属性名 %s 使用 workspace ID 稳定回退", (name) => {
		expect(getDefaultProjectVisualIdentity("unknown-workspace", name)).toEqual(
			getDefaultProjectVisualIdentity("unknown-workspace", "new-project"),
		);
	});
});
