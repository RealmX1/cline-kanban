// 终端输入框暂存进 Prompt Library 的整条原子链路：读框 → 回填被折叠的粘贴 → 写库 → 转发 Ctrl+S 清框。
//
// 从 `src/trpc/runtime-api.ts` 里的请求作用域闭包提出来，是因为它有第三类调用方要用：排队投递
// dispatcher 由「agent 这一轮结束」的边沿驱动，手上根本没有 TRPC 请求，而 `createRuntimeApi` 是
// **每请求**新建的（`src/server/runtime-server.ts` 的 `createTrpcContext`）。抽取本身**不改任何行为**，
// 只把 workspace 作用域从闭包变量降为显式参数。
//
// 三个调用方共用它，且**必须**共用：① 用户在终端按下 Ctrl+S；② 争用抢占（程序化投递撞上人类未提交
// 的输入、且人不在场时，先把那段输入无损存进库再腾出框）；③ 待答用户决定的答案投递。三者的差别只有
// origin 一个字段——各写一份的话，「先写库后清框」「令牌对不上就不清框」「屏上文本无击键佐证就不入库」
// 这些一步都不能错的次序迟早会在其中一份里走样。

import { randomUUID } from "node:crypto";
import type {
	PromptLibraryEntryOrigin,
	PromptLibraryScope,
	RuntimeTerminalInputBoxStashResponse,
} from "../core/api-contract";
import { mutateWorkspacePromptLibrary } from "../state/prompt-library-store";
import type { TerminalSessionManager } from "./session-manager";

// 一次终端输入框暂存是谁发起的。
//
// **必须是单一参数**：它同时决定两件事——① 入库条目的 origin 标签；② 读不出正文时**能不能**转发
// Ctrl+S 清框。两者必须由同一个事实推出。拆成「origin 标签」+「允许清框」两个参数，迟早会出现
// 「标成抢占来源、却按用户按键的策略清了框」这种自相矛盾的组合，而那正是本参数要根除的缺陷本身：
// 在此之前 origin 已经传进来了，却只用来贴标签，一个字都没参与清框判定。
export type TerminalInputBoxStashInitiator =
	| "human_pressed_stash_key_in_terminal"
	| "programmatic_delivery_contention_preemption";

const PROMPT_LIBRARY_ENTRY_ORIGIN_BY_TERMINAL_INPUT_BOX_STASH_INITIATOR: Record<
	TerminalInputBoxStashInitiator,
	PromptLibraryEntryOrigin
> = {
	human_pressed_stash_key_in_terminal: "terminal_stash_by_user",
	programmatic_delivery_contention_preemption: "terminal_stash_preempted_by_programmatic_delivery",
};

export interface StashTaskTerminalInputBoxIntoPromptLibraryDependencies {
	// 已绑定到目标 workspace 的取管理器函数。刻意不收 workspace scope 对象再自己去解析：那会让
	// `src/terminal/` 反向依赖 `src/trpc/` 的作用域类型，而现有依赖方向是 terminal → state 单向。
	getTerminalSessionManagerForWorkspace: () => Promise<TerminalSessionManager>;
}

export interface StashTaskTerminalInputBoxIntoPromptLibraryRequest {
	workspaceId: string;
	taskId: string;
	scope: PromptLibraryScope;
	initiatedBy: TerminalInputBoxStashInitiator;
}

export async function stashTaskTerminalInputBoxIntoPromptLibrary(
	deps: StashTaskTerminalInputBoxIntoPromptLibraryDependencies,
	request: StashTaskTerminalInputBoxIntoPromptLibraryRequest,
): Promise<RuntimeTerminalInputBoxStashResponse> {
	let terminalManager: TerminalSessionManager;
	try {
		terminalManager = await deps.getTerminalSessionManagerForWorkspace();
	} catch (error) {
		return {
			ok: false,
			outcome: "no_active_terminal_session" as const,
			stashedPromptId: null,
			stashedTextCharacterCount: 0,
			fidelity: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return await terminalManager.runTaskTerminalInputBoxStashAttemptExclusivelyPerTask<RuntimeTerminalInputBoxStashResponse>(
		request.taskId,
		async () => {
			const capture = await terminalManager.captureTaskTerminalInputBoxContentForPromptLibraryStash(request.taskId);
			if (!capture) {
				return {
					ok: true,
					outcome: "no_active_terminal_session" as const,
					stashedPromptId: null,
					stashedTextCharacterCount: 0,
					fidelity: null,
				};
			}
			if (capture.status !== "captured_stashable_text") {
				// 转发 Ctrl+S 与否**只看发起方**，不按捕获状态分类讨论。
				//
				// 争用抢占这条路径上根本没有人按键，也就没有任何键需要「替他送到 agent」。此时转发就是
				// 凭空清掉人类打了一半的那半句：正文被 agent 自己的暂存区吞掉、Kanban 侧一无所有，而
				// 抢占方随后如实返回失败、这次投递压根不会发生——内容没了，连一次投递都没换到。
				//
				// 只有 input_box_content_unreadable 是真正会丢字的那一格（输入侧字节跟踪确知框里有未提交
				// 内容、读屏拿不到正文）；另两格不丢字（两侧都说空 / 屏上有字但一个字节都没经过 writeInput，
				// 多半是 agent 自己渲染的占位提示）。即便如此这里也不按状态开口子：判据是「没人按键」，
				// 一句话说得完、也没有下一个状态被漏掉的余地，而按状态枚举一旦将来新增一格就会默认落进
				// 「照常清框」那一侧。
				if (request.initiatedBy === "programmatic_delivery_contention_preemption") {
					return {
						ok: true,
						// 三格里只有「读不到正文」需要一个专属取值：它与用户按键路径的
						// ..._forwarded_to_agent_native_stash 是同一个捕获结果、相反的处置，共用一个名字
						// 就等于让回执自己撒谎（名字里明写着 forwarded）。另两格的名字本就不含处置，
						// 两条路径共用不会说错话——而它们之间那点事实差别（有没有把一个键打进一个我们
						// 认定为空的框）不改变任何调用方的决策。
						outcome:
							capture.status === "input_box_empty"
								? ("input_box_empty_nothing_to_stash" as const)
								: capture.status === "input_box_content_unreadable"
									? ("input_box_content_unreadable_and_left_untouched" as const)
									: ("input_box_screen_text_not_corroborated_by_keystroke_tracking" as const),
						stashedPromptId: null,
						stashedTextCharacterCount: 0,
						fidelity: capture.fidelity,
					};
				}
				// 用户亲手按了 Ctrl+S：没有可入库的正文，但仍然转发。那是这个键的原生语义，agent 自己的
				// 暂存区会接住任何我们读不到的内容——不入库不等于要把用户的按键吞掉。
				const forwardedToSameTerminalSessionIncarnation =
					terminalManager.forwardStashKeyToClearTaskTerminalInputBox(
						request.taskId,
						capture.terminalSessionIncarnationToken,
					);
				if (!forwardedToSameTerminalSessionIncarnation) {
					// 读框到这一刻之间那条 PTY 已经退出/被换代。既没入库也没转发，什么都没发生——
					// 报「没有可信的终端会话」，而不是硬说「已交给 agent 自己处理」。
					return {
						ok: true,
						outcome: "no_active_terminal_session" as const,
						stashedPromptId: null,
						stashedTextCharacterCount: 0,
						fidelity: capture.fidelity,
					};
				}
				return {
					ok: true,
					outcome:
						capture.status === "input_box_empty"
							? ("input_box_empty_nothing_to_stash" as const)
							: capture.status === "input_box_content_unreadable"
								? ("input_box_content_unreadable_forwarded_to_agent_native_stash" as const)
								: ("input_box_screen_text_not_corroborated_by_keystroke_tracking" as const),
					stashedPromptId: null,
					stashedTextCharacterCount: 0,
					fidelity: capture.fidelity,
				};
			}
			const scope = request.scope;
			const stashedPromptId = randomUUID();
			try {
				await mutateWorkspacePromptLibrary(request.workspaceId, {
					kind: "upsert_prompt",
					promptId: stashedPromptId,
					text: capture.text,
					scope,
					// scope 非 task 时传 null：带着一个用不上的 taskId 只会让存储层的桶判定多一个歧义输入。
					taskId: scope === "task" ? request.taskId : null,
					origin: PROMPT_LIBRARY_ENTRY_ORIGIN_BY_TERMINAL_INPUT_BOX_STASH_INITIATOR[request.initiatedBy],
					// 保真度随条目一起落库，别只回给这一次请求的调用方：抢占来源的条目写进来时用户
					// 根本不在场，那条只弹一次的 toast 没有任何人看得见。
					terminalInputBoxStashFidelity: capture.fidelity,
				});
			} catch (error) {
				// **不**转发 Ctrl+S：正文原样留在框里，用户看得见、能重试。转发只会把它藏进 agent 的
				// 暂存区，而 Kanban 这边什么都没有——那是「回执说成功、东西不在」的同一种撒谎。
				return {
					ok: false,
					outcome: "prompt_library_write_failed" as const,
					stashedPromptId: null,
					stashedTextCharacterCount: 0,
					fidelity: capture.fidelity,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			// 上面这段 await 跨了文件锁与落盘（可达数十毫秒），期间 refresh 会整体换掉 active。
			// 令牌对不上时 manager 拒绝转发，这里必须把「框没清」如实说出来：正文确实进库了
			// （ok 仍为 true、stashedPromptId 有效），但框还在。
			const clearedTheSameTerminalSessionIncarnationWeReadFrom =
				terminalManager.forwardStashKeyToClearTaskTerminalInputBox(
					request.taskId,
					capture.terminalSessionIncarnationToken,
				);
			return {
				ok: true,
				outcome: clearedTheSameTerminalSessionIncarnationWeReadFrom
					? ("stashed_into_prompt_library" as const)
					: ("stashed_into_prompt_library_but_input_box_not_cleared" as const),
				stashedPromptId,
				stashedTextCharacterCount: capture.text.length,
				fidelity: capture.fidelity,
			};
		},
		() => ({
			// 同一 task 上已有一次暂存在跑。这一次按键没入库、也没转发 Ctrl+S，框里内容一个字没少。
			// ok 为 false：用户要求的事这一次确实没做成，静默报成功就是这条工作流要根除的那种撒谎。
			ok: false,
			outcome: "another_terminal_input_box_stash_attempt_already_in_flight_for_this_task" as const,
			stashedPromptId: null,
			stashedTextCharacterCount: 0,
			fidelity: null,
		}),
	);
}
