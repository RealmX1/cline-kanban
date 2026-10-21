import { describe, expect, it } from "vitest";
import {
	composeNotificationSpeechAnnouncementScript,
	deriveSpokenTaskLabelFromTaskTitleSnapshot,
} from "../../src/notifications/notification-speech-announcement-script";

function candidate(overrides: Partial<Parameters<typeof composeNotificationSpeechAnnouncementScript>[0]> = {}) {
	return {
		taskId: "686f7",
		taskTitleSnapshot: "修复通知语音",
		repositoryNameSnapshot: "cline-kanban",
		summaryText: "已修复 `src/notifications/notification-speech-synthesis.ts`，提交 d017a1e3。",
		summaryLanguage: "zh-CN" as const,
		spokenSummaryTextForNotificationSpeech: null,
		...overrides,
	};
}

describe("通知语音播报脚本（先导 + 正文）", () => {
	it("先导念项目名与任务标签，正文经规整", () => {
		expect(composeNotificationSpeechAnnouncementScript(candidate())).toEqual({
			leadInText: "项目 cline kanban，任务：修复通知语音。",
			bodyText: "已修复 notification speech synthesis，提交。",
		});
	});

	it("LLM 的朗读版摘要优先，仍过规整兜底", () => {
		expect(
			composeNotificationSpeechAnnouncementScript(
				candidate({ spokenSummaryTextForNotificationSpeech: "通知语音模块已修复，`kanban-hooks` 需要你 review。" }),
			).bodyText,
		).toBe("通知语音模块已修复，kanban hooks 需要你 review。");
	});

	it.each([
		[
			"长 prompt 标题截到第一个分句",
			"好像跨 Task 协调的时候，有 AI 会有倾向将文件放到某个系统重启就会被重置的文件目录里",
			"好像跨 Task 协调的时候",
		],
		[
			"去掉 [TAG] 分类前缀",
			"[RESEARCH,AGENT]排查 Cursor 打开 13 周前旧任务失败原因",
			"排查 Cursor 打开 13 周前旧任务失败原因",
		],
		["太短的分句继续往后找", "修复：stop hook 误报通知", "修复：stop hook 误报通知"],
		[
			"按词边界截断，不念半个词，不以虚词收尾",
			"调查 better-ccflare 代理 bun 原生堆持续泄漏（4 天涨到约 10 GB）",
			"调查 better ccflare 代理 bun 原生堆持续泄漏",
		],
		[
			"英文标题整词截断",
			"Analyze the entirety of the work done in this repository regarding Portfolio",
			"Analyze the entirety of the work done in this repository",
		],
		["没有真实标题时念任务 ID", "Task 686f7", "686f7"],
	])("%s", (_case, taskTitleSnapshot, expectedLabel) => {
		expect(deriveSpokenTaskLabelFromTaskTitleSnapshot(taskTitleSnapshot, "686f7", "zh-CN")).toBe(expectedLabel);
	});

	it("首个分词本身超过朗读上限时按字符截断，标签不超过上限", () => {
		// 20 / 0.35 ≈ 57.1：无空格的长串只能整段成一个分词，必须按字符截到 57 个字母。
		expect(deriveSpokenTaskLabelFromTaskTitleSnapshot("A".repeat(100), "686f7", "zh-CN")).toBe("A".repeat(57));
	});

	it("没有摘要时正文用兜底句，英文用英文措辞", () => {
		expect(composeNotificationSpeechAnnouncementScript(candidate({ summaryText: "Task 686f7" })).bodyText).toBe(
			"任务有新进展，可以查看。",
		);
		expect(
			composeNotificationSpeechAnnouncementScript(
				candidate({ summaryLanguage: "en-US", taskTitleSnapshot: "Fix voice", summaryText: "Done." }),
			),
		).toEqual({ leadInText: "Project cline kanban, task: Fix voice.", bodyText: "Done." });
	});
});
