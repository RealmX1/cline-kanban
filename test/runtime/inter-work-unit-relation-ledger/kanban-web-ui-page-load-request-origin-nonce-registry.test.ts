import { describe, expect, it } from "vitest";

import {
	issueKanbanWebUiPageLoadRequestOriginNonce,
	verifyKanbanWebUiPageLoadRequestOriginNonceRequestHeaderValue,
} from "../../../src/inter-work-unit-relation-ledger/kanban-web-ui-page-load-request-origin-nonce-registry";

describe("kanban web ui page load request origin nonce registry", () => {
	it("verifies issued nonces, reports a missing header as absent and anything else as unknown", () => {
		const issuedNonce = issueKanbanWebUiPageLoadRequestOriginNonce();
		expect(verifyKanbanWebUiPageLoadRequestOriginNonceRequestHeaderValue(issuedNonce)).toBe("verified");
		expect(verifyKanbanWebUiPageLoadRequestOriginNonceRequestHeaderValue([issuedNonce])).toBe("verified");
		expect(verifyKanbanWebUiPageLoadRequestOriginNonceRequestHeaderValue(undefined)).toBe("absent");
		expect(verifyKanbanWebUiPageLoadRequestOriginNonceRequestHeaderValue("  ")).toBe("absent");
		expect(verifyKanbanWebUiPageLoadRequestOriginNonceRequestHeaderValue("nonce-from-a-previous-runtime")).toBe(
			"unknown",
		);
	});

	it("evicts the oldest nonces beyond the retained limit so a long-running runtime does not grow without bound", () => {
		const firstNonce = issueKanbanWebUiPageLoadRequestOriginNonce();
		for (let index = 0; index < 10_000; index += 1) {
			issueKanbanWebUiPageLoadRequestOriginNonce();
		}
		expect(verifyKanbanWebUiPageLoadRequestOriginNonceRequestHeaderValue(firstNonce)).toBe("unknown");
	});
});
