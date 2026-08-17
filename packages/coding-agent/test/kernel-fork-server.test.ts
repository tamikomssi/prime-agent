import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	disposeAllForkServers,
	ForkServerUnavailable,
	forkKernel,
	isForkServerEnabled,
} from "../src/core/kernel/fork-server.js";

const FORK_ENV = "PRIME_AGENT_KERNEL_FORKSERVER";

describe("fork-server gating", () => {
	afterEach(() => {
		delete process.env[FORK_ENV];
	});

	it("is on by default on linux, opt-out via the flag", () => {
		delete process.env[FORK_ENV];
		expect(isForkServerEnabled()).toBe(process.platform === "linux");
		process.env[FORK_ENV] = "0";
		expect(isForkServerEnabled()).toBe(false);
		process.env[FORK_ENV] = "1";
		expect(isForkServerEnabled()).toBe(process.platform === "linux");
	});

	it("keeps the process-lived template across a beforeExit idle boundary", async () => {
		if (process.platform !== "linux") return;

		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-forkserver-lifecycle-"));
		const fakePython = join(tempDir, "fake-python");
		writeFileSync(
			fakePython,
			String.raw`#!/usr/bin/env node
const { spawn } = require("node:child_process");
const net = require("node:net");
const socket = net.createConnection(process.argv.at(-1), () => {
	socket.write(JSON.stringify({ type: "ready" }) + "\n");
});
let buffer = "";
socket.on("data", (chunk) => {
	buffer += chunk.toString();
	for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
		const request = JSON.parse(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		socket.write(JSON.stringify({ id: request.id, pid: child.pid }) + "\n");
	}
});
`,
		);
		chmodSync(fakePython, 0o755);

		let kernelPid: number | undefined;
		try {
			kernelPid = await forkKernel(fakePython, { connectionPath: join(tempDir, "connection.json") });
			const templatePid = Number(/^PPid:\s+(\d+)$/m.exec(readFileSync(`/proc/${kernelPid}/status`, "utf8"))?.[1]);
			expect(templatePid).toBeGreaterThan(1);
			expect(() => process.kill(templatePid, 0)).not.toThrow();

			process.emit("beforeExit", 0);
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(() => process.kill(templatePid, 0)).not.toThrow();
			const parentAfterIdle = Number(
				/^PPid:\s+(\d+)$/m.exec(readFileSync(`/proc/${kernelPid}/status`, "utf8"))?.[1],
			);
			expect(parentAfterIdle).toBe(templatePid);
		} finally {
			disposeAllForkServers();
			if (kernelPid !== undefined) {
				try {
					process.kill(kernelPid, "SIGTERM");
				} catch {
					// Kernel already exited.
				}
			}
			rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("rejects with ForkServerUnavailable when opted out so callers fall back", async () => {
		process.env[FORK_ENV] = "0";
		await expect(forkKernel("python3", { connectionPath: "/tmp/nope/connection.json" })).rejects.toBeInstanceOf(
			ForkServerUnavailable,
		);
	});

	it("degrades to ForkServerUnavailable when the interpreter can't start", async () => {
		if (process.platform !== "linux") return;
		// The spawn errors immediately (ENOENT), so markDead fails the ready promise
		// fast rather than waiting out the ready timeout.
		await expect(
			forkKernel("/nonexistent/python-binary", { connectionPath: "/tmp/nope/connection.json" }),
		).rejects.toBeInstanceOf(ForkServerUnavailable);
	}, 15_000);

	it("falls back to direct spawn for any PYTHON* startup-env override", async () => {
		if (process.platform !== "linux") return;
		// The guard treats the whole PYTHON* family as startup-affecting, so even a var
		// not explicitly enumerated diverts to direct spawn (no var can be "missed").
		for (const key of ["PYTHONPATH", "PYTHONUSERBASE", "PYTHONDONTWRITEBYTECODE"]) {
			await expect(
				forkKernel("python3", {
					connectionPath: "/tmp/nope/connection.json",
					env: { [key]: "/some/custom/value" },
				}),
			).rejects.toBeInstanceOf(ForkServerUnavailable);
		}
	});
});
