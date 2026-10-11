import {
	KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_REQUEST_HEADER_NAME,
	KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_UNKNOWN_REACQUIRE_AND_RETRY_ERROR_MESSAGE,
} from "@runtime-kanban-web-ui-page-load-request-origin-nonce";
import { TRPCClientError } from "@trpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntime,
	readKanbanWebUiPageLoadRequestOriginNonceForOutgoingRuntimeRequests,
	resetKanbanWebUiPageLoadRequestOriginNonceStoreForTests,
} from "@/runtime/kanban-web-ui-page-load-request-origin-nonce-store";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

// 一个假的 runtime：签发 nonce 的 procedure 永远成功（可按需让它失败），其它 procedure 只认「当前有效」的 nonce——
// 带了别的 nonce 就以 PRECONDITION_FAILED + 固定消息拒绝（等价于 runtime 重启后旧 nonce 全部失效）。
interface FakeRuntimeObservedRequest {
	procedurePath: string;
	headers: Record<string, string>;
}

const ISSUE_NONCE_PROCEDURE_PATH = "runtime.issueKanbanWebUiPageLoadRequestOriginNonce";

function createFakeRuntimeEnforcingPageLoadNonce() {
	const observedRequests: FakeRuntimeObservedRequest[] = [];
	const state = {
		nonceAcceptedByRuntime: null as string | null,
		issuedNonceSequence: 0,
		issueNonceRequestShouldFail: false,
		rejectEveryNonGatedRequestWithUnknownNonce: false,
	};

	function jsonResponse(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}

	const unknownNonceErrorEnvelope = {
		error: {
			message: KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_UNKNOWN_REACQUIRE_AND_RETRY_ERROR_MESSAGE,
			code: -32012,
			data: { code: "PRECONDITION_FAILED", httpStatus: 412, conflictRevision: null },
		},
	};

	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input), "http://kanban.test");
		const procedurePaths = url.pathname.replace(/^\/api\/trpc\//u, "").split(",");
		const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
		for (const procedurePath of procedurePaths) {
			observedRequests.push({ procedurePath, headers });
		}
		const isBatch = url.searchParams.get("batch") === "1";
		const envelopes = procedurePaths.map((procedurePath) => {
			if (procedurePath === ISSUE_NONCE_PROCEDURE_PATH) {
				if (state.issueNonceRequestShouldFail) {
					return {
						error: {
							message: "runtime unavailable",
							code: -32603,
							data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, conflictRevision: null },
						},
					};
				}
				state.issuedNonceSequence += 1;
				state.nonceAcceptedByRuntime = `nonce-${state.issuedNonceSequence}`;
				return { result: { data: { kanbanWebUiPageLoadIssuedRequestOriginNonce: state.nonceAcceptedByRuntime } } };
			}
			const sentNonce = headers[KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_REQUEST_HEADER_NAME];
			if (
				state.rejectEveryNonGatedRequestWithUnknownNonce ||
				(sentNonce !== undefined && sentNonce !== state.nonceAcceptedByRuntime)
			) {
				return unknownNonceErrorEnvelope;
			}
			return { result: { data: { procedurePath } } };
		});
		const firstEnvelope = envelopes[0];
		const status = envelopes.some((envelope) => "error" in envelope)
			? isBatch
				? 207
				: firstEnvelope && "error" in firstEnvelope
					? firstEnvelope.error.data.httpStatus
					: 200
			: 200;
		return jsonResponse(isBatch ? envelopes : firstEnvelope, status);
	});

	return { observedRequests, state, fetchMock };
}

function requestsTo(
	observedRequests: FakeRuntimeObservedRequest[],
	procedurePath: string,
): FakeRuntimeObservedRequest[] {
	return observedRequests.filter((request) => request.procedurePath === procedurePath);
}

describe("runtime tRPC client page-load nonce", () => {
	let fakeRuntime: ReturnType<typeof createFakeRuntimeEnforcingPageLoadNonce>;

	beforeEach(() => {
		resetKanbanWebUiPageLoadRequestOriginNonceStoreForTests();
		fakeRuntime = createFakeRuntimeEnforcingPageLoadNonce();
		vi.stubGlobal("fetch", fakeRuntime.fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		resetKanbanWebUiPageLoadRequestOriginNonceStoreForTests();
	});

	it("sends requests without the nonce header before any nonce has been issued", async () => {
		await getRuntimeTrpcClient("workspace-before-nonce").runtime.getConfig.query();

		const [request] = requestsTo(fakeRuntime.observedRequests, "runtime.getConfig");
		expect(request?.headers["x-kanban-workspace-id"]).toBe("workspace-before-nonce");
		expect(request?.headers).not.toHaveProperty(KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_REQUEST_HEADER_NAME);
	});

	it("injects the current nonce into every runtime request once it has been issued", async () => {
		await reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntime();
		await getRuntimeTrpcClient("workspace-with-nonce").workspace.getState.query();
		await getRuntimeTrpcClient(null).runtime.getConfig.query();

		for (const procedurePath of ["workspace.getState", "runtime.getConfig"]) {
			const [request] = requestsTo(fakeRuntime.observedRequests, procedurePath);
			expect(request?.headers[KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_REQUEST_HEADER_NAME]).toBe("nonce-1");
		}
		// 签发请求本身走专用 client，不带 nonce 头。
		const [issueRequest] = requestsTo(fakeRuntime.observedRequests, ISSUE_NONCE_PROCEDURE_PATH);
		expect(issueRequest?.headers).not.toHaveProperty(
			KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_REQUEST_HEADER_NAME,
		);
	});

	it("reacquires the nonce and resends exactly once when the runtime no longer knows the nonce", async () => {
		await reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntime();
		// runtime 重启：旧 nonce 不再被认。
		fakeRuntime.state.nonceAcceptedByRuntime = "nonce-issued-by-a-previous-runtime-incarnation";

		const result = await getRuntimeTrpcClient("workspace-restarted-runtime").workspace.getState.query();

		expect(result).toEqual({ procedurePath: "workspace.getState" });
		const getStateRequests = requestsTo(fakeRuntime.observedRequests, "workspace.getState");
		expect(
			getStateRequests.map(
				(request) => request.headers[KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_REQUEST_HEADER_NAME],
			),
		).toEqual(["nonce-1", "nonce-2"]);
		expect(requestsTo(fakeRuntime.observedRequests, ISSUE_NONCE_PROCEDURE_PATH)).toHaveLength(2);
		expect(readKanbanWebUiPageLoadRequestOriginNonceForOutgoingRuntimeRequests()).toBe("nonce-2");
	});

	it("retries only once: a second unknown-nonce rejection reaches the caller instead of looping", async () => {
		await reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntime();
		fakeRuntime.state.rejectEveryNonGatedRequestWithUnknownNonce = true;

		const caught = await getRuntimeTrpcClient("workspace-always-rejected")
			.workspace.getState.query()
			.catch((error: unknown) => error);

		expect(caught).toBeInstanceOf(TRPCClientError);
		expect((caught as TRPCClientError<never>).message).toBe(
			KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_UNKNOWN_REACQUIRE_AND_RETRY_ERROR_MESSAGE,
		);
		expect(requestsTo(fakeRuntime.observedRequests, "workspace.getState")).toHaveLength(2);
		expect(requestsTo(fakeRuntime.observedRequests, ISSUE_NONCE_PROCEDURE_PATH)).toHaveLength(2);
	});

	it("surfaces the original rejection when reacquiring the nonce itself fails, without resending", async () => {
		await reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntime();
		fakeRuntime.state.nonceAcceptedByRuntime = "nonce-issued-by-a-previous-runtime-incarnation";
		fakeRuntime.state.issueNonceRequestShouldFail = true;

		const caught = await getRuntimeTrpcClient("workspace-issue-fails")
			.workspace.getState.query()
			.catch((error: unknown) => error);

		expect((caught as TRPCClientError<never>).message).toBe(
			KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_UNKNOWN_REACQUIRE_AND_RETRY_ERROR_MESSAGE,
		);
		expect(requestsTo(fakeRuntime.observedRequests, "workspace.getState")).toHaveLength(1);
	});

	it("does not reacquire for unrelated failures", async () => {
		await reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntime();
		fakeRuntime.fetchMock.mockImplementationOnce(
			async () =>
				new Response(
					JSON.stringify([
						{
							error: {
								message: "Workspace state revision conflict.",
								code: -32009,
								data: { code: "CONFLICT", httpStatus: 409, conflictRevision: 7 },
							},
						},
					]),
					{ status: 409, headers: { "content-type": "application/json" } },
				),
		);

		await expect(getRuntimeTrpcClient("workspace-conflict").workspace.getState.query()).rejects.toThrow(
			"Workspace state revision conflict.",
		);
		expect(requestsTo(fakeRuntime.observedRequests, ISSUE_NONCE_PROCEDURE_PATH)).toHaveLength(1);
	});

	it("shares one reacquisition between concurrent rejected requests", async () => {
		await reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntime();
		fakeRuntime.state.nonceAcceptedByRuntime = "nonce-issued-by-a-previous-runtime-incarnation";

		await Promise.all([
			getRuntimeTrpcClient("workspace-concurrent").workspace.getState.query(),
			getRuntimeTrpcClient("workspace-concurrent").runtime.getConfig.query(),
		]);

		expect(requestsTo(fakeRuntime.observedRequests, ISSUE_NONCE_PROCEDURE_PATH)).toHaveLength(2);
		expect(readKanbanWebUiPageLoadRequestOriginNonceForOutgoingRuntimeRequests()).toBe("nonce-2");
	});
});
