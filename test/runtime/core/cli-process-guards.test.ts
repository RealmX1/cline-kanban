import { describe, expect, it } from "vitest";

import {
	installCliHardTimeoutIfNeeded,
	resolveCliHardTimeoutMs,
	safeErrorMessage,
	safeStringify,
} from "../../../src/core/cli-process-guards";

describe("cli-process-guards", () => {
	describe("timeout defaults", () => {
		it("keeps hard timeout above tRPC timeout with shutdown margin", () => {
			const previousHard = process.env.KANBAN_CLI_HARD_TIMEOUT_MS;
			const previousTrpc = process.env.KANBAN_CLI_TRPC_TIMEOUT_MS;
			delete process.env.KANBAN_CLI_HARD_TIMEOUT_MS;
			delete process.env.KANBAN_CLI_TRPC_TIMEOUT_MS;
			try {
				expect(resolveCliHardTimeoutMs()).toBeGreaterThan(28_000 + 500);
			} finally {
				if (previousHard === undefined) {
					delete process.env.KANBAN_CLI_HARD_TIMEOUT_MS;
				} else {
					process.env.KANBAN_CLI_HARD_TIMEOUT_MS = previousHard;
				}
				if (previousTrpc === undefined) {
					delete process.env.KANBAN_CLI_TRPC_TIMEOUT_MS;
				} else {
					process.env.KANBAN_CLI_TRPC_TIMEOUT_MS = previousTrpc;
				}
			}
		});
	});

	describe("installCliHardTimeoutIfNeeded", () => {
		it("returns a no-op cancel function for server-style invocations", () => {
			const cancel = installCliHardTimeoutIfNeeded([], true);
			expect(() => {
				cancel();
			}).not.toThrow();
		});
	});

	describe("safeErrorMessage", () => {
		it("returns message without reading stack", () => {
			const error = new Error("boom");
			error.stack = "should not be read";
			expect(safeErrorMessage(error)).toBe("boom");
		});

		it("stringifies non-error values", () => {
			expect(safeErrorMessage("plain")).toBe("plain");
			expect(safeErrorMessage(42)).toBe("42");
		});
	});

	describe("safeStringify", () => {
		it("serializes circular structures", () => {
			const payload: Record<string, unknown> = { ok: true };
			payload.self = payload;
			expect(safeStringify(payload, 2)).toContain("[Circular]");
		});

		it("returns a fallback object when serialization fails", () => {
			const payload = {
				toJSON() {
					throw new Error("nope");
				},
			};
			expect(safeStringify(payload)).toBe(JSON.stringify({ ok: false, error: "serialization failed" }));
		});
	});
});
