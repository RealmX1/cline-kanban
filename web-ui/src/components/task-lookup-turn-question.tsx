import { splitAgentPromptImageAttachmentReferences } from "@runtime-agent-prompt-image-attachment-reference";
import { useLayoutEffect, useRef, useState } from "react";
import { TaskImageStrip } from "@/components/task-image-strip";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { TaskImage } from "@/types";

const expandedQuestionKeys = new Set<string>();

export function TaskLookupTurnQuestion({
	questionKey,
	questionText,
	questionImages = [],
}: {
	questionKey: string;
	questionText: string;
	questionImages?: TaskImage[];
}) {
	const paragraphRef = useRef<HTMLParagraphElement>(null);
	const [isExpanded, setIsExpanded] = useState(() => expandedQuestionKeys.has(questionKey));
	const [isLongQuestion, setIsLongQuestion] = useState(false);
	const visibleQuestionText = splitAgentPromptImageAttachmentReferences(questionText).promptTextWithoutImageReferences;
	useLayoutEffect(() => {
		const paragraph = paragraphRef.current;
		if (!paragraph) return;
		const measure = () => {
			const lineHeight = Number.parseFloat(getComputedStyle(paragraph).lineHeight) || 24;
			setIsLongQuestion(paragraph.scrollHeight > lineHeight * 6 + 1 || visibleQuestionText.split("\n").length > 6);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(paragraph);
		return () => observer.disconnect();
	}, [visibleQuestionText]);
	return (
		<div className="space-y-2 rounded-md bg-surface-1 p-3" data-task-lookup-question="">
			<p
				ref={paragraphRef}
				className={cn(
					"whitespace-pre-wrap break-words text-sm font-medium leading-6",
					isLongQuestion && !isExpanded && "line-clamp-4",
				)}
			>
				{visibleQuestionText}
			</p>
			<TaskImageStrip images={questionImages} />
			{isLongQuestion ? (
				<Button
					variant="ghost"
					size="sm"
					aria-expanded={isExpanded}
					onClick={() => {
						if (isExpanded) expandedQuestionKeys.delete(questionKey);
						else expandedQuestionKeys.add(questionKey);
						setIsExpanded(!isExpanded);
					}}
				>
					{isExpanded ? "收起问题" : "展开完整问题"}
				</Button>
			) : null}
		</div>
	);
}
