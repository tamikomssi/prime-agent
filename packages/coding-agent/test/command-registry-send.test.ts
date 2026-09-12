import { describe, expect, it } from "vitest";
import { COMMAND_SPECS } from "../src/cli/command-registry.js";

// Regression guard for the "flag mismatch" friction: PR #631 ("make agent
// messages steer-only") removed --steer/--follow-up from the `send` command's
// usage line and parser (parseSendArgs in daemon-command.ts no longer
// recognizes either flag; unmatched --flags throw "Unknown option for send"),
// but left the per-flag `options` bullets advertising them untouched. Anyone
// following --help would hit a crash the docs never warned about. This test
// pins the two artifacts to each other so they cannot drift apart silently
// again.
describe("send command help text", () => {
	it("does not advertise --steer or --follow-up, which the parser no longer accepts", () => {
		const sendSpec = COMMAND_SPECS.find((spec) => spec.path.length === 1 && spec.path[0] === "send");
		expect(sendSpec).toBeDefined();
		const optionsText = (sendSpec?.options ?? []).join("\n");
		expect(optionsText).not.toContain("--steer");
		expect(optionsText).not.toContain("--follow-up");
	});

	it("only documents flags send's usage line still names", () => {
		const sendSpec = COMMAND_SPECS.find((spec) => spec.path.length === 1 && spec.path[0] === "send");
		expect(sendSpec?.usage).toBe("send [--from <agent>] <agent> <message>");
		expect(sendSpec?.options).toEqual(["--from <agent>  Identify the sending agent", "--json          Print JSON"]);
	});
});
