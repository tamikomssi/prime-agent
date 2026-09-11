import { DAEMON_CLIENT_ENV_KEYS } from "./daemon-protocol.js";

/** Re-filter client-sent env to the allowlist; the socket peer is untrusted. */
export function filterClientEnv(env?: Record<string, string>): Record<string, string> | undefined {
	if (!env) {
		return undefined;
	}
	const filtered: Record<string, string> = {};
	for (const key of DAEMON_CLIENT_ENV_KEYS) {
		if (Object.hasOwn(env, key) && typeof env[key] === "string") {
			filtered[key] = env[key];
		}
	}
	return Object.keys(filtered).length > 0 ? filtered : undefined;
}

// The daemon's own allowlisted env, captured at startup before any env window
// can mutate process.env.
const baseClientEnv: Record<string, string | undefined> = {};
for (const key of DAEMON_CLIENT_ENV_KEYS) {
	baseClientEnv[key] = key === "PI_SLACK_CONSENT_MODE" ? undefined : process.env[key];
}

/**
 * Exec env for a session's subprocesses: pins every allowlisted key to the
 * session's value (unset when the client didn't send it), or to the daemon's
 * startup value for env-less sessions. Pinning makes subprocess env
 * independent of any env window another session has open at spawn time.
 */
export function execEnvForSession(clientEnv?: Record<string, string>): Record<string, string | undefined> {
	const source = clientEnv ?? baseClientEnv;
	const env: Record<string, string | undefined> = {};
	for (const key of DAEMON_CLIENT_ENV_KEYS) {
		env[key] = source[key];
	}
	return env;
}

// Every extension-load window is exclusive. An env-less caller must also pin
// consent absent: process.env at admission may be a peer's temporary window.
let lastExclusive: Promise<unknown> = Promise.resolve();

/**
 * Run fn with the client's env applied to process.env, restoring afterwards.
 * Extensions capture vars like HERDR_PANE_ID synchronously at module load, so
 * they must be in process.env while the session loads its extensions; after
 * this window the session's exec env covers subprocess reads.
 */
export async function withClientEnv<T>(env: Record<string, string> | undefined, fn: () => Promise<T>): Promise<T> {
	const sessionEnv = env ?? baseClientEnv;
	const prior = lastExclusive;
	const run = (async () => {
		await prior.catch(() => undefined);
		const previous = new Map<string, string | undefined>();
		// Pin the full allowlist (unsetting keys the client didn't send) so a
		// partially-forwarded env can't mix with the daemon's ambient values —
		// mirroring execEnvForSession.
		for (const key of DAEMON_CLIENT_ENV_KEYS) {
			previous.set(key, process.env[key]);
			const value = sessionEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		try {
			return await fn();
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	})();
	lastExclusive = run.catch(() => undefined);
	return run;
}
