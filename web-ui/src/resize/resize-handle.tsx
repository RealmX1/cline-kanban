import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { cn } from "@/components/ui/cn";

export function ResizeHandle({
	orientation,
	ariaLabel,
	hitArea = 4,
	onMouseDown,
	onDoubleClick,
	onKeyDown,
	tabIndex,
	ariaValueNow,
	ariaValueMin,
	ariaValueMax,
	ariaValueText,
	title,
	showBaseLine = true,
	className,
	style,
}: {
	orientation: "vertical" | "horizontal";
	ariaLabel: string;
	hitArea?: number;
	onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
	onDoubleClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
	/** 以下键盘/ARIA value 参数全部可选：只有提供键盘调整入口的调用方（如主看板列宽）才需要让 separator 可聚焦。 */
	onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
	tabIndex?: number;
	ariaValueNow?: number;
	ariaValueMin?: number;
	ariaValueMax?: number;
	ariaValueText?: string;
	title?: string;
	showBaseLine?: boolean;
	className?: string;
	style?: CSSProperties;
}): React.ReactElement {
	const overlap = Math.max(0, hitArea);
	const interactiveAreaStyle =
		orientation === "vertical"
			? {
					top: 0,
					bottom: 0,
					left: -overlap,
					right: -overlap,
					cursor: "ew-resize",
				}
			: {
					left: 0,
					right: 0,
					top: -overlap,
					bottom: -overlap,
					cursor: "ns-resize",
				};

	return (
		<div
			role="separator"
			aria-orientation={orientation}
			aria-label={ariaLabel}
			onMouseDown={onMouseDown}
			onDoubleClick={onDoubleClick}
			onKeyDown={onKeyDown}
			tabIndex={tabIndex}
			aria-valuenow={ariaValueNow}
			aria-valuemin={ariaValueMin}
			aria-valuemax={ariaValueMax}
			aria-valuetext={ariaValueText}
			title={title}
			className={cn(
				"relative shrink-0 group",
				orientation === "vertical" ? "w-px self-stretch" : "h-px w-full",
				className,
			)}
			style={{ cursor: orientation === "vertical" ? "ew-resize" : "ns-resize", ...style }}
		>
			{showBaseLine ? <div className="pointer-events-none absolute inset-0 bg-border" /> : null}
			<div aria-hidden style={{ position: "absolute", zIndex: 10, ...interactiveAreaStyle }} />
		</div>
	);
}
