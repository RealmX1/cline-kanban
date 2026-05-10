import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskInlineCreateCard } from "@/components/task-inline-create-card";
import type { TaskAutoReviewMode } from "@/types";

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: () => {},
}));

vi.mock("@/utils/react-use", async () => {
	const actual = await vi.importActual<typeof import("@/utils/react-use")>("@/utils/react-use");
	return {
		...actual,
		useMeasure: () => [
			() => {},
			{
				width: 320,
				height: 0,
				top: 0,
				left: 0,
				bottom: 0,
				right: 0,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			},
		],
	};
});

function InlineEditor({
	idPrefix,
	prompt = "Existing task",
	onCreate,
}: {
	idPrefix: string;
	prompt?: string;
	onCreate: () => void;
}): React.ReactElement {
	return (
		<TaskInlineCreateCard
			prompt={prompt}
			onPromptChange={() => {}}
			onCreate={onCreate}
			startInPlanMode={false}
			onStartInPlanModeChange={() => {}}
			autoReviewEnabled={false}
			onAutoReviewEnabledChange={() => {}}
			autoReviewMode={"commit" satisfies TaskAutoReviewMode}
			onAutoReviewModeChange={() => {}}
			workspaceId={null}
			branchRef="main"
			branchOptions={[{ value: "main", label: "main" }]}
			onBranchRefChange={() => {}}
			mode="edit"
			idPrefix={idPrefix}
		/>
	);
}

describe("TaskInlineCreateCard", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
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
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("does not save one edit card when another edit card is clicked", async () => {
		const firstSave = vi.fn();
		const secondSave = vi.fn();

		await act(async () => {
			root.render(
				<>
					<InlineEditor idPrefix="first-editor" onCreate={firstSave} />
					<InlineEditor idPrefix="second-editor" onCreate={secondSave} />
				</>,
			);
		});

		const textareas = container.querySelectorAll("textarea");
		const secondTextarea = textareas[1];
		expect(secondTextarea).toBeInstanceOf(HTMLTextAreaElement);

		await act(async () => {
			secondTextarea?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		});

		expect(firstSave).not.toHaveBeenCalled();
		expect(secondSave).not.toHaveBeenCalled();
	});

	it("saves an edit card when clicking outside inline task editors", async () => {
		const save = vi.fn();
		const outside = document.createElement("button");
		document.body.appendChild(outside);

		try {
			await act(async () => {
				root.render(<InlineEditor idPrefix="single-editor" onCreate={save} />);
			});

			await act(async () => {
				outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
			});

			expect(save).toHaveBeenCalledTimes(1);
		} finally {
			outside.remove();
		}
	});
});
