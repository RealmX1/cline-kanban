import { Draggable } from "@hello-pangea/dnd";
import { TaskCardBody, type TaskCardBusinessProps } from "@/components/task-card-body";

/**
 * 看板内的可拖任务卡：把卡体（`TaskCardBody`）包进 `@hello-pangea/dnd` 的 `<Draggable>`，
 * 并把 `provided`/`snapshot` 装配成注入式 `drag` 绑定下传。
 *
 * 所有展示/交互逻辑与「拖拽中 portal 到 body」都在 `TaskCardBody` 内；此处只做 DnD 适配。
 * 卡体因此与 `<Draggable>` 解耦，可被 Focus View 浮动钉住条以非拖拽克隆形式复用
 * （同一 `draggableId` 不会重复出现在 DnD 上下文里）。
 */
export function BoardCard({ index, ...businessProps }: TaskCardBusinessProps & { index: number }): React.ReactElement {
	return (
		<Draggable draggableId={businessProps.card.id} index={index} isDragDisabled={false}>
			{(provided, snapshot) => (
				<TaskCardBody
					{...businessProps}
					drag={{
						innerRef: provided.innerRef,
						draggableProps: provided.draggableProps,
						dragHandleProps: provided.dragHandleProps,
						isDragging: snapshot.isDragging,
						draggableStyle: provided.draggableProps.style,
					}}
				/>
			)}
		</Draggable>
	);
}
