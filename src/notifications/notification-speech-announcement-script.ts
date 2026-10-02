// 通知语音播报脚本 = 先导（哪个项目、哪个任务）+ 正文（发生了什么）。两段分开合成，中间插入静音，
// 让用户先定位来源、稍作停顿再听内容；同一任务每次念出的先导完全一样，所以任务标签只做确定性派生，不交给 LLM 起名。
import type {
	NotificationCandidate,
	NotificationSpeechAnnouncementScript,
} from "../core/notification-lifecycle-contract";
import {
	convertTechnicalTextToNotificationSpokenForm,
	type NotificationSpeechSummaryLanguage,
} from "./notification-speech-technical-text-to-spoken-form";

// EXPERIMENT_NODE: 先导里任务标签的最大朗读长度（汉字计 1、其它字符计 0.35，约等于 20 个汉字或 57 个英文字符）
const SPOKEN_TASK_LABEL_MAXIMUM_SPEECH_WEIGHT = 20;
const SPOKEN_TASK_LABEL_MINIMUM_CLAUSE_SPEECH_WEIGHT = 4;
// 英文字符的朗读时长约为汉字的三分之一（约 14 字符/秒 对 约 4.5 字/秒）。
const NON_HAN_CHARACTER_SPEECH_WEIGHT = 0.35;
// 正文上限：qwen3-tts 实测约 10 个汉字/秒，200 字约 20 秒；英文按约 15 字符/秒折算。
export const NOTIFICATION_SPOKEN_BODY_MAXIMUM_CHARACTERS_BY_SUMMARY_LANGUAGE: Record<
	NotificationSpeechSummaryLanguage,
	number
> = { "zh-CN": 200, "en-US": 400 };

const FALLBACK_SPOKEN_BODY_BY_SUMMARY_LANGUAGE: Record<NotificationSpeechSummaryLanguage, string> = {
	"zh-CN": "任务有新进展，可以查看。",
	"en-US": "The task has an update to review.",
};

const FULL_WIDTH_SCRIPT_CHARACTER_PATTERN = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

function measureSingleCharacterSpeechWeight(character: string): number {
	return FULL_WIDTH_SCRIPT_CHARACTER_PATTERN.test(character) ? 1 : NON_HAN_CHARACTER_SPEECH_WEIGHT;
}

function measureSpeechWeight(text: string): number {
	let weight = 0;
	for (const character of text) weight += measureSingleCharacterSpeechWeight(character);
	return weight;
}

// 中文按词切分（ICU 词典），避免把「触发条件」截成「触发条」；英文单词整词保留。
const CHINESE_WORD_SEGMENTER = new Intl.Segmenter("zh", { granularity: "word" });
const DANGLING_TRAILING_FUNCTION_WORD_PATTERN =
	/(?:[的了和与及并或在把对将从以为被向于]|\s+(?:for|of|to|the|a|an|and|or|with|in|on|at|from|by))+$/iu;

// 逐字符累加朗读权重，截到不超过上限的最长前缀；只给「首个分词本身就超长」这种没有词边界可退的情况兜底。
function truncateBySpeechWeightAtCharacterBoundary(text: string, maximumSpeechWeight: number): string {
	let kept = "";
	let keptSpeechWeight = 0;
	for (const character of text) {
		const characterSpeechWeight = measureSingleCharacterSpeechWeight(character);
		if (keptSpeechWeight + characterSpeechWeight > maximumSpeechWeight) break;
		kept += character;
		keptSpeechWeight += characterSpeechWeight;
	}
	return kept;
}

// 按朗读长度截断：只在词边界断开，不会念出半个词；唯一例外是首个分词本身就超过上限
// （无空格的长标识符、长串字母等），此时退回按字符截断，保证任何输入的标签都不超过朗读上限。
function truncateBySpeechWeightAtWordBoundary(text: string, maximumSpeechWeight: number): string {
	const tokens = Array.from(CHINESE_WORD_SEGMENTER.segment(text), (segment) => segment.segment);
	let kept = "";
	for (const token of tokens) {
		const candidate = kept + token;
		if (measureSpeechWeight(candidate.trimEnd()) > maximumSpeechWeight) {
			if (!kept.trim()) kept = truncateBySpeechWeightAtCharacterBoundary(candidate, maximumSpeechWeight);
			break;
		}
		kept = candidate;
	}
	return kept.trim();
}

export function deriveSpokenTaskLabelFromTaskTitleSnapshot(
	taskTitleSnapshot: string,
	taskId: string,
	summaryLanguage: NotificationSpeechSummaryLanguage,
): string {
	const normalizedTitle = taskTitleSnapshot.replace(/\s+/gu, " ").trim();
	// 档案默认标题是 `Task <id>`：先导里直接念任务 ID，避免「任务 Task 686f7」。
	// EXPERIMENT_NODE: 先导是否在任务标签后附带 5 位任务 ID（目前只在没有真实标题时念 ID）
	if (!normalizedTitle || normalizedTitle === `Task ${taskId}`) return taskId;
	// 看板卡片标题常以 `[RESEARCH,AGENT]` 这类分类前缀开头，朗读时去掉。
	const titleWithoutCategoryTags = normalizedTitle.replace(/^(?:\s*(?:\[[^\]\n]{0,60}\]|【[^】\n]{0,60}】))+\s*/u, "");
	const spokenTitle = convertTechnicalTextToNotificationSpokenForm(titleWithoutCategoryTags, summaryLanguage);
	// 任务标题常常就是用户的原始 prompt：截到第一个分句（且不短于 4 个字）为止，念卡片标题的开头。
	let firstClause = spokenTitle;
	for (const boundary of spokenTitle.matchAll(/[。！？!?；;，,：:（(]|\s[-–—]\s/gu)) {
		const clause = spokenTitle.slice(0, boundary.index).trim();
		if (measureSpeechWeight(clause) >= SPOKEN_TASK_LABEL_MINIMUM_CLAUSE_SPEECH_WEIGHT) {
			firstClause = clause;
			break;
		}
	}
	// 截断可能落在括号里：未闭合的括号连同内容一起去掉。
	const truncatedLabel = truncateBySpeechWeightAtWordBoundary(
		firstClause,
		SPOKEN_TASK_LABEL_MAXIMUM_SPEECH_WEIGHT,
	).replace(/\s*[（(][^）)]*$/u, "");
	// 截断后不以「的」「for」这类虚词收尾。
	const labelWithoutDanglingParticle =
		truncatedLabel.length < firstClause.length
			? truncatedLabel.replace(DANGLING_TRAILING_FUNCTION_WORD_PATTERN, "")
			: truncatedLabel;
	return labelWithoutDanglingParticle.replace(/[，,、。.！!？?；;：:\s]+$/u, "") || taskId;
}

export function composeNotificationSpeechAnnouncementScript(
	candidate: Pick<
		NotificationCandidate,
		| "taskId"
		| "taskTitleSnapshot"
		| "repositoryNameSnapshot"
		| "summaryText"
		| "summaryLanguage"
		| "spokenSummaryTextForNotificationSpeech"
	>,
): NotificationSpeechAnnouncementScript {
	const summaryLanguage = candidate.summaryLanguage;
	const spokenRepositoryName =
		convertTechnicalTextToNotificationSpokenForm(candidate.repositoryNameSnapshot, summaryLanguage) ||
		(summaryLanguage === "zh-CN" ? "未知项目" : "unknown project");
	const spokenTaskLabel = deriveSpokenTaskLabelFromTaskTitleSnapshot(
		candidate.taskTitleSnapshot,
		candidate.taskId,
		summaryLanguage,
	);
	const leadInText =
		summaryLanguage === "zh-CN"
			? `项目 ${spokenRepositoryName}，任务：${spokenTaskLabel}。`
			: `Project ${spokenRepositoryName}, task: ${spokenTaskLabel}.`;
	// LLM 专为朗读写的版本优先；没有时（AI 评估关闭/失败、延期兜底）退回面板摘要，两者都过规整器兜底。
	const spokenSummarySource = candidate.spokenSummaryTextForNotificationSpeech?.trim() || candidate.summaryText;
	const bodyText =
		spokenSummarySource.trim() === `Task ${candidate.taskId}`
			? FALLBACK_SPOKEN_BODY_BY_SUMMARY_LANGUAGE[summaryLanguage]
			: convertTechnicalTextToNotificationSpokenForm(spokenSummarySource, summaryLanguage, {
					maximumSpokenCharacters:
						NOTIFICATION_SPOKEN_BODY_MAXIMUM_CHARACTERS_BY_SUMMARY_LANGUAGE[summaryLanguage],
				}) || FALLBACK_SPOKEN_BODY_BY_SUMMARY_LANGUAGE[summaryLanguage];
	return { leadInText, bodyText };
}
