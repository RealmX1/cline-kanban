import { createContext, type Dispatch, type SetStateAction, useContext, useLayoutEffect, useState } from "react";

// 由面板实例持有；正文卸载时只保留展开状态，不保留真实卡体及其订阅。
export const PostDeployVerificationPanelExpansionStateContext = createContext<Map<string, unknown> | null>(null);

export function usePostDeployVerificationPanelRememberedExpansionState<ExpansionState>(
	expansionStateKey: string | undefined,
	initialExpansionState: () => ExpansionState,
): [ExpansionState, Dispatch<SetStateAction<ExpansionState>>] {
	const rememberedExpansionStateByKey = useContext(PostDeployVerificationPanelExpansionStateContext);
	const [expansionState, setExpansionState] = useState<ExpansionState>(() => {
		if (expansionStateKey && rememberedExpansionStateByKey?.has(expansionStateKey)) {
			return rememberedExpansionStateByKey.get(expansionStateKey) as ExpansionState;
		}
		return initialExpansionState();
	});
	useLayoutEffect(() => {
		if (expansionStateKey) rememberedExpansionStateByKey?.set(expansionStateKey, expansionState);
	}, [rememberedExpansionStateByKey, expansionStateKey, expansionState]);
	return [expansionState, setExpansionState];
}
