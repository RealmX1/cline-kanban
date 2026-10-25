import { createContext, useContext } from "react";
import type { RuntimePostDeployVerificationEntryNavigationTarget } from "@/runtime/types";

export interface PostDeployVerificationEntryNavigationRequest {
	requestId: number;
	target: RuntimePostDeployVerificationEntryNavigationTarget;
}

interface PostDeployVerificationEntryNavigationHost {
	workspaceIdOwningHydratedBoard: string | null;
	beginNavigationIntent: () => AbortSignal;
	navigateToEntry: (target: RuntimePostDeployVerificationEntryNavigationTarget, navigationIntent: AbortSignal) => void;
}
const PostDeployVerificationEntryNavigationHostContext =
	createContext<PostDeployVerificationEntryNavigationHost | null>(null);
export const PostDeployVerificationEntryNavigationHostProvider =
	PostDeployVerificationEntryNavigationHostContext.Provider;
export function usePostDeployVerificationEntryNavigationHost() {
	return useContext(PostDeployVerificationEntryNavigationHostContext);
}
