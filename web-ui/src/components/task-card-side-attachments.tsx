import { autoUpdate, computePosition, flip, shift } from "@floating-ui/dom";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/ui/cn";
import { useTaskCardPortalWheelScrollForwarding } from "@/hooks/use-task-card-portal-wheel-scroll-forwarding";
import { useMedia } from "@/utils/react-use";

/** 桌面附着区逃离 column 裁切；触屏留在卡底，只有显示时才观察位置。 */
export function TaskCardSideAttachments({
	id,
	cardElementRef,
	isCardActive,
	children,
}: {
	id: string;
	cardElementRef: RefObject<HTMLElement | null>;
	isCardActive: boolean;
	children: ReactNode;
}) {
	const usesTouchActionRow = useMedia("(hover: none), (pointer: coarse)", false);
	const attachmentsElementRef = useRef<HTMLDivElement>(null);
	const forwardWheelRef = useTaskCardPortalWheelScrollForwarding(cardElementRef, attachmentsElementRef);
	const [hasKeyboardFocus, setHasKeyboardFocus] = useState(false);
	const [hasOpenPanel, setHasOpenPanel] = useState(false);
	const isVisible = isCardActive || hasKeyboardFocus || hasOpenPanel;
	useEffect(() => {
		const card = cardElementRef.current;
		const attachments = attachmentsElementRef.current;
		if (usesTouchActionRow || !isVisible || !card || !attachments) return;
		let disposed = false;
		const stopPositionUpdates = autoUpdate(card, attachments, () => {
			void computePosition(card, attachments, {
				strategy: "fixed",
				placement: "right-start",
				middleware: [flip({ boundary: [], padding: 4 }), shift({ boundary: [], padding: 4 })],
			}).then(({ x, y, placement }) => {
				if (disposed) return;
				Object.assign(attachments.style, { left: `${x}px`, top: `${y}px` });
				attachments.dataset.attachmentSide = placement.startsWith("left") ? "left" : "right";
			});
		});
		const observeOpenPanels = () => setHasOpenPanel(attachments.querySelector('[aria-expanded="true"]') !== null);
		observeOpenPanels();
		const observer = new MutationObserver(observeOpenPanels);
		observer.observe(attachments, { subtree: true, attributes: true, attributeFilter: ["aria-expanded"] });
		return () => {
			disposed = true;
			stopPositionUpdates();
			observer.disconnect();
		};
	}, [cardElementRef, usesTouchActionRow, isVisible]);
	const attachments = (
		<div
			id={id}
			ref={forwardWheelRef}
			data-task-card-side-attachments=""
			data-task-card-side-attachments-state={usesTouchActionRow || isVisible ? "visible" : "hidden"}
			onFocusCapture={() => setHasKeyboardFocus(true)}
			onBlurCapture={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setHasKeyboardFocus(false);
			}}
			className={cn(
				"kb-task-card-side-attachments group/task-card-attachments empty:hidden flex gap-1 p-1 text-[10px]",
				usesTouchActionRow
					? "relative mt-1 flex-wrap items-center"
					: "fixed z-40 w-16 flex-col items-stretch rounded-md bg-surface-2 transition-opacity motion-reduce:transition-none",
				!usesTouchActionRow && !isVisible && "pointer-events-none opacity-0",
			)}
		>
			{children}
		</div>
	);
	return usesTouchActionRow ? attachments : createPortal(attachments, document.body);
}
