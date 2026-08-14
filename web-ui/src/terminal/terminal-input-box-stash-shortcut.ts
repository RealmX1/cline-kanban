// 终端里按 Ctrl+S：把输入框里打了一半的内容存进 Kanban 的 Prompt Library。
//
// 前端在这条链路里**只做两件事**：认出按键、把结果讲给用户听。读框、把折叠掉的粘贴换回原文、
// 写库、清框全在服务端的一个 procedure 里原子完成——那份「Claude 的输入框长什么样」的知识
// 随 agent 版本漂移，只在一处存放才不会两边各自腐烂，而且 W1 的争用抢占要复用同一条链路。

import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTerminalInputBoxStashResponse } from "@/runtime/types";
import { isMacPlatform } from "@/utils/platform";

// Ctrl+S / （macOS 上）Cmd+S。
//
// 为什么两个都要：Ctrl+S 是 agent 自己的 stash 键，用户的肌肉记忆在这里；而 macOS 用户按 Cmd+S 的
// 概率同样高，xterm 只对 Ctrl+S 做 preventDefault，Cmd+S 会一路漏给浏览器弹出「存储页面」对话框——
// 那是本特性接手之前就存在的缺陷，顺手一起接管。
export function isStashTerminalInputBoxToPromptLibraryShortcut(event: KeyboardEvent): boolean {
	if (event.type !== "keydown" || event.altKey || event.shiftKey) {
		return false;
	}
	if (event.key.toLowerCase() !== "s") {
		return false;
	}
	if (event.ctrlKey && !event.metaKey) {
		return true;
	}
	return isMacPlatform && event.metaKey && !event.ctrlKey;
}

interface TerminalInputBoxStashToast {
	intent: "success" | "warning" | "danger" | "none";
	message: string;
}

function describeStashFidelityCaveat(response: RuntimeTerminalInputBoxStashResponse): string {
	const unbackfilledPlaceholderCount =
		(response.fidelity?.placeholdersLeftUnbackfilledBecausePayloadWasDropped ?? 0) +
		(response.fidelity?.placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched ?? 0) +
		// 整框自洽性校验没过时占位符一个都没换回来，必须照样说出来——三项互斥（校验没过就一次都
		// 没配过），相加不会重复计数，漏掉它才是把「整框都没还原」讲成了「一切正常」。
		(response.fidelity?.placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed ?? 0);
	// 只报「存进去的这段文字里有多少处还原不了」，不把输入侧账本的 unrecoverablePasteCount 加进来——
	// 两者会重叠（一段被丢正文的粘贴若同时是折叠占位符的来源，两边各记一次），相加就是虚报。
	// 那个计数仍留在响应里给程序化消费者（W1 争用抢占据它决定不抢占）。
	if (unbackfilledPlaceholderCount === 0) {
		return "";
	}
	return `，其中 ${unbackfilledPlaceholderCount} 处折叠粘贴无法还原（占位符原样保留）`;
}

// 把这次暂存的结论讲成一句人话。返回 null = 不打扰用户：什么都没发生、也没有任何东西出错。
export function describeTerminalInputBoxStashOutcome(
	response: RuntimeTerminalInputBoxStashResponse,
): TerminalInputBoxStashToast | null {
	switch (response.outcome) {
		case "stashed_into_prompt_library":
			return {
				intent: describeStashFidelityCaveat(response) === "" ? "success" : "warning",
				message: `已暂存 ${response.stashedTextCharacterCount} 个字符到 Prompt Library${describeStashFidelityCaveat(response)}`,
			};
		case "stashed_into_prompt_library_but_input_box_not_cleared":
			// 内容确实进库了，但读框到清框之间终端被 refresh / 退出，清框字节没敢往新会话上打。必须把
			// 「框没清」说出来：只报成功会让用户看着还在的输入框反过来怀疑内容到底存进去没有。
			return {
				intent: "warning",
				message: `已暂存 ${response.stashedTextCharacterCount} 个字符到 Prompt Library${describeStashFidelityCaveat(response)}；期间终端会话已被刷新或退出，输入框未被清空（内容仍留在框里，可自行删除）`,
			};
		case "another_terminal_input_box_stash_attempt_already_in_flight_for_this_task":
			// 连按 / 多标签页同时触发。这一次按键什么都没做——说出来，别让用户以为存了两条或者以为存成功了。
			return {
				intent: "warning",
				message: "已有一次暂存正在进行中，这一次按键未处理；输入框内容原样保留，稍后可再按一次",
			};
		case "prompt_library_write_failed":
			return {
				intent: "danger",
				message: `写入 Prompt Library 失败，内容仍留在输入框里：${response.error ?? "未知错误"}`,
			};
		case "input_box_content_unreadable_forwarded_to_agent_native_stash":
			return {
				intent: "none",
				message: "读不出输入框内容（该 agent 的输入框结构尚未建模），未入库；Ctrl+S 已交给 agent 自己处理",
			};
		case "input_box_screen_text_not_corroborated_by_keystroke_tracking":
			return {
				intent: "none",
				message: "输入框里的文字没有经过 Kanban，无法与 agent 的占位提示区分，未入库；Ctrl+S 已交给 agent 自己处理",
			};
		default:
			// 框本来就是空的 / 这个任务没有运行中的终端会话——都是「什么也没发生」，不值得弹提示。
			//
			// `input_box_content_unreadable_and_left_untouched` 也落在这里，且必须落在这里：它只可能由
			// W1 争用抢占产生（抢占路径读不出正文时一个字节都不打进框），而抢占发生时根本没有人按下这个
			// 快捷键——这个函数的每一位读者都是刚按完键的用户。给他弹一句关于别的路径的提示纯属噪音。
			return null;
	}
}

export async function stashTerminalInputBoxToPromptLibrary(args: {
	workspaceId: string;
	taskId: string;
}): Promise<void> {
	try {
		const response = await getRuntimeTrpcClient(args.workspaceId).runtime.stashTerminalInputBoxToPromptLibrary.mutate(
			{ taskId: args.taskId },
		);
		const toast = describeTerminalInputBoxStashOutcome(response);
		if (toast) {
			showAppToast({ intent: toast.intent, message: toast.message }, `terminal-input-box-stash:${args.taskId}`);
		}
	} catch (error) {
		// 请求根本没到服务端：这一次按键什么都没做，框里的内容原封不动。必须说出来——静默失败正是
		// 这一整条工作流要根除的东西。
		showAppToast(
			{
				intent: "danger",
				message: `暂存到 Prompt Library 失败，内容仍留在输入框里：${error instanceof Error ? error.message : String(error)}`,
			},
			`terminal-input-box-stash:${args.taskId}`,
		);
	}
}
