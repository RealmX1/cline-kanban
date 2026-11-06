import { type ComponentType, createElement, type ReactElement, useEffect, useRef } from "react";
import {
	type NonModalFloatingFormOwnershipSnapshot,
	useNonModalFloatingFormWindowHost,
} from "@/components/non-modal-floating-form-window-host-provider";

interface HostedNonModalFloatingFormConfiguration<Props> {
	formKind: string;
	openingRequestIdentity?: (props: Props) => unknown;
	revealDetail?: (props: Props) => unknown;
	isOpen: (props: Props) => boolean;
	instanceIdentity: (props: Props) => string;
	ownership: (props: Props) => NonModalFloatingFormOwnershipSnapshot;
	withClose: (props: Props, close: () => void) => Props;
	onClosed?: (props: Props) => void;
}

/** 将有业务状态的整个表单交给常驻宿主，入口仅登记请求，不持有草稿。 */
export function hostNonModalFloatingForm<Props extends object>(
	Form: ComponentType<Props>,
	configuration: HostedNonModalFloatingFormConfiguration<Props>,
) {
	return function HostedNonModalFloatingFormEntry(props: Props): ReactElement | null {
		const host = useNonModalFloatingFormWindowHost();
		const source = useRef({ props, mounted: true });
		source.current.props = props;
		const open = configuration.isOpen(props);
		const identity = configuration.instanceIdentity(props);
		const opened = useRef<{ identity: string; instanceId: symbol } | null>(null);
		const previouslyOpen = useRef(false);
		const previousOpeningRequest = useRef<unknown>();
		const openingRequest = configuration.openingRequestIdentity?.(props);
		useEffect(() => {
			source.current.mounted = true;
			return () => {
				source.current.mounted = false;
			};
		}, []);
		useEffect(() => {
			if (!host) return;
			const render = (session: { close: () => void }) =>
				createElement(Form, configuration.withClose(props, session.close));
			// 背景身份漂移不是一次新的打开。只有打开沿或显式请求序号才会登记窗口，避免把旧草稿留在身后又抢一扇新窗。
			if (open && (!previouslyOpen.current || previousOpeningRequest.current !== openingRequest)) {
				const instanceId = host.openWindow({
					formKind: configuration.formKind,
					instanceIdentity: identity,
					ownership: configuration.ownership(props),
					revealDetail: configuration.revealDetail?.(props),
					render,
					onClosed: () => {
						if (source.current.mounted && opened.current?.instanceId === instanceId)
							configuration.onClosed?.(source.current.props);
					},
				});
				opened.current = { identity, instanceId };
			}
			previouslyOpen.current = open;
			previousOpeningRequest.current = openingRequest;
		}, [host, props, identity, open, openingRequest]);
		return host ? null : createElement(Form, props);
	};
}
