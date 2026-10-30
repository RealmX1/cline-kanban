import { parseAdditionalAgentStartupArguments } from "@runtime-parse-additional-agent-startup-arguments";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

export function AgentSessionRestartWithAdditionalStartupArgumentsDialog({
	open,
	onOpenChange,
	isAgentSessionInActiveTurn,
	onRestartAgentSession,
	disabled = false,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	isAgentSessionInActiveTurn: boolean;
	onRestartAgentSession: (additionalAgentStartupArgumentsForThisRestart: string[]) => Promise<void>;
	disabled?: boolean;
}) {
	const inputId = useId();
	const descriptionId = useId();
	const errorId = useId();
	const [argumentText, setArgumentText] = useState("");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const submissionInProgressRef = useRef(false);
	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!submissionInProgressRef.current) onOpenChange(nextOpen);
			}}
			contentAriaDescribedBy={descriptionId}
		>
			<DialogHeader title="带参数重启 Codex" />
			<form
				className="flex min-h-0 flex-1 flex-col"
				onSubmit={async (event) => {
					event.preventDefault();
					if (submissionInProgressRef.current || disabled) return;
					setErrorMessage(null);
					try {
						const arguments_ = parseAdditionalAgentStartupArguments(argumentText);
						submissionInProgressRef.current = true;
						setIsSubmitting(true);
						await onRestartAgentSession(arguments_);
						onOpenChange(false);
					} catch (error) {
						setErrorMessage(error instanceof Error ? error.message : String(error));
					} finally {
						submissionInProgressRef.current = false;
						setIsSubmitting(false);
					}
				}}
			>
				<DialogBody className="space-y-3">
					<DialogDescription id={descriptionId} className="text-sm text-text-secondary">
						补传参数优先，仅用于本次重启及自动重试。留空则按当前设置重启。
					</DialogDescription>
					{isAgentSessionInActiveTurn ? (
						<p className="text-sm text-status-yellow">
							当前回合仍在运行，重启会终止进程；尚未保存的内容可能丢失。
						</p>
					) : null}
					<label htmlFor={inputId} className="block text-sm text-text-primary">
						额外启动参数
					</label>
					<textarea
						id={inputId}
						value={argumentText}
						onChange={(event) => setArgumentText(event.target.value)}
						disabled={isSubmitting || disabled}
						rows={4}
						spellCheck={false}
						aria-invalid={errorMessage !== null}
						aria-describedby={errorMessage ? errorId : undefined}
						placeholder={'--cd "/path with spaces" -c \'tui.resume_cwd="current"\''}
						className="w-full resize-y rounded-md border border-border-bright bg-surface-2 p-2 font-mono text-sm text-text-primary placeholder:text-text-secondary focus:outline-accent disabled:opacity-50"
					/>
					<p className="text-xs text-text-secondary">
						支持引号和反斜杠转义；不展开变量或执行 shell 命令。可显式指定原生会话与连接参数。
					</p>
					{errorMessage ? (
						<p id={errorId} role="alert" className="text-sm text-status-red">
							{errorMessage}
						</p>
					) : null}
				</DialogBody>
				<DialogFooter>
					<Button disabled={isSubmitting} onClick={() => onOpenChange(false)}>
						取消
					</Button>
					<Button
						type="submit"
						variant={isAgentSessionInActiveTurn ? "danger" : "primary"}
						disabled={isSubmitting || disabled}
						icon={isSubmitting ? <Spinner size={14} /> : undefined}
					>
						{isSubmitting ? "正在重启…" : "重启会话"}
					</Button>
				</DialogFooter>
			</form>
		</Dialog>
	);
}
