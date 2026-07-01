import { describe, expect, it } from "vitest";

import { agentRendersTranscriptInline } from "../../../src/core/agent-catalog";
import {
	createTerminalProtocolFilterState,
	filterTerminalProtocolOutput,
} from "../../../src/terminal/terminal-protocol-filter";
import { TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";

// Regression for "Codex agent: submitting/resizing replays and STACKS the whole transcript".
//
// Codex runs inline (--no-alt-screen) and, on every resize (SIGWINCH), emits
//   ESC[r ESC[0m ESC[H ESC[2J ESC[3J ESC[H <full reprint>
// — a full clear (screen + scrollback) followed by reprinting its entire transcript. This was
// verified by capturing the real byte stream of codex-cli 0.142.5 in a PTY.
//
// If the terminal protocol filter suppresses ESC[3J, the old scrollback is never cleared, so the
// reprint stacks a DUPLICATE under the old history, and the server mirror grows without bound (every
// restore then replays a bloated, duplicated history). agentRendersTranscriptInline gates suppression
// OFF for Codex, which is what lets the reprint cleanly REPLACE — the same way a normal terminal (the
// one Codex is designed for) behaves.

const esc = String.fromCharCode(0x1b);

// Codex's real resize repaint: reset scroll region + attrs, home, erase screen, erase scrollback, reprint.
function codexResizeRepaint(transcript: string): string {
	return `${esc}[r${esc}[0m${esc}[H${esc}[2J${esc}[3J${esc}[H${transcript}`;
}

async function firstLineOccurrencesInMirror(
	agentId: "codex" | "claude",
	initial: string,
	repaint: string,
): Promise<number> {
	// Build the filter exactly as session-manager does for a task agent session.
	const filter = createTerminalProtocolFilterState({
		interceptOscColorQueries: true,
		suppressScrollbackErasure: !agentRendersTranscriptInline(agentId),
	});
	const mirror = new TerminalStateMirror(80, 6);
	try {
		mirror.applyOutput(filterTerminalProtocolOutput(filter, Buffer.from(initial, "utf8")));
		mirror.applyOutput(filterTerminalProtocolOutput(filter, Buffer.from(repaint, "utf8")));
		const { snapshot } = await mirror.getSnapshot();
		return snapshot.split("turn-line-001").length - 1;
	} finally {
		mirror.dispose();
	}
}

describe("Codex inline scrollback erasure (submit/resize replay regression)", () => {
	// A transcript tall enough that its first lines scroll off the 6-row viewport into scrollback.
	const tallTranscript = Array.from(
		{ length: 40 },
		(_, index) => `turn-line-${String(index + 1).padStart(3, "0")}`,
	).join("\r\n");
	const repaint = codexResizeRepaint(`${tallTranscript}\r\ncomposer`);

	it("keeps the Codex mirror bounded — the resize reprint REPLACES, it does not stack a duplicate", async () => {
		const occurrences = await firstLineOccurrencesInMirror("codex", tallTranscript, repaint);
		expect(occurrences).toBe(1);
	});

	it("shows the pre-fix bug: with ESC[3J suppressed (alt-screen config) the reprint stacks a duplicate", async () => {
		const occurrences = await firstLineOccurrencesInMirror("claude", tallTranscript, repaint);
		expect(occurrences).toBeGreaterThanOrEqual(2);
	});
});
