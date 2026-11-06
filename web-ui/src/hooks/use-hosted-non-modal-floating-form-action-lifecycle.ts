import { useEffect, useRef } from "react";

/** 动作入口的独立 controller 只启动一次，业务确认关闭后释放所属宿主实例。 */
export function useHostedNonModalFloatingFormActionLifecycle({
	open,
	begin,
	hostedFormClose,
}: {
	open: boolean;
	begin: () => void | Promise<void>;
	hostedFormClose?: () => void;
}) {
	const initialized = useRef(false);
	const hasOpened = useRef(false);
	useEffect(() => {
		if (hostedFormClose && !initialized.current) {
			initialized.current = true;
			void begin();
		}
	}, [begin, hostedFormClose]);
	useEffect(() => {
		if (open) hasOpened.current = true;
		else if (hasOpened.current) hostedFormClose?.();
	}, [open, hostedFormClose]);
}
