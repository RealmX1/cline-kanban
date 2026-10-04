import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";

const COPIED_CONFIRMATION_VISIBLE_MS = 1500;

/**
 * 截断显示一个标识符：hover 出完整值，点击复制。
 *
 * 存在理由：会话 id / agent 原生会话 id 这类标识符平时只占几个字符的位置，但用户要拿它去对照日志、
 * 转录文件名或工单时需要一字不差的全量值——「看得见」与「拿得走」是两件事，只做前者等于让人手抄。
 *
 * ⚠️ 结构约束：本组件渲染的是 `<button>`。HTML 禁止嵌套交互元素，所以它**绝不能**放进另一个 button
 * （例如列表里整行可点的会话行）内部——必须作为兄弟节点摆在同一个容器里。
 */
export function TruncatedIdentifierChipWithCopyOnClick({
	identifierLabel,
	identifierValue,
	className,
}: {
	// 这个标识符是什么（"Session"、"claude" 等）。渲染在芯片左侧，并进入 tooltip 与复制成功提示。
	identifierLabel: string;
	identifierValue: string;
	className?: string;
}): React.ReactElement {
	const [isCopied, setIsCopied] = useState(false);
	const copiedConfirmationResetTimerRef = useRef<number | null>(null);

	// 计时器必须随卸载清掉：会话列表会随 summary 推流频繁重排，留着就是往已卸载组件上 setState。
	useEffect(() => {
		return () => {
			if (copiedConfirmationResetTimerRef.current !== null) {
				clearTimeout(copiedConfirmationResetTimerRef.current);
			}
		};
	}, []);

	// 刻意直接用 navigator.clipboard 而不是 react-use 的 useCopyToClipboard：后者底层退回
	// `document.execCommand("copy")`，成败只经一个下一帧才可读的 state 汇报，于是**失败时对勾照样会亮**——
	// 用户以为拿到了值，粘出来的却是上一次剪贴板里的东西。这里的 await 让「打勾」与「报错」互斥。
	// 形态与 task-original-prompt-dialog.tsx 的复制按钮一致。
	const handleCopy = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(identifierValue);
		} catch {
			showAppToast(
				{
					intent: "warning",
					message: `Could not copy the ${identifierLabel} id. Hover it and copy the value manually.`,
					timeout: 4000,
				},
				"truncated-identifier-copy-failed",
			);
			return;
		}
		setIsCopied(true);
		if (copiedConfirmationResetTimerRef.current !== null) {
			clearTimeout(copiedConfirmationResetTimerRef.current);
		}
		copiedConfirmationResetTimerRef.current = window.setTimeout(() => {
			setIsCopied(false);
			copiedConfirmationResetTimerRef.current = null;
		}, COPIED_CONFIRMATION_VISIBLE_MS);
	};

	return (
		<Tooltip
			content={
				<span className="flex flex-col gap-0.5">
					<span className="font-mono break-all">{identifierValue}</span>
					<span className="text-text-tertiary">{isCopied ? "Copied" : "Click to copy"}</span>
				</span>
			}
		>
			<button
				type="button"
				onClick={() => {
					void handleCopy();
				}}
				aria-label={`Copy the ${identifierLabel} id ${identifierValue}`}
				className={cn(
					"inline-flex h-4 max-w-[136px] items-center gap-1 rounded-sm border border-border bg-surface-2 px-1.5",
					"font-mono text-[10px] font-medium text-text-tertiary hover:text-text-secondary",
					className,
				)}
			>
				<span className="shrink-0 opacity-70">{identifierLabel}</span>
				<span className="truncate">{identifierValue}</span>
				{isCopied ? <Check size={10} className="shrink-0 text-status-green" /> : null}
			</button>
		</Tooltip>
	);
}
