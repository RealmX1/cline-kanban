// 通知语音播报前的确定性口语化规整：把 coding agent 摘要里的路径、标识符、提交哈希、符号改写成 TTS 能读对的形式。
// 背景：qwen3-tts-flash 等模型没有发音控制，「-」会读成「减」、路径会被逐字符念出；
// 即使最强的 qwen-audio-3.0-tts-plus 在官方难读文本基准上也错约三分之一，所以无论选哪个模型都先过这一层。
// LLM 的 spokenSummaryText 已按朗读要求写过，这里是兜底：AI 评估关闭/失败、延期兜底文案、LLM 漏网的符号都靠它。
export type NotificationSpeechSummaryLanguage = "zh-CN" | "en-US";

interface SpokenFormVocabulary {
	link: string;
	directory: string;
	commandLineOption: string;
	alternative: string;
	rangeTo: string;
	approximately: string;
	multipliedBy: string;
	conjunctionAnd: string;
	conjunctionAndOrFixedExpression: string;
	clauseSeparator: string;
	sentenceTerminator: string;
	formatIssueNumber: (issueNumber: string) => string;
	formatFraction: (numerator: string, denominator: string) => string;
	formatCalendarDate: (year: string, month: string, day: string) => string;
	durationUnits: Record<"ms" | "s" | "min" | "h", string>;
}

const ENGLISH_MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

const SPOKEN_FORM_VOCABULARY_BY_SUMMARY_LANGUAGE: Record<NotificationSpeechSummaryLanguage, SpokenFormVocabulary> = {
	"zh-CN": {
		link: "链接",
		directory: "目录",
		commandLineOption: "参数",
		alternative: "或",
		rangeTo: "到",
		approximately: "约",
		multipliedBy: "乘",
		conjunctionAnd: "和",
		conjunctionAndOrFixedExpression: "和或",
		clauseSeparator: "，",
		sentenceTerminator: "。",
		formatIssueNumber: (issueNumber) => `${issueNumber} 号`,
		formatFraction: (numerator, denominator) => `${denominator} 分之 ${numerator}`,
		formatCalendarDate: (year, month, day) => `${year}年${Number(month)}月${Number(day)}日`,
		durationUnits: { ms: "毫秒", s: "秒", min: "分钟", h: "小时" },
	},
	"en-US": {
		link: "a link",
		directory: "folder",
		commandLineOption: "option",
		alternative: "or",
		rangeTo: "to",
		approximately: "about",
		multipliedBy: "times",
		conjunctionAnd: "and",
		conjunctionAndOrFixedExpression: "and or",
		clauseSeparator: ", ",
		sentenceTerminator: ". ",
		formatIssueNumber: (issueNumber) => `number ${issueNumber}`,
		formatFraction: (numerator, denominator) => `${numerator} of ${denominator}`,
		formatCalendarDate: (year, month, day) =>
			`${ENGLISH_MONTH_NAMES[Number(month) - 1] ?? month} ${Number(day)}, ${year}`,
		durationUnits: { ms: "milliseconds", s: "seconds", min: "minutes", h: "hours" },
	},
};

// 只认常见源码/配置/产物扩展名：通用的「点后跟字母」会误伤 e.g.、版本号和域名。
const KNOWN_FILE_EXTENSION_PATTERN_SOURCE =
	"(?:tsx?|jsx?|mjs|cjs|json|jsonl|mdx?|s?css|less|html?|ya?ml|toml|ini|z?sh|bash|py|rs|go|java|kt|swift|rb|php|cpp|hpp|sql|sqlite|db|txt|log|lock|env|grit|wav|mp3|png|jpe?g|gif|svg|webp|pdf|plist|xml|csv|tsv|patch|diff|vue|svelte)";
const TRAILING_KNOWN_FILE_EXTENSION_PATTERN = new RegExp(`\\.${KNOWN_FILE_EXTENSION_PATTERN_SOURCE}$`, "iu");
// 行号后缀：`:12`、`:12-30`、`:12:5`、GitHub 风格 `#L12-L30`。
const SOURCE_LOCATION_SUFFIX_PATTERN_SOURCE = "(?::\\d+(?:[-–]\\d+)?(?::\\d+)?|#L\\d+(?:-L?\\d+)?)";
const TRAILING_SOURCE_LOCATION_SUFFIX_PATTERN = new RegExp(`${SOURCE_LOCATION_SUFFIX_PATTERN_SOURCE}$`, "u");
// 带至少一个斜杠的路径 token：前一支是 `/x`、`~/x`、`./x`、`../x` 起头的绝对/家目录/相对路径，后一支是 `a/b` 形式。
const SLASH_SEPARATED_PATH_TOKEN_PATTERN = new RegExp(
	`(?<![\\p{L}\\p{N}_.~])(?:~|\\.{1,2})?(?:\\/[\\w.@+-]+)+\\/?${SOURCE_LOCATION_SUFFIX_PATTERN_SOURCE}?|(?:[\\w.@+-]+\\/)+[\\w.@+-]*${SOURCE_LOCATION_SUFFIX_PATTERN_SOURCE}?`,
	"gu",
);
const BARE_FILE_NAME_TOKEN_PATTERN = new RegExp(
	`(?<![\\w./@-])[\\w-][\\w.-]*\\.${KNOWN_FILE_EXTENSION_PATTERN_SOURCE}${SOURCE_LOCATION_SUFFIX_PATTERN_SOURCE}?(?![\\w])`,
	"giu",
);

function isLowercaseCommitHash(token: string): boolean {
	return /^[0-9a-f]{7,40}$/u.test(token) && /\d/u.test(token) && /[a-f]/u.test(token);
}

// 把「一个名字」（反引号内容、路径、文件名）改成只念最后一段：社区做法（agent-tts 等）也是只念文件名，
// 完整相对路径留在面板文本里。目录（以 `/` 结尾）念成「X 目录」，scoped 包 `@scope/name` 念成「scope name」。
function convertTechnicalNameToSpokenName(rawName: string, vocabulary: SpokenFormVocabulary): string {
	const name = rawName.trim().replace(TRAILING_SOURCE_LOCATION_SUFFIX_PATTERN, "");
	const segments = name.split("/").filter(Boolean);
	if (name.startsWith("@") && segments.length === 2) return `${segments[0]?.slice(1)} ${segments[1]}`;
	const isDirectory = name.length > 1 && name.endsWith("/");
	const lastSegment = (segments.at(-1) ?? name)
		.replace(/\(\)$/u, "")
		.replace(TRAILING_KNOWN_FILE_EXTENSION_PATTERN, "")
		.replace(/^\.(?=[A-Za-z])/u, "")
		// `x.test`、`vite.config` 这类多段文件名里的点改成词间空格。
		.replace(/(?<=[A-Za-z])\.(?=[A-Za-z])/gu, " ");
	return isDirectory ? `${lastSegment} ${vocabulary.directory}` : lastSegment;
}

function convertSlashSeparatedToken(
	token: string,
	isImmediatelyFollowedByLetter: boolean,
	vocabulary: SpokenFormVocabulary,
): string {
	const tokenWithoutLocation = token.replace(TRAILING_SOURCE_LOCATION_SUFFIX_PATTERN, "");
	// 「typecheck/biome/单测」：结尾斜杠后面紧跟文字时是并列项，不是目录。
	if (isImmediatelyFollowedByLetter && tokenWithoutLocation.endsWith("/"))
		return `${tokenWithoutLocation.split("/").filter(Boolean).join(` ${vocabulary.alternative} `)} ${vocabulary.alternative} `;
	const slashCount = (tokenWithoutLocation.match(/\//gu) ?? []).length;
	const segments = tokenWithoutLocation.split("/").filter(Boolean);
	const isUnambiguousPath =
		/^(?:~|\.{1,2})?\//u.test(tokenWithoutLocation) ||
		tokenWithoutLocation.endsWith("/") ||
		// 多段全小写才算路径（web-ui/src/hooks）；F1/F2/F3、Codex/Cline/ACP 这类带大写的并列项照念「或」。
		(slashCount >= 2 &&
			segments.every((segment) => /^[a-z0-9._@-]+$/u.test(segment)) &&
			segments.some((segment) => /[a-z]{3,}/u.test(segment))) ||
		TRAILING_KNOWN_FILE_EXTENSION_PATTERN.test(segments.at(-1) ?? "") ||
		(tokenWithoutLocation.startsWith("@") && segments.length === 2);
	if (isUnambiguousPath) return ` ${convertTechnicalNameToSpokenName(token, vocabulary)} `;
	// 只有一个斜杠、又不像文件：按并列项（P1/P2、read/write）念「或」。
	return segments.join(` ${vocabulary.alternative} `);
}

function truncateSpokenTextAtSentenceBoundary(
	spokenText: string,
	maximumSpokenCharacters: number,
	vocabulary: SpokenFormVocabulary,
): string {
	if (spokenText.length <= maximumSpokenCharacters) return spokenText;
	const head = spokenText.slice(0, maximumSpokenCharacters);
	const minimumKeptCharacters = Math.floor(maximumSpokenCharacters * 0.4);
	for (let index = head.length - 1; index >= minimumKeptCharacters; index--) {
		const character = head.charAt(index);
		// 半角标点后面必须是空白或结尾才算句界，避免把 v0.1.0 这类版本号从中间截断。
		const isSentenceBoundary =
			"。！？；".includes(character) || ("!?;.".includes(character) && /^\s?$/u.test(spokenText.charAt(index + 1)));
		if (isSentenceBoundary) return head.slice(0, index + 1).trim();
	}
	// 中文里的空格只是中英文之间的间隔，不是停顿；只有英文才在词间空格处截断。
	const clauseBoundaryCharacters = vocabulary.sentenceTerminator === "。" ? ["，", "、", ","] : [",", " "];
	const lastClauseBoundary = Math.max(...clauseBoundaryCharacters.map((character) => head.lastIndexOf(character)));
	const clipped = (lastClauseBoundary >= minimumKeptCharacters ? head.slice(0, lastClauseBoundary) : head).trim();
	return `${clipped.replace(/[，,、：:\s]+$/u, "")}${vocabulary.sentenceTerminator.trim()}`;
}

export function convertTechnicalTextToNotificationSpokenForm(
	technicalText: string,
	summaryLanguage: NotificationSpeechSummaryLanguage,
	options: { maximumSpokenCharacters?: number } = {},
): string {
	const vocabulary = SPOKEN_FORM_VOCABULARY_BY_SUMMARY_LANGUAGE[summaryLanguage];
	// 规整只服务朗读，超长 finalMessage 先截断，避免对整段 agent 输出跑正则。
	let spoken = technicalText.slice(0, 8_000);

	// 1. markdown 结构：代码块不念，链接只留文字，裸 URL 念成「链接」，去掉标题/引用/列表符号与强调符号。
	spoken = spoken
		.replace(/```[\s\S]*?(?:```|$)/gu, " ")
		.replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/gu, "$1")
		.replace(/<?https?:\/\/[^\s<>()（）「」]+>?/gu, ` ${vocabulary.link} `)
		.replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gmu, "")
		.replace(/(\*\*|__)(.+?)\1/gu, "$2");

	// 2. 换行变句读：上一行没有标点收尾时补一个句号，避免两行被连读成一句。
	spoken = spoken.replace(/[ \t]*\n+[ \t]*/gu, (_match, offset: number, whole: string) => {
		const previousCharacter = whole.slice(0, offset).trimEnd().at(-1);
		return !previousCharacter || /[。！？；：，、.!?;:,]/u.test(previousCharacter)
			? " "
			: `${vocabulary.sentenceTerminator.trim()} `;
	});

	// 3. 反引号：单个名字只念最后一段；带空格的内容（命令）去掉反引号后交给后续通用规则。
	spoken = spoken
		.replace(/`([^`\n]+)`/gu, (_match, content: string) =>
			/\s/u.test(content.trim()) ? ` ${content} ` : ` ${convertTechnicalNameToSpokenName(content, vocabulary)} `,
		)
		.replace(/`/gu, " ");

	// 4. 日期、UUID、提交哈希：先于连字符与范围处理，避免日期被念成「2026 到 10 到 02」。
	spoken = spoken
		.replace(/(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\w-])/gu, (_match, year: string, month: string, day: string) =>
			vocabulary.formatCalendarDate(year, month, day),
		)
		.replace(/(?<![\w-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\w-])/giu, " ")
		.replace(/[（(]\s*([0-9a-f]{7,40})\s*[)）]/gu, (match, token: string) =>
			isLowercaseCommitHash(token) ? " " : match,
		)
		// 「本地 main 为 8b3dab6b 并吸收」：连同前面的单字连接词一起去掉，不留悬空的「为」。
		.replace(
			/(?:(?:至|为|是|到|成|现|从)\s*|(?<=\s|^)(?:to|as|at|is|from)\s+)?(?<![\w-])([0-9a-f]{7,40})(?![\w-])/gu,
			(match, token: string) => (isLowercaseCommitHash(token) ? " " : match),
		)
		// 「（6544a983 / 578616aa）」去掉哈希后只剩分隔符的括号整体删除；「（3c6ea3ca，未推送）」去掉括号内残留的开头分隔符。
		.replace(/[（(][\s/、,，;；]*[)）]/gu, "")
		.replace(/([（(])[\s/、,，;；]+/gu, "$1")
		.replace(/[\s/、,，;；]+([)）])/gu, "$1");

	// 5. 含斜杠或 # 的固定表达先于路径与符号清理：and/or、和/或 若当成并列项会念成「and or or」「和 或 或」；
	// C#、F#、Q# 的 # 会在第 10 步被删成只剩字母，所以先改成「C sharp」（`#123` 编号由第 8 步处理，不受影响）；
	// 分数（3/5）否则会被当成并列项念成「3 或 5」。
	spoken = spoken
		.replace(/(?<![\w./@~-])and\s*\/\s*or(?![\w/@-]|\.\w)/giu, vocabulary.conjunctionAndOrFixedExpression)
		.replace(/(?<!\/)[和与]\s*\/\s*或(?!\/)/gu, vocabulary.conjunctionAndOrFixedExpression)
		.replace(
			/(?<![\w.#@-])([CFQ])#(?![\w#+])/giu,
			(_match, languageLetter: string) => `${languageLetter.toUpperCase()} sharp`,
		)
		.replace(/(?<![\w./])(\d+)\/(\d+)(?![\w./])/gu, (_match, numerator: string, denominator: string) =>
			vocabulary.formatFraction(numerator, denominator),
		);

	// 6. 路径与文件名：只念最后一段，去扩展名与行号；`Node.js` 这类专名保留 JS。
	spoken = spoken
		.replace(SLASH_SEPARATED_PATH_TOKEN_PATTERN, (token, offset: number, whole: string) =>
			convertSlashSeparatedToken(token, /\p{L}/u.test(whole.charAt(offset + token.length)), vocabulary),
		)
		.replace(/\b([A-Z][a-z]+)\.js\b/gu, "$1 JS")
		.replace(BARE_FILE_NAME_TOKEN_PATTERN, (token) => ` ${convertTechnicalNameToSpokenName(token, vocabulary)} `)
		.replace(/(?<=^|[\s（(「，,：:])\.(?=[a-z])/gu, "");

	// 7. 命令行参数：`--dry-run` → 「dry run 参数」，`-p` → 「p 参数」。
	spoken = spoken
		.replace(/(?<=^|[\s（(「，,：:])--([A-Za-z][\w-]*)/gu, `$1 ${vocabulary.commandLineOption}`)
		.replace(/(?<=^|[\s（(「，,：:])-([A-Za-z]{1,2})(?=[\s，,。.)）」]|$)/gu, `$1 ${vocabulary.commandLineOption}`);

	// 8. 数字与符号：范围念「到」（T1–T10 也算），约数、乘号、箭头、&、#号、时长单位。
	spoken = spoken
		.replace(
			/(?<![\w.-])((?:[A-Za-z]{1,3}-?)?\d+(?:\.\d+)?)\s*[-–—~～]\s*((?:[A-Za-z]{1,3}-?)?\d+(?:\.\d+)?)(?![\w.-])/gu,
			`$1 ${vocabulary.rangeTo} $2`,
		)
		.replace(/(?<=^|[^\w])[~～≈]\s*(?=\d)/gu, vocabulary.approximately)
		.replace(/(?<=\d\s?[A-Za-z]{0,3})\s*[×*]\s*(?=\d)/gu, ` ${vocabulary.multipliedBy} `)
		.replace(/\s*(?:->|=>|→|⇒|⟶)\s*/gu, ` ${vocabulary.rangeTo} `)
		.replace(/\s*&{1,2}\s*/gu, ` ${vocabulary.conjunctionAnd} `)
		.replace(/(?<![\w&])#(\d+)\b/gu, (_match, issueNumber: string) => vocabulary.formatIssueNumber(issueNumber))
		.replace(
			/(?<![\w.])(\d+(?:\.\d+)?)(ms|s|min|h)\b/gu,
			(_match, amount: string, unit: keyof SpokenFormVocabulary["durationUnits"]) =>
				`${amount} ${vocabulary.durationUnits[unit]}`,
		);

	// 9. 标识符拆词：kebab-case / snake_case / SCREAMING_SNAKE 改空格，camelCase 拆词；`-` 不再有机会被读成「减」。
	spoken = spoken
		.replace(/(?<=[A-Za-z0-9])[-_]+(?=[A-Za-z0-9])/gu, " ")
		.replace(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/gu, " ");

	// 10. 剩余符号：前后带空格的破折号改成停顿，斜杠念「或」，其余标记符号直接去掉；emoji 不念。
	spoken = spoken
		.replace(/\s+[-–—]+\s+|——/gu, vocabulary.clauseSeparator)
		.replace(/\s*\/\s*/gu, ` ${vocabulary.alternative} `)
		.replace(/[\\|*<>{}[\]^$"_#@~=-]/gu, " ")
		.replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu, "");

	// 11. 收尾：合并空白与重复标点，去掉中文标点两侧多余空格和规整后留下的空括号。
	spoken = spoken
		.replace(/\s+/gu, " ")
		.replace(/[（(]\s*[)）]/gu, "")
		.replace(/ *([，。！？；：、）」』]) */gu, "$1")
		.replace(/ +(?=[,.;:!?)](?:\s|$))/gu, "")
		.replace(/([（「『]) +/gu, "$1")
		.replace(/[，,、；;：:]\s*(?=[，,。.！!？?；;：:])/gu, "")
		.replace(/([。！？.!?])(?:\s*[。.])+/gu, "$1")
		.replace(/^[\s，,。.；;：:、]+/u, "")
		.trim();

	return options.maximumSpokenCharacters === undefined
		? spoken
		: truncateSpokenTextAtSentenceBoundary(spoken, options.maximumSpokenCharacters, vocabulary);
}
