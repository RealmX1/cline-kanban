// 排队 prompt 的「合并成一次投递」与预览截断——两个纯函数，零 IO、零依赖运行时状态。
//
// 单列一个模块而不是塞进 store：出队引擎、推流投影、前端预览三处都要用同一份口径，而 store 是
// Node-only（碰 fs）。放这里让它跟着 @runtime-contract 那条纯契约链路走。

import {
	QUEUED_TASK_PROMPT_DELIVERY_TEXT_PREVIEW_MAX_LENGTH,
	type QueuedTaskPromptDeliveryEntry,
} from "./api-contract";

// 从 head 开始，沿 deliverTogetherWithNextQueuedEntry 收一条**连续**的链。
//
// 「连续」是硬要求：链条只在数组相邻位上成立。默认没人打开合并开关 ⇒ 每次都只收到 head 一条 ⇒
// 就是用户选定的「一轮一条」。
//
// 最后一条的开关值被忽略（它没有「下一条」可合并）——这不是漏判：用户把队尾那条也点亮，语义只能是
// 「等下一条排进来时跟它一起发」，而那一条此刻还不存在，本次投递里没有任何东西可拼。
export function collectQueuedTaskPromptDeliveryChainFromHead(
	entriesInDeliveryOrder: readonly QueuedTaskPromptDeliveryEntry[],
): QueuedTaskPromptDeliveryEntry[] {
	if (entriesInDeliveryOrder.length === 0) {
		return [];
	}
	const chain: QueuedTaskPromptDeliveryEntry[] = [entriesInDeliveryOrder[0]];
	for (let index = 0; index < entriesInDeliveryOrder.length - 1; index += 1) {
		if (!entriesInDeliveryOrder[index].deliverTogetherWithNextQueuedEntry) {
			break;
		}
		chain.push(entriesInDeliveryOrder[index + 1]);
	}
	return chain;
}

// 把一条链拼成一条投递正文。
//
// **刻意不加任何分隔标记**（没有 `---`、没有「第 N 条」、没有任何机器生成的抬头）：用户打开合并开关的
// 意思是「把这几条当成我写的同一条消息发出去」，而 agent 读到的每一个字节都会被当成用户说的话。
// 插一行「--- queued item 2 ---」等于替用户说了一句他没说过的话，而且是一句会被当成指令读的话。
//
// 用空行连接（而不是单个换行）是 markdown 语义下的最小正确做法：单换行会把上一条末尾的列表项 /
// 代码围栏与下一条的开头黏成同一个块。各段先去掉首尾空白，于是「用户自己末尾多敲了两个回车」
// 不会让拼出来的正文出现三四个空行。
export function buildMergedQueuedTaskPromptDeliveryText(chain: readonly QueuedTaskPromptDeliveryEntry[]): string {
	return chain
		.map((entry) => entry.text.trim())
		.filter((text) => text.length > 0)
		.join("\n\n");
}

// 推流投影用的截断预览。正文是易膨胀数据，不上热广播链路（理由同 board.json 的裁定）。
//
// 截断后补省略号而不是硬切：UI 上「刚好停在 200 字」与「后面还有 8000 字」必须一眼可分，
// 否则用户会以为自己排的就是这么短一条。真实长度另由 textLength 如实上报。
export function buildQueuedTaskPromptDeliveryTextPreview(text: string): string {
	const normalized = text.trim();
	if (normalized.length <= QUEUED_TASK_PROMPT_DELIVERY_TEXT_PREVIEW_MAX_LENGTH) {
		return normalized;
	}
	return `${normalized.slice(0, QUEUED_TASK_PROMPT_DELIVERY_TEXT_PREVIEW_MAX_LENGTH)}…`;
}
