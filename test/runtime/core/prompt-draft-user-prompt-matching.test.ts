import { describe, expect, it } from "vitest";
import { matchPromptDraftAgainstSubmittedUserPrompt } from "../../../src/core/prompt-draft-user-prompt-matching";

describe("草稿与真实用户提示的文字匹配", () => {
	it("规范化空白与 Unicode 后识别全文相等，空草稿不命中", () => {
		expect(matchPromptDraftAgainstSubmittedUserPrompt("修复\r\n 登录按钮", "修复 登录按钮")).toBe("normalized_exact");
		expect(matchPromptDraftAgainstSubmittedUserPrompt("cafe\u0301", "café")).toBe("normalized_exact");
		expect(matchPromptDraftAgainstSubmittedUserPrompt(" ", " ")).toBeNull();
	});
	it("长提示中完整包含草稿即可命中，但短词不能凭包含命中", () => {
		const draft = "请修复登录按钮并为用户登录失败增加清晰的错误提示";
		expect(matchPromptDraftAgainstSubmittedUserPrompt(draft, `先看这里。${draft}。最后运行测试。`)).toBe(
			"exact_substring",
		);
		expect(matchPromptDraftAgainstSubmittedUserPrompt("删除", "不要删除")).toBeNull();
	});
	it("识别长提示内部的小幅改写，而非要求整条提示长度接近", () => {
		const draft = "请修复用户登录页面上的按钮状态，并补充登录失败时的错误提示，然后运行相关的自动化测试确认行为";
		const submitted = `上下文和补充要求。${draft.replace("按钮状态", "按钮样式")}。最后说明测试结果。`;
		expect(matchPromptDraftAgainstSubmittedUserPrompt(draft, submitted)).toBe("approximate_substring");
		expect(
			matchPromptDraftAgainstSubmittedUserPrompt(draft, "请分析数据库连接池以及服务端内存占用的问题"),
		).toBeNull();
	});
	it("不把短文本改写当作高置信近似匹配，超预算仍保留精确包含", () => {
		expect(matchPromptDraftAgainstSubmittedUserPrompt("修复登录按钮", "修复注册按钮")).toBeNull();
		const draft = "需要完整保留的用户提示内容以及对应的自动化验证要求";
		expect(matchPromptDraftAgainstSubmittedUserPrompt(draft, `${"背景".repeat(50_000)}${draft}`)).toBe(
			"exact_substring",
		);
		expect(matchPromptDraftAgainstSubmittedUserPrompt(draft.repeat(1_000), "不同内容".repeat(10_000))).toBeNull();
	});
});
