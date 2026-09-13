import { describe, expect, it } from "vitest";
import {
	hasCodexStartupPromptReady,
	hasCodexUnsubmittedProgrammaticPrompt,
} from "../../../src/terminal/codex-readiness";

describe("Codex 首发就绪与输入框残留", () => {
	it("拒绝 loading、目录信任与仍在启动的忙碌视口", () => {
		for (const viewport of [
			"OpenAI Codex (v0.154.0)\nmodel: loading\n› ",
			"model: gpt-test\nDo you trust the contents\n› 1. Yes",
			"model: gpt-test\n› /plan 检查\ntab to queue message",
		])
			expect(hasCodexStartupPromptReady(viewport)).toBe(false);
		expect(hasCodexStartupPromptReady("model: gpt-test\n› ")).toBe(true);
		expect(hasCodexStartupPromptReady("恢复的历史\n› \n100% context left")).toBe(true);
	});

	it("背景粒子不掩盖残留正文，已进入历史的同文消息不算残留", () => {
		const prompt = "/plan 检查首条消息\n保留第二行";
		expect(hasCodexUnsubmittedProgrammaticPrompt("› ⠁/plan 检查首条消息⠠\n保留第二行", prompt)).toBe(true);
		expect(hasCodexUnsubmittedProgrammaticPrompt(`› ${prompt}\n回复已完成\n› Ask Codex to do anything`, prompt)).toBe(
			false,
		);
	});

	it("按 Unicode 字符数识别长粘贴占位符", () => {
		const prompt = `/plan ${"中文😀\n".repeat(400)}`;
		const viewport = `› /plan [Pasted Content ${Array.from(prompt.slice(6)).length} chars]`;
		expect(hasCodexUnsubmittedProgrammaticPrompt(viewport, prompt)).toBe(true);
	});
});
