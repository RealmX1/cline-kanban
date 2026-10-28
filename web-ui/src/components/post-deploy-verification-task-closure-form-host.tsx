import { useEffect, useSyncExternalStore } from "react";
import { TaskCommentBeforeMoveIntoDoneDialog } from "@/components/task-comment-before-move-into-done-dialog";
import { useTaskCommentBeforeMoveIntoDone } from "@/hooks/use-task-comment-before-move-into-done";
import {
	readPostDeployVerificationTaskClosureFormRequest,
	registerPostDeployVerificationTaskClosureFormHost,
	settlePostDeployVerificationTaskClosureFormRequest,
	subscribeToPostDeployVerificationTaskClosureFormRequest,
} from "@/state/post-deploy-verification-task-closure-form-request";

export function PostDeployVerificationTaskClosureFormHost() {
	const request = useSyncExternalStore(
		subscribeToPostDeployVerificationTaskClosureFormRequest,
		readPostDeployVerificationTaskClosureFormRequest,
	);
	const controller = useTaskCommentBeforeMoveIntoDone();
	useEffect(registerPostDeployVerificationTaskClosureFormHost, []);
	useEffect(() => {
		if (request) controller.open(request.workspaceId, request.card);
	}, [request, controller.open]);
	return (
		<TaskCommentBeforeMoveIntoDoneDialog
			controller={{
				...controller,
				cancel: () => {
					controller.cancel();
					if (request) settlePostDeployVerificationTaskClosureFormRequest(request.requestId, null);
				},
			}}
			onSubmit={(comment, closure) => {
				if (!request || !closure) return;
				const prepared = controller.prepareSubmission(comment, closure);
				if (!prepared) return;
				controller.complete(request.card.id);
				settlePostDeployVerificationTaskClosureFormRequest(request.requestId, prepared);
			}}
		/>
	);
}
