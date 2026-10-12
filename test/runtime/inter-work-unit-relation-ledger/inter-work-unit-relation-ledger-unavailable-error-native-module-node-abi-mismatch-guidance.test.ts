import { describe, expect, it } from "vitest";

import { InterWorkUnitRelationLedgerUnavailableError } from "../../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";

describe("InterWorkUnitRelationLedgerUnavailableError native module Node ABI mismatch guidance", () => {
	it("tells the developer to start Kanban with the Node version that installed node_modules when better-sqlite3 has another ABI", () => {
		const error = new InterWorkUnitRelationLedgerUnavailableError(
			"The module 'better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 127.",
		);

		expect(error.message).toContain("keeps the board read-only");
		expect(error.message).toContain(`this runtime runs on Node ${process.version}`);
		expect(error.message).toContain("Do not run `npm rebuild` from a task worktree");
		// 原始原因原样保留，供调用方按字段读取。
		expect(error.ledgerUnavailableReason).not.toContain("npm rebuild");
	});

	it("leaves other unavailability reasons unchanged", () => {
		const error = new InterWorkUnitRelationLedgerUnavailableError("the ledger worker exited");

		expect(error.message).toBe(
			"Inter-work-unit relation ledger is unavailable, so this Kanban runtime keeps the board read-only: the ledger worker exited",
		);
	});
});
