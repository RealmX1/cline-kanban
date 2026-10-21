import { describe, expect, it } from "vitest";
import { convertTechnicalTextToNotificationSpokenForm } from "../../src/notifications/notification-speech-technical-text-to-spoken-form";

// 用例取自通知档案里真实播报过、被 TTS 读错的摘要片段。
describe("通知语音的技术文本口语化规整", () => {
	it.each([
		[
			"连字符文件名不再出现「-」",
			"修复了 `use-queued-task-prompt-delivery-restart-reminder.ts`",
			"修复了 use queued task prompt delivery restart reminder",
		],
		["路径只念文件名，去扩展名和行号范围", "见 globals.css:1365-1386 的 1s×5 闪烁", "见 globals 的 1 秒 乘 5 闪烁"],
		[
			"相对路径取最后一段",
			"改动在 web-ui/src/hooks/use-review-ready-notifications.ts:280",
			"改动在 use review ready notifications",
		],
		["家目录与绝对路径", "报告存到 ~/Library/Logs，socket 回归 /tmp/cc-socks", "报告存到 Logs，socket 回归 cc socks"],
		["以斜杠结尾的是目录", "仅产出 .plan/docs/ 下的调研报告", "仅产出 docs 目录 下的调研报告"],
		[
			"环境变量与 snake_case",
			"含 CLAUDE_CODE_TMPDIR 重定向，字段 session_id",
			"含 CLAUDE CODE TMPDIR 重定向，字段 session id",
		],
		["camelCase 拆词", "expectedRevision 与服务端不一致", "expected Revision 与服务端不一致"],
		[
			"提交哈希连同括号与连接词去掉，5 位任务 ID 保留",
			"任务 21eba 已合入本地 main（d017a1e3），本地 main 为 8b3dab6b 并吸收上游",
			"任务 21eba 已合入本地 main，本地 main 并吸收上游",
		],
		[
			"两个哈希之间只剩分隔符的括号整体去掉",
			"同步本地 main（6544a983 / 578616aa），集成验证通过",
			"同步本地 main，集成验证通过",
		],
		["括号里哈希后面的分隔符一并去掉", "已合入本地 main（3c6ea3ca，未推送）", "已合入本地 main（未推送）"],
		["编号范围念「到」", "列出 T1–T10 待办，已提出 1–4 项修复", "列出 T1 到 T10 待办，已提出 1 到 4 项修复"],
		[
			"并列短项念「或」，多段大写并列项不当成路径",
			"需等 F1/F2/F3 land，另有 Codex/Cline/ACP 通道",
			"需等 F1 或 F2 或 F3 land，另有 Codex 或 Cline 或 ACP 通道",
		],
		["结尾斜杠后紧跟中文是并列项", "typecheck/biome/单测全部通过", "typecheck 或 biome 或 单测全部通过"],
		["时长单位与并列", "DeepSeek 的 6h/12h/24h 仍在等", "Deep Seek 的 6 小时 或 12 小时 或 24 小时 仍在等"],
		["命令行参数", "已 --no-ff 并回本地 main", "已 no ff 参数 并回本地 main"],
		[
			"约数、箭头、& 与 #编号",
			"约 ~30 秒，复用验证→整合方案，A & B，见 #123",
			"约 约30 秒，复用验证 到 整合方案，A 和 B，见 123 号",
		],
		["日期不被当成范围", "待办总表（2026-10-02）", "待办总表（2026年10月2日）"],
		["分数", "测试 120/123 通过", "测试 123 分之 120 通过"],
		[
			"markdown 与 emoji",
			"**已完成**：\n- 修复 A\n- 新增 B ✅\n见 [文档](https://example.com/a)",
			"已完成：修复 A。新增 B。见 文档",
		],
		["裸 URL 念「链接」", "详见 https://github.com/cline/kanban/pull/12", "详见 链接"],
		["scoped 包名", "升级 @clinebot/core 依赖", "升级 clinebot core 依赖"],
		["C++ 的加号保留", "用 C++ 重写", "用 C++ 重写"],
		["固定表达「和/或」不当成并列项重复念「或」", "跑 biome和/或单测", "跑 biome和或单测"],
		["中文语境里的 and/or 念「和或」", "跑 lint and/or tests", "跑 lint 和或 tests"],
		[
			"C#、F# 保留语言名，#编号规则不受影响",
			"新增 C# 与 F# 通知支持，见 #42",
			"新增 C sharp 与 F sharp 通知支持，见 42 号",
		],
	])("%s", (_case, technicalText, expectedSpokenText) => {
		expect(convertTechnicalTextToNotificationSpokenForm(technicalText, "zh-CN")).toBe(expectedSpokenText);
	});

	it.each([
		["and/or is read once, not as two alternatives", "Review lint and/or tests", "Review lint and or tests"],
		["C# keeps its language name", "Fixed C# notification support", "Fixed C sharp notification support"],
		[
			"C#/F# alternatives keep both names and #123 stays an issue number",
			"Added C#/F# bindings, see #123",
			"Added C sharp or F sharp bindings, see number 123",
		],
	])("英文：%s", (_case, technicalText, expectedSpokenText) => {
		expect(convertTechnicalTextToNotificationSpokenForm(technicalText, "en-US")).toBe(expectedSpokenText);
	});

	it("规整结果不再含有会被读错的符号", () => {
		const spoken = convertTechnicalTextToNotificationSpokenForm(
			"F5 已完成：提交 c9262db，契约套件 rc=0；清单在 ~/.claude/plans/rvf-cost-reduction-f5-inventory/，`D-01`、[TAG] {x} <y> a|b",
			"zh-CN",
		);
		expect(spoken).not.toMatch(/[-_/~`#*|<>{}[\]=]/u);
		expect(spoken).not.toContain("c9262db");
	});

	it("英文用英文措辞", () => {
		expect(
			convertTechnicalTextToNotificationSpokenForm(
				"Fixed `src/foo-bar.ts:12` (abc1234f), steps 1-3 passed, P1/P2 left; see https://x.dev on 2026-10-02",
				"en-US",
			),
		).toBe("Fixed foo bar, steps 1 to 3 passed, P1 or P2 left; see a link on October 2, 2026");
	});

	it("超长文本在句界截断，不在中英文间隔的空格处断开", () => {
		const sentence = "这一句话总共有二十个字符用于测试截断边界。";
		const spoken = convertTechnicalTextToNotificationSpokenForm(`${sentence.repeat(12)}`, "zh-CN", {
			maximumSpokenCharacters: 50,
		});
		expect(spoken).toBe(sentence.repeat(2));
		const withoutSentenceBoundary = convertTechnicalTextToNotificationSpokenForm(
			`共 3 项待办${"，每一项都需要 review 后才能部署".repeat(10)}`,
			"zh-CN",
			{ maximumSpokenCharacters: 40 },
		);
		expect(withoutSentenceBoundary.length).toBeLessThanOrEqual(41);
		expect(withoutSentenceBoundary).toMatch(/部署。$/u);
		expect(
			convertTechnicalTextToNotificationSpokenForm("版本 v0.1.0 已发布", "en-US", { maximumSpokenCharacters: 9 }),
		).not.toMatch(/v0\.$/u);
	});
});
