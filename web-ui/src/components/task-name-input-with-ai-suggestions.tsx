import { deriveTaskTitleFromPrompt } from "@runtime-task-title";
import { Loader2, Sparkles } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { suggestTaskNamesFromTaskDescription } from "@/runtime/task-name-suggestion-query";
import type { RuntimeTaskNameSuggestionResponse } from "@/runtime/types";

/** 一次「起名」按钮按下换回来的那组候选。轮次累积、不清空，供用户对照与回选。 */
interface TaskNameSuggestionRound {
	/** 1 起，界面上直接显示成「第 N 次」。 */
	roundOrderNumber: number;
	suggestedTaskNames: string[];
}

/**
 * 名字框里当前那个值是谁写的。
 *
 * 用来决定「再按一次起名」时要不要用新一轮的推荐项覆盖当前值：上一轮候选写进去的可以覆盖
 * （用户就是嫌上一轮不好才再按的），用户自己敲的不能覆盖。
 */
type TaskNameOrigin = "typed_by_user" | "picked_from_suggestion";

function describeTaskNameSuggestionUnavailable(
	response: Extract<RuntimeTaskNameSuggestionResponse, { status: "unavailable" }>,
): string {
	switch (response.unavailableReason) {
		case "api_key_not_configured":
			// 这条 reason 覆盖两种情形：「一家 provider 都没配」不带 detail，走下面那句「去配一把 key」；
			// 「配了却没有可用的默认」由运行时带一条说清该声明哪个变量的 detail —— 那种情形下 key 早就配好了，
			// 再照着 reason 让用户去配 key 只会给出一条指向已配置变量的、不可操作的提示。
			// 明说变量名：这条提示的唯一作用就是让用户知道该去配什么。
			return response.unavailableDetail
				? `AI naming is off — ${response.unavailableDetail}`
				: "AI naming is off — set KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY (or another provider) for the Kanban runtime process.";
		case "task_description_empty":
			return "Write a task description first.";
		default:
			return response.unavailableDetail
				? `Could not suggest names: ${response.unavailableDetail}`
				: "Could not suggest names.";
	}
}

/**
 * 建卡时的任务名字输入框，外加一个「让 AI 起名」按钮。
 *
 * 留空是合法且常见的：提交时会先用描述推导一个标题落卡，AI 名字回来后再异步回填
 * （见 use-task-editor 的 backfillSuggestedTaskTitleForCreatedTask）。所以这里既不校验也不拦提交。
 *
 * 候选轮次是**组件本地** state：它只在这一次建卡期间有意义，建完卡由调用方换 key 整体重置。
 */
export function TaskNameInputWithAiSuggestions({
	taskName,
	onTaskNameChange,
	taskDescription,
	disabled = false,
}: {
	taskName: string;
	onTaskNameChange: (taskName: string) => void;
	/** 起名依据，同时也用来算出「留空的话会叫什么」那个 placeholder。 */
	taskDescription: string;
	disabled?: boolean;
}): ReactElement {
	const taskNameInputId = useId();
	const [suggestionRounds, setSuggestionRounds] = useState<TaskNameSuggestionRound[]>([]);
	const [isSuggestionRequestInFlight, setIsSuggestionRequestInFlight] = useState(false);
	const [suggestionUnavailableNotice, setSuggestionUnavailableNotice] = useState<string | null>(null);
	// 请求回来时要读「此刻」的名字、来源与描述，不能用发起那一帧闭包里的旧值。
	const taskNameOriginRef = useRef<TaskNameOrigin>("picked_from_suggestion");
	const latestTaskNameRef = useRef(taskName);
	latestTaskNameRef.current = taskName;
	const latestTaskDescriptionRef = useRef(taskDescription);
	latestTaskDescriptionRef.current = taskDescription;

	// 起名请求是异步的，回来时本组件实例可能已经不在场了：对话框被关掉（Radix 关闭即卸载内容），
	// 或勾了「Create more」建下一张卡时被父层换 key 整体重挂。而 onTaskNameChange 是父层 useState
	// 的 setter、跨渲染身份稳定，所以不设防的话，上一张卡的候选名会被旧请求写进下一张卡的名字框。
	const isComponentStillMountedRef = useRef(true);
	// 每按一次「起名」自增一格，resolve 回调只认自己发起时的那一格；过期的整份丢弃。
	const latestSuggestionRequestGenerationNumberRef = useRef(0);
	useEffect(() => {
		isComponentStillMountedRef.current = true;
		return () => {
			isComponentStillMountedRef.current = false;
		};
	}, []);

	const hasTaskDescription = taskDescription.trim().length > 0;
	const derivedTaskTitlePlaceholder = deriveTaskTitleFromPrompt(taskDescription);

	const handleTypeTaskName = useCallback(
		(nextTaskName: string) => {
			taskNameOriginRef.current = "typed_by_user";
			onTaskNameChange(nextTaskName);
		},
		[onTaskNameChange],
	);

	const handlePickSuggestedTaskName = useCallback(
		(suggestedTaskName: string) => {
			taskNameOriginRef.current = "picked_from_suggestion";
			onTaskNameChange(suggestedTaskName);
		},
		[onTaskNameChange],
	);

	const handleRequestAnotherSuggestionRound = useCallback(() => {
		if (isSuggestionRequestInFlight || !hasTaskDescription) {
			return;
		}
		latestSuggestionRequestGenerationNumberRef.current += 1;
		const suggestionRequestGenerationNumberOfThisRound = latestSuggestionRequestGenerationNumberRef.current;
		// 起名依据要在发起这一刻定格：回来时再读 props 就分不清这组候选是照着哪份描述起的了。
		const taskDescriptionThisRoundWasNamedFrom = taskDescription;
		/** 这一份响应还该不该落到界面上：组件已卸载、或已被更新一轮请求取代，都算作废。 */
		const isThisRoundStillTheLiveSuggestionRequest = (): boolean =>
			isComponentStillMountedRef.current &&
			latestSuggestionRequestGenerationNumberRef.current === suggestionRequestGenerationNumberOfThisRound;
		setIsSuggestionRequestInFlight(true);
		setSuggestionUnavailableNotice(null);
		void (async () => {
			try {
				const response = await suggestTaskNamesFromTaskDescription(taskDescriptionThisRoundWasNamedFrom);
				if (!isThisRoundStillTheLiveSuggestionRequest()) {
					return;
				}
				if (response.status !== "suggested") {
					setSuggestionUnavailableNotice(describeTaskNameSuggestionUnavailable(response));
					return;
				}
				setSuggestionRounds((currentRounds) => [
					...currentRounds,
					{ roundOrderNumber: currentRounds.length + 1, suggestedTaskNames: response.suggestedTaskNames },
				]);
				const recommendedTaskName = response.suggestedTaskNames[0];
				// 在途期间描述被改过：这组候选是照着已作废的描述起的。轮次照常列出来供用户自己挑
				//（点击是用户的主动选择），但不再自动填入——自动填入的前提是名字与当前描述对得上。
				const isTaskDescriptionStillTheOneThisRoundWasNamedFrom =
					latestTaskDescriptionRef.current === taskDescriptionThisRoundWasNamedFrom;
				const isCurrentTaskNameSafeToReplace =
					latestTaskNameRef.current.trim().length === 0 || taskNameOriginRef.current === "picked_from_suggestion";
				if (
					recommendedTaskName &&
					isTaskDescriptionStillTheOneThisRoundWasNamedFrom &&
					isCurrentTaskNameSafeToReplace
				) {
					handlePickSuggestedTaskName(recommendedTaskName);
				}
			} catch (error) {
				if (!isThisRoundStillTheLiveSuggestionRequest()) {
					return;
				}
				setSuggestionUnavailableNotice(
					`Could not suggest names: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				// 作废的那一份不许再动进行中标记，否则会把接替它的那一轮的转圈提前抹掉。
				if (isThisRoundStillTheLiveSuggestionRequest()) {
					setIsSuggestionRequestInFlight(false);
				}
			}
		})();
	}, [handlePickSuggestedTaskName, hasTaskDescription, isSuggestionRequestInFlight, taskDescription]);

	return (
		<div className="mb-2.5">
			<label htmlFor={taskNameInputId} className="text-[11px] text-text-secondary block mb-1">
				Task name
			</label>
			<div className="flex items-center gap-1.5">
				<input
					id={taskNameInputId}
					type="text"
					value={taskName}
					onChange={(event) => handleTypeTaskName(event.target.value)}
					disabled={disabled}
					placeholder={derivedTaskTitlePlaceholder || "Leave empty to name this task from the description"}
					className="flex-1 min-w-0 rounded-md border border-border-bright bg-surface-3 px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-40"
				/>
				<Button
					variant="ghost"
					size="sm"
					icon={
						isSuggestionRequestInFlight ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />
					}
					onClick={handleRequestAnotherSuggestionRound}
					disabled={disabled || isSuggestionRequestInFlight || !hasTaskDescription}
					title={hasTaskDescription ? "Suggest task names from the description" : "Write a task description first"}
				>
					{suggestionRounds.length === 0 ? "Suggest names" : "Suggest more"}
				</Button>
			</div>

			{suggestionUnavailableNotice ? (
				<p className="mt-1.5 text-[11px] text-text-tertiary">{suggestionUnavailableNotice}</p>
			) : null}

			{/* 最新一轮在最上面，早先几轮往下压但不清空——用户要能回头挑上一轮那个。 */}
			{[...suggestionRounds].reverse().map((round) => (
				<div key={round.roundOrderNumber} className="mt-1.5">
					<span className="text-[11px] text-text-tertiary">Suggestion {round.roundOrderNumber}</span>
					<div className="mt-1 flex flex-wrap gap-1">
						{round.suggestedTaskNames.map((suggestedTaskName) => (
							<button
								key={suggestedTaskName}
								type="button"
								onClick={() => handlePickSuggestedTaskName(suggestedTaskName)}
								disabled={disabled}
								className={cn(
									"rounded-md border px-2 py-1 text-left text-[12px] cursor-pointer",
									suggestedTaskName === taskName
										? "border-accent bg-accent/10 text-text-primary"
										: "border-border bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary",
								)}
							>
								{suggestedTaskName}
							</button>
						))}
					</div>
				</div>
			))}
		</div>
	);
}
