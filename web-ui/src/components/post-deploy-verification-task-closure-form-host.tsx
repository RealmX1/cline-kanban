import { useEffect, useSyncExternalStore } from "react";
import { TaskCommentBeforeMoveIntoDoneDialog } from "@/components/task-comment-before-move-into-done-dialog";
import { useTaskCommentBeforeMoveIntoDone } from "@/hooks/use-task-comment-before-move-into-done";
import {
	readPostDeployVerificationTaskClosureFormRequests,
	registerPostDeployVerificationTaskClosureFormHost,
	settlePostDeployVerificationTaskClosureFormRequest,
	subscribeToPostDeployVerificationTaskClosureFormRequest,
} from "@/state/post-deploy-verification-task-closure-form-request";

export function PostDeployVerificationTaskClosureFormHost() {
	const requests = useSyncExternalStore(
		subscribeToPostDeployVerificationTaskClosureFormRequest,
		readPostDeployVerificationTaskClosureFormRequests,
	);
	useEffect(registerPostDeployVerificationTaskClosureFormHost, []);
	return (
		<>
			{requests.map((request) => (
				<PostDeployVerificationTaskClosureRequestForm key={request.requestId} request={request} />
			))}
		</>
	);
}

function PostDeployVerificationTaskClosureRequestForm({
	request,
}: {
	request: ReturnType<typeof readPostDeployVerificationTaskClosureFormRequests>[number];
}) {
	const controller = useTaskCommentBeforeMoveIntoDone();
	useEffect(() => {
		if (request) controller.open(request.workspaceId, request.card);
	}, [request, controller.open]);
	return (
		<TaskCommentBeforeMoveIntoDoneDialog
			prepareClosurePayloadOnly
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
