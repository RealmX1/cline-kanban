import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskNameInputWithAiSuggestions } from "@/components/task-name-input-with-ai-suggestions";
import type { RuntimeTaskNameSuggestionResponse } from "@/runtime/types";

const fakeTaskNameSuggestionEndpoint = vi.hoisted(() => ({
	responsesToReturn: [] as RuntimeTaskNameSuggestionResponse[],
	requestedTaskDescriptions: [] as string[],
	/**
	 * 置为 true 后请求不立刻回来，改由测试调用 resolveOldestStillInFlightSuggestionRequest 决定何时 resolve。
	 * 「在途期间发生了别的事」（关对话框、换卡重挂、改描述）这类回归只能这样才复现得出来。
	 */
	shouldHoldRequestsInFlightUntilTestResolvesThem: false,
	stillInFlightRequestResolvers: [] as ((response: RuntimeTaskNameSuggestionResponse) => void)[],
}));

vi.mock("@/runtime/task-name-suggestion-query", () => ({
	suggestTaskNamesFromTaskDescription: vi.fn(async (taskDescription: string) => {
		fakeTaskNameSuggestionEndpoint.requestedTaskDescriptions.push(taskDescription);
		if (fakeTaskNameSuggestionEndpoint.shouldHoldRequestsInFlightUntilTestResolvesThem) {
			return await new Promise<RuntimeTaskNameSuggestionResponse>((resolve) => {
				fakeTaskNameSuggestionEndpoint.stillInFlightRequestResolvers.push(resolve);
			});
		}
		const response = fakeTaskNameSuggestionEndpoint.responsesToReturn.shift();
		if (!response) {
			throw new Error("No fake response queued.");
		}
		return response;
	}),
}));

function resolveOldestStillInFlightSuggestionRequest(response: RuntimeTaskNameSuggestionResponse): void {
	const resolveRequest = fakeTaskNameSuggestionEndpoint.stillInFlightRequestResolvers.shift();
	if (!resolveRequest) {
		throw new Error("Expected a suggestion request to be in flight.");
	}
	resolveRequest(response);
}

function suggested(...suggestedTaskNames: string[]): RuntimeTaskNameSuggestionResponse {
	return { status: "suggested", suggestedTaskNames };
}

/** 名字是受控值，所以测试里得有个持有它的宿主，否则点候选看不出任何变化。 */
function TaskNameInputHarness({ taskDescription }: { taskDescription: string }): React.ReactElement {
	const [taskName, setTaskName] = useState("");
	return (
		<TaskNameInputWithAiSuggestions
			taskName={taskName}
			onTaskNameChange={setTaskName}
			taskDescription={taskDescription}
		/>
	);
}

/**
 * 复刻 TaskEditorDialog 的两个真实处境：对话框关掉（本组件整个卸载），以及勾了「Create more」
 * 建下一张卡（父层 bump composerResetKey 把本组件换 key 重挂）。名字 state 与真实实现一样留在
 * 父层，所以子组件被卸载或换掉之后，仍然看得见「有没有被旧请求写进去过」。
 */
function TaskNameInputUnmountAndRemountHarness({
	taskDescription,
	isTaskNameInputMounted,
	taskNameInputInstanceKey,
}: {
	taskDescription: string;
	isTaskNameInputMounted: boolean;
	taskNameInputInstanceKey: number;
}): React.ReactElement {
	const [taskName, setTaskName] = useState("");
	return (
		<div>
			<p data-testid="task-name-held-by-parent">{taskName}</p>
			{isTaskNameInputMounted ? (
				<TaskNameInputWithAiSuggestions
					key={`task-name-input-${taskNameInputInstanceKey}`}
					taskName={taskName}
					onTaskNameChange={setTaskName}
					taskDescription={taskDescription}
				/>
			) : null}
		</div>
	);
}

describe("TaskNameInputWithAiSuggestions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	function taskNameInput(): HTMLInputElement {
		const input = container.querySelector("input");
		if (!input) {
			throw new Error("Expected the task name input to be rendered.");
		}
		return input;
	}

	function suggestionChipLabels(): string[] {
		return Array.from(container.querySelectorAll("button"))
			.map((button) => button.textContent?.trim() ?? "")
			.filter((label) => label !== "Suggest names" && label !== "Suggest more");
	}

	function clickSuggestButton(): void {
		const button = Array.from(container.querySelectorAll("button")).find(
			(candidate) =>
				candidate.textContent?.trim() === "Suggest names" || candidate.textContent?.trim() === "Suggest more",
		);
		button?.click();
	}

	function taskNameHeldByParent(): string {
		return container.querySelector("[data-testid='task-name-held-by-parent']")?.textContent ?? "";
	}

	beforeEach(() => {
		fakeTaskNameSuggestionEndpoint.responsesToReturn = [];
		fakeTaskNameSuggestionEndpoint.requestedTaskDescriptions = [];
		fakeTaskNameSuggestionEndpoint.shouldHoldRequestsInFlightUntilTestResolvesThem = false;
		fakeTaskNameSuggestionEndpoint.stillInFlightRequestResolvers = [];
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("shows the title that would be derived from the description as the placeholder", async () => {
		await act(async () => {
			root.render(<TaskNameInputHarness taskDescription={"<trajectory>\nFix the SSO redirect\n</trajectory>"} />);
		});

		expect(taskNameInput().placeholder).toBe("Fix the SSO redirect");
	});

	it("disables the suggest button until there is a description", async () => {
		await act(async () => {
			root.render(<TaskNameInputHarness taskDescription="   " />);
		});

		const button = Array.from(container.querySelectorAll("button")).find(
			(candidate) => candidate.textContent?.trim() === "Suggest names",
		);
		expect(button?.disabled).toBe(true);
	});

	it("fills the field with the first candidate and lists the whole round", async () => {
		fakeTaskNameSuggestionEndpoint.responsesToReturn = [
			suggested("Fix the SSO redirect", "Repair post-SSO navigation", "Unbreak SSO login"),
		];

		await act(async () => {
			root.render(<TaskNameInputHarness taskDescription="Login redirects to a blank page after SSO" />);
		});
		await act(async () => {
			clickSuggestButton();
		});

		expect(fakeTaskNameSuggestionEndpoint.requestedTaskDescriptions).toEqual([
			"Login redirects to a blank page after SSO",
		]);
		expect(taskNameInput().value).toBe("Fix the SSO redirect");
		expect(suggestionChipLabels()).toEqual([
			"Fix the SSO redirect",
			"Repair post-SSO navigation",
			"Unbreak SSO login",
		]);
	});

	it("keeps earlier rounds on screen when more names are requested", async () => {
		fakeTaskNameSuggestionEndpoint.responsesToReturn = [suggested("Round one name"), suggested("Round two name")];

		await act(async () => {
			root.render(<TaskNameInputHarness taskDescription="Login redirects to a blank page after SSO" />);
		});
		await act(async () => {
			clickSuggestButton();
		});
		await act(async () => {
			clickSuggestButton();
		});

		// 最新一轮排在最前，早先那一轮仍在，供对照与回选。
		expect(suggestionChipLabels()).toEqual(["Round two name", "Round one name"]);
		expect(container.textContent).toContain("Suggestion 1");
		expect(container.textContent).toContain("Suggestion 2");
	});

	it("writes the clicked candidate into the field", async () => {
		fakeTaskNameSuggestionEndpoint.responsesToReturn = [suggested("Recommended name", "Runner-up name")];

		await act(async () => {
			root.render(<TaskNameInputHarness taskDescription="Login redirects to a blank page after SSO" />);
		});
		await act(async () => {
			clickSuggestButton();
		});
		await act(async () => {
			Array.from(container.querySelectorAll("button"))
				.find((candidate) => candidate.textContent?.trim() === "Runner-up name")
				?.click();
		});

		expect(taskNameInput().value).toBe("Runner-up name");
	});

	it("does not clobber a name the user typed when another round arrives", async () => {
		fakeTaskNameSuggestionEndpoint.responsesToReturn = [suggested("Suggested name")];

		await act(async () => {
			root.render(<TaskNameInputHarness taskDescription="Login redirects to a blank page after SSO" />);
		});
		await act(async () => {
			const input = taskNameInput();
			const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			nativeValueSetter?.call(input, "My own name");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			clickSuggestButton();
		});

		expect(taskNameInput().value).toBe("My own name");
		expect(suggestionChipLabels()).toContain("Suggested name");
	});

	it("explains why naming is unavailable instead of failing silently", async () => {
		fakeTaskNameSuggestionEndpoint.responsesToReturn = [
			{ status: "unavailable", unavailableReason: "api_key_not_configured" },
		];

		await act(async () => {
			root.render(<TaskNameInputHarness taskDescription="Login redirects to a blank page after SSO" />);
		});
		await act(async () => {
			clickSuggestButton();
		});

		expect(container.textContent).toContain("KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY");
		expect(suggestionChipLabels()).toEqual([]);
	});

	// 「配了 provider 却没有可用的默认」与「一家都没配」共用同一个 reason，只靠 unavailableDetail 区分。
	// 前者的 key 早就配好了，若还照着 reason 提示去 set API key，用户拿到的是一条不可操作的误导提示。
	it("shows the runtime's detail instead of the API key hint when a default provider must be declared", async () => {
		fakeTaskNameSuggestionEndpoint.responsesToReturn = [
			{
				status: "unavailable",
				unavailableReason: "api_key_not_configured",
				unavailableDetail:
					"no default model provider is selected. Set KANBAN_DEFAULT_MODEL_PROVIDER_ID to one of the configured providers (deepseek, openrouter) for the Kanban runtime process.",
			},
		];

		await act(async () => {
			root.render(<TaskNameInputHarness taskDescription="Login redirects to a blank page after SSO" />);
		});
		await act(async () => {
			clickSuggestButton();
		});

		expect(container.textContent).toContain("KANBAN_DEFAULT_MODEL_PROVIDER_ID");
		expect(container.textContent).not.toContain("KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY");
		expect(suggestionChipLabels()).toEqual([]);
	});

	it("drops a round that arrives after the dialog closed instead of writing it into the parent's name", async () => {
		fakeTaskNameSuggestionEndpoint.shouldHoldRequestsInFlightUntilTestResolvesThem = true;

		await act(async () => {
			root.render(
				<TaskNameInputUnmountAndRemountHarness
					taskDescription="Login redirects to a blank page after SSO"
					isTaskNameInputMounted={true}
					taskNameInputInstanceKey={0}
				/>,
			);
		});
		await act(async () => {
			clickSuggestButton();
		});
		// 对话框被关掉：Radix 关闭即卸载内容，本组件随之卸载，但请求还在途中。
		await act(async () => {
			root.render(
				<TaskNameInputUnmountAndRemountHarness
					taskDescription="Login redirects to a blank page after SSO"
					isTaskNameInputMounted={false}
					taskNameInputInstanceKey={0}
				/>,
			);
		});
		await act(async () => {
			resolveOldestStillInFlightSuggestionRequest(suggested("Name for the card the user already abandoned"));
		});

		expect(taskNameHeldByParent()).toBe("");
	});

	it("drops a round that arrives after Create more remounted the field for the next card", async () => {
		fakeTaskNameSuggestionEndpoint.shouldHoldRequestsInFlightUntilTestResolvesThem = true;

		await act(async () => {
			root.render(
				<TaskNameInputUnmountAndRemountHarness
					taskDescription="Login redirects to a blank page after SSO"
					isTaskNameInputMounted={true}
					taskNameInputInstanceKey={0}
				/>,
			);
		});
		await act(async () => {
			clickSuggestButton();
		});
		// 勾了「Create more」后点 Create：父层 bump composerResetKey，本组件换 key 整体重挂成下一张卡的输入框。
		await act(async () => {
			root.render(
				<TaskNameInputUnmountAndRemountHarness
					taskDescription="Something else entirely for the next card"
					isTaskNameInputMounted={true}
					taskNameInputInstanceKey={1}
				/>,
			);
		});
		await act(async () => {
			resolveOldestStillInFlightSuggestionRequest(suggested("Name for the previous card"));
		});

		// onTaskNameChange 是父层稳定的 setter，旧实例若不设防就会把上一张卡的候选名写进下一张卡。
		expect(taskNameHeldByParent()).toBe("");
		expect(taskNameInput().value).toBe("");
		expect(suggestionChipLabels()).toEqual([]);
	});

	it("lists but does not auto-fill a round whose description the user edited while it was in flight", async () => {
		fakeTaskNameSuggestionEndpoint.shouldHoldRequestsInFlightUntilTestResolvesThem = true;

		await act(async () => {
			root.render(<TaskNameInputHarness taskDescription="Login redirects to a blank page after SSO" />);
		});
		await act(async () => {
			clickSuggestButton();
		});
		// 请求还在途中，用户把描述整段换掉了——回来的候选对应的是已经作废的描述文本。
		await act(async () => {
			root.render(<TaskNameInputHarness taskDescription="Actually the export job times out on large boards" />);
		});
		await act(async () => {
			resolveOldestStillInFlightSuggestionRequest(suggested("Name from the stale description"));
		});

		// 轮次照常列出来供用户自己挑（点击是用户的主动选择），但不自动写进名字框。
		expect(suggestionChipLabels()).toEqual(["Name from the stale description"]);
		expect(taskNameInput().value).toBe("");
	});
});
