import { Children, type ComponentProps, isValidElement } from "react";
import { NonModalFloatingFormWindow } from "@/components/non-modal-floating-form-window";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogHeader } from "@/components/ui/dialog";

/** 填写表单保留既有正文、底栏和展开尺寸，只共用窗口交互。 */
export function NonModalFormDialog({ children, contentClassName, ...props }: ComponentProps<typeof Dialog>) {
	const contents = Children.toArray(children);
	const header = contents.find(
		(child) => isValidElement<ComponentProps<typeof DialogHeader>>(child) && child.type === DialogHeader,
	);
	if (!isValidElement<ComponentProps<typeof DialogHeader>>(header))
		return (
			<Dialog {...props} contentClassName={contentClassName}>
				{children}
			</Dialog>
		);
	return (
		<NonModalFloatingFormWindow
			{...props}
			title={header.props.title}
			headerActions={header.props.children}
			maximumExpandedViewportHeightRatio={0.85}
			expandedWidth="90vw"
			contentClassName={cn(
				"w-[90vw]",
				!/(?:^|\s)!?max-w-/.test(contentClassName ?? "") && "max-w-lg",
				contentClassName,
			)}
		>
			{contents.filter((child) => child !== header)}
		</NonModalFloatingFormWindow>
	);
}
