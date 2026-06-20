// Shared normalization for scanning decoded terminal output (ANSI-stripped).
//
// Terminal agents redraw status lines in place using carriage returns and ANSI
// escape sequences, so a naive `stripAnsi` leaves `\r`-spliced fragments that
// defeat substring/regex matching. `stripAnsiAndControl` removes ANSI CSI/OSC
// sequences and non-printable control bytes (keeping `\n` / `\r` / `\t`), and
// `normalizeTerminalText` then lowercases and collapses all whitespace (including
// the redraw `\r`s) into single spaces so pattern matchers see a stable line.
//
// Used by workspace-trust detection, the output-reactions framework's
// connection-error matching, and any other decoded-output scanner.

const ESCAPE = "";
const BELL = "";

export function stripAnsiAndControl(input: string): string {
	let output = "";
	let mode: "text" | "escape" | "csi" | "osc" | "osc_escape" = "text";
	for (const char of input) {
		if (mode === "text") {
			if (char === ESCAPE) {
				mode = "escape";
				continue;
			}
			const code = char.charCodeAt(0);
			if ((code >= 32 && code !== 127) || char === "\n" || char === "\r" || char === "\t") {
				output += char;
			}
			continue;
		}
		if (mode === "escape") {
			if (char === "[") {
				mode = "csi";
				continue;
			}
			if (char === "]") {
				mode = "osc";
				continue;
			}
			mode = "text";
			continue;
		}
		if (mode === "csi") {
			const code = char.charCodeAt(0);
			if (code >= 64 && code <= 126) {
				mode = "text";
			}
			continue;
		}
		if (mode === "osc") {
			if (char === BELL) {
				mode = "text";
			} else if (char === ESCAPE) {
				mode = "osc_escape";
			}
			continue;
		}
		if (mode === "osc_escape") {
			mode = char === "\\" ? "text" : "osc";
		}
	}
	return output;
}

export function normalizeTerminalText(input: string): string {
	return input.toLowerCase().replace(/\s+/gu, " ");
}

// Convenience: strip + lowercase + collapse whitespace in one call.
export function normalizeDecodedTerminalOutput(input: string): string {
	return normalizeTerminalText(stripAnsiAndControl(input));
}
