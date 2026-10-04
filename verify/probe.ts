/**
 * The probe: a `fetch` wrapper that captures the exact request and response
 * octets, verifies the Proof-of-Observation statement, and reports the verdict.
 *
 * Why a fetch wrapper rather than a hook: `onResponse` only yields
 * `{status, headers}`, and `provider_stream_event` explicitly says its data is
 * "not necessarily the original HTTP bytes or SSE frame". Neither can see the
 * bytes the Ed25519 statement actually commits to. Owning the fetch is the only
 * way to get byte-exact access, and `FetchFunction` is injectable through
 * `StreamOptions`, so pi's own OpenAI adapter still does all the stream parsing.
 *
 * Streaming is preserved: the body is `tee()`d, one branch feeds the verifier,
 * the other feeds the model adapter with the trailing proof event stripped out
 * (the same thing the upstream project's own tee-verify-proxy does, so pi never
 * sees an SSE event it does not know).
 *
 * Design note — we verify the bytes the *client* received, not the raw wire
 * bytes. If a relay injected a fake mid-stream `event: tee.proof` to truncate
 * output, the truncated prefix would fail the response hash and surface as a
 * verification failure rather than passing quietly.
 */

import { Buffer } from "node:buffer";
import {
	parseTeeProofEvent,
	verifyTeeExchange,
	TEE_PROOF_EVENT,
	type AttestationVerifier,
	type TeeCheck,
	type TeeProofWire,
} from "./tee-verify-core.ts";
import type { WokeyRoute } from "../routes.ts";

export type ProofStatus = "verified" | "verified-with-gaps" | "unproven" | "failed";

export interface ProofVerdict {
	/** `verified-with-gaps` = every achievable check passed, but N are structurally unavailable. */
	status: ProofStatus;
	checks: TeeCheck[];
	upstreamHost?: string;
	upstreamPath?: string;
	pcr0?: string;
	/** Model string the upstream reported in its own (integrity-bound) response body. */
	reportedModel?: string;
	bytes: number;
}

export interface ProofReport extends ProofVerdict {
	finishedAt: number;
	durationMs: number;
	reason?: string;
}

export interface ProbeDeps {
	/** Route trust policy this fetch verifies against. */
	policy: VerificationPolicy;
	onReport(report: ProofReport): void;
	/** Model id requested for this call, so the served model can be compared. */
	expectedModel?: string;
	/** Served-model reader for this route, over the integrity-bound response bytes. */
	extractServedModel: WokeyRoute["extractServedModel"];
	/** Test seam: swap the hardware-attestation verifier for a stub. */
	attestationVerifier?: AttestationVerifier;
}

const PROOF_EVENT_LF = Buffer.from("event: tee.proof\n", "utf8");
const PROOF_EVENT_CRLF = Buffer.from("event: tee.proof\r\n", "utf8");
/** Held-back tail so a marker straddling a chunk boundary is still detected. */
const MARKER_WINDOW = 64;

// ── request byte capture ───────────────────────────────────────────────────────

/**
 * Capture the request-body octets without mutating the caller's `init`. Returns
 * the (possibly rebuilt) init the real fetch must use: when the body is a
 * ReadableStream it is teed, and the passthrough branch goes into a fresh init.
 * A request with no body returns `requestBytes: undefined` — "no opinion" — so
 * the verifier does not claim a request-binding check it cannot make.
 */
async function captureRequestBytes(
	input: FetchArg,
	init?: FetchInit,
): Promise<{ requestBytes: Buffer | undefined; init: FetchInit | undefined }> {
	const body = init && "body" in init ? init.body : undefined;
	if (body === undefined || body === null) {
		// A Request object may carry the body itself.
		if (input instanceof Request) {
			const buf = await input.clone().arrayBuffer().catch(() => undefined);
			return { requestBytes: buf && buf.byteLength > 0 ? Buffer.from(buf) : undefined, init };
		}
		return { requestBytes: undefined, init };
	}
	if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
		const [capture, passthrough] = body.tee();
		// Hand the passthrough branch to the real fetch via a new init, leaving the
		// caller's object untouched.
		return { requestBytes: await drain(capture), init: init ? { ...init, body: passthrough } : init };
	}
	return { requestBytes: bodyBytes(body), init };
}

/** Byte-exact view of a non-streaming request body, or undefined if unrecognised. */
function bodyBytes(body: unknown): Buffer | undefined {
	if (typeof body === "string") return Buffer.from(body, "utf8");
	if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
	if (Buffer.isBuffer(body)) return Buffer.from(body);
	if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
	if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	return undefined;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
	const chunks: Buffer[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks);
}

/**
 * Normalize the bytes the client actually received exactly as the vendored
 * verifier normalizes the wire body: strip hash-gated relay transport
 * keepalives. Skipping this makes every stream that carries a keepalive hash
 * differently from the signature — a false failure. Returns the number of
 * stripped keepalives so the report can say which branch applied.
 */
function normalizeDeliveredBody(clientBytes: Buffer, proof: TeeProofWire): { body: Buffer; strippedKeepalives: number } {
	// The delivered bytes are SSE (the only transport this provider negotiates),
	// with the proof record already stripped. Re-attach the proof we parsed so the
	// vendored parser locates the genuine trailing record; a forged marker already
	// inside clientBytes stays in the hashed prefix and fails the run.
	const reattached = Buffer.concat([
		clientBytes,
		Buffer.from(`event: ${TEE_PROOF_EVENT}\ndata: ${JSON.stringify(proof)}\n\n`, "utf8"),
	]);
	const reparsed = parseTeeProofEvent(reattached);
	return { body: reparsed.body, strippedKeepalives: reparsed.ignoredTransportKeepaliveCount ?? 0 };
}

// ── trailing proof-event stripper ──────────────────────────────────────────────

/**
 * Pass bytes through until the trailing `event: tee.proof` record, then stop.
 * The record is always last by protocol, so nothing legitimate is dropped; and
 * because the stripped prefix is what we verify, a forged mid-stream marker
 * shows up as a hash mismatch rather than a silent truncation.
 */
export function stripTrailingProofEvent(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	let pending = Buffer.alloc(0);
	let finished = false;

	return new ReadableStream<Uint8Array>({
		// A pull() that enqueues nothing is never re-invoked, so keep reading
		// until we have something to emit or the source is done. Without this
		// loop, a chunk smaller than the marker window stalls the stream forever.
		async pull(controller) {
			if (finished) return;
			for (;;) {
				const { value, done } = await reader.read();
				if (done) {
					if (pending.length > 0) controller.enqueue(new Uint8Array(pending));
					finished = true;
					controller.close();
					return;
				}
				if (value) pending = Buffer.concat([pending, Buffer.from(value)]);

				const idx = Math.max(pending.lastIndexOf(PROOF_EVENT_LF), pending.lastIndexOf(PROOF_EVENT_CRLF));
				if (idx >= 0) {
					if (idx > 0) controller.enqueue(new Uint8Array(pending.subarray(0, idx)));
					finished = true;
					controller.close();
					return;
				}
				if (pending.length > MARKER_WINDOW) {
					const emit = pending.length - MARKER_WINDOW;
					controller.enqueue(new Uint8Array(pending.subarray(0, emit)));
					pending = Buffer.from(pending.subarray(emit));
					return;
				}
			}
		},
		cancel(reason) {
			finished = true;
			return reader.cancel(reason);
		},
	});
}

// ── verification ───────────────────────────────────────────────────────────────

/**
 * Trust policy for one verification: the pinned PCR0 anchor plus the route's
 * exact signed `(host, path, method)` tuple and its request-binding achievability.
 * Everything route-specific lives here — never in user settings.
 */
export interface VerificationPolicy {
	expectedPcr0: string;
	endpoint: WokeyRoute["endpoint"];
	requestBinding: WokeyRoute["requestBinding"];
}

export interface VerifyInput {
	/** Raw wire bytes, including any trailing tee.proof record. The proof is read from here. */
	wireBytes: Buffer;
	/**
	 * Bytes actually delivered to the caller (proof already stripped). This is what
	 * gets hashed against the signed digest. Defaults to the signed upstream body.
	 */
	clientBytes?: Buffer;
	/** Bytes we sent, if we managed to capture them. */
	requestBytes?: Buffer;
	/** Model id we asked for, so the served model can be checked against it. */
	expectedModel?: string;
	/**
	 * Served-model reader for this route, over the integrity-bound response bytes.
	 * The input carries no protocol assumption: Responses events, Anthropic
	 * `message_start`, or whatever a future route pins. Unknown identity
	 * (`undefined`) never counts as a match.
	 */
	extractServedModel: WokeyRoute["extractServedModel"];
	/** Test seam: swap the hardware-attestation verifier for a stub. */
	attestationVerifier?: AttestationVerifier;
}

/** Map the vendored verifier's check names/reasons to concise English. */
function renameCheck(c: TeeCheck): TeeCheck {
	switch (c.name) {
		case "远程证明":
			return { ...c, name: "Remote attestation", detail: c.ok ? "COSE/P-384 chains to the AWS Nitro root" : shortReason(c.detail) };
		case "证书有效期":
			return { ...c, name: "Certificate validity", detail: c.ok ? "attestation certificate in date" : "attestation certificate expired — stale proof" };
		case "PCR0 比对":
			return { ...c, name: "Enclave image (PCR0)", detail: c.ok ? "matches the pinned audited image" : shortReason(c.detail) };
		case "公钥绑定":
			return { ...c, name: "Signing key binding", detail: c.ok ? "response signer is the attested enclave" : "response signer is not the key this enclave attested" };
		case "nonce 绑定":
			return { ...c, name: "Nonce binding", detail: c.ok ? "proof nonce matches the attestation" : "proof nonce does not match the attestation — spliced or forged proof" };
		case "响应签名":
			return { ...c, name: "Response signature", detail: c.ok ? "signature verifies and response bytes are unaltered" : c.detail.includes("哈希") ? "received bytes do not match the signed hash — response was modified" : "signature does not verify — statement or signature was altered" };
		case "请求绑定":
			return { ...c, name: "Request binding", detail: c.ok ? "sent request bytes match the signed digest" : "request bytes differ from the signed digest" };
		default:
			return { name: c.name, ok: c.ok, detail: c.detail };
	}
}

/** Condense the vendored verifier's verbose reason to a single clause. */
function shortReason(detail: string): string {
	if (/解析|验证异常/.test(detail)) return "attestation is malformed or failed validation";
	if (/rootPinned|链校验失败|背书验签失败/.test(detail)) return "attestation does not chain to the pinned AWS Nitro root";
	return detail;
}

export function verifyExchange(input: VerifyInput, policy: VerificationPolicy): { report: ProofVerdict } {
	const parsed = parseTeeProofEvent(input.wireBytes);
	const proof: TeeProofWire | undefined = parsed.proof;

	if (!proof) {
		return {
			report: {
				status: "unproven",
				checks: [
					{ name: "Proof present", ok: false, detail: "no tee.proof in the response — nothing was attested" },
				],
				bytes: input.wireBytes.length,
			},
		};
	}

	// Hash the delivered bytes with the same normalizer the wire body goes through,
	// so relay keepalives are not mistaken for edits.
	const delivered = input.clientBytes
		? normalizeDeliveredBody(input.clientBytes, proof)
		: { body: parsed.body, strippedKeepalives: 0 };

	const result = verifyTeeExchange(
		{
			expectedPcr0: policy.expectedPcr0,
			// The vendored verifier takes a single host; the policy pins exactly one
			// measured host per route, so there is nothing to widen here.
			expectedHost: policy.endpoint.host,
			requestBody: input.requestBytes,
			responseBody: delivered.body,
			proof,
		},
		input.attestationVerifier ? { verifyAttestationDoc: input.attestationVerifier } : {},
	);

	// Rename and re-word upstream's checks: English only, one concise reason per case.
	// Its single-host check is dropped in favour of the exact-tuple gates below.
	const checks = result.checks
		.filter((c) => c.name !== "上游 host")
		.map(renameCheck);

	// Say which delivery branch was normalized, so a stripped keepalive is visible
	// in the verdict rather than silent.
	if (delivered.strippedKeepalives > 0) {
		const i = checks.findIndex((c) => c.name === "Response signature");
		if (i >= 0) checks[i] = { ...checks[i]!, detail: `${checks[i]!.detail} (${delivered.strippedKeepalives} relay keepalive${delivered.strippedKeepalives === 1 ? "" : "s"} stripped)` };
	}

	// Upstream host: the signed name must be the policy's measured host, exactly.
	const gotHost = String(proof.upstream_host ?? "");
	const hostOk = gotHost === policy.endpoint.host;
	const hostCheck: TeeCheck = {
		name: "Upstream host",
		ok: hostOk,
		detail: hostOk ? `signed upstream = ${gotHost}` : `served from ${gotHost || "(none)"} — not the official endpoint`,
	};
	const hostIdx = checks.findIndex((c) => c.name === "Signing key binding");
	checks.splice(hostIdx < 0 ? 0 : hostIdx, 0, hostCheck);

	// An unset anchor means "no opinion", not "pass". Never let a green run imply a
	// PCR0 comparison happened when it did not.
	if (!policy.expectedPcr0) {
		const i = checks.findIndex((c) => c.name === "Enclave image (PCR0)");
		if (i >= 0) checks[i] = { name: checks[i]!.name, ok: false, detail: "no audit PCR0 pinned — image substitution not checked" };
	}

	// The relay rewrites the request body, so byte-exact binding is unreachable. This is
	// a documented gap, not a failure: it must never raise a warning. See README.
	if (policy.requestBinding === "unavailable") {
		const i = checks.findIndex((c) => c.name === "Request binding");
		if (i >= 0) checks[i] = { name: checks[i]!.name, ok: false, detail: "request body is rewritten by the relay — not checkable (documented gap)" };
	}

	// Path and method join the host as one exact tuple: no suffixes, no mixes.
	const path = String(proof.upstream_path ?? "");
	const pathOk = path === policy.endpoint.path;
	checks.push({
		name: "Upstream path",
		ok: pathOk,
		detail: pathOk ? path : `unexpected path ${path} — not a known wokey route`,
	});

	const gotMethod = String(proof.http_method ?? "");
	const methodOk = gotMethod === policy.endpoint.method;
	checks.push({
		name: "Upstream method",
		ok: methodOk,
		detail: methodOk ? gotMethod : `unexpected method ${gotMethod || "(none)"} — expected ${policy.endpoint.method}`,
	});

	// Which model actually served this, read from the integrity-bound response body
	// with the route's own reader. Exact equality only: no prefix games, no alias
	// map — no real Wokey response has needed one.
	const served = input.extractServedModel(parsed.body);
	if (input.expectedModel) {
		const want = input.expectedModel;
		const matches = served === want;
		checks.push({
			name: "Served model",
			ok: matches,
			detail: matches ? (served ?? "unknown") : `served "${served}" but "${want}" was requested — model substitution`,
		});
	}

	const blocking = checks.filter((c) => c.name !== "Request binding" || policy.requestBinding === "verify");
	const blockingFailed = blocking.some((c) => !c.ok);
	const gaps = checks.length - blocking.length;
	const status: ProofStatus = blockingFailed ? "failed" : gaps > 0 ? "verified-with-gaps" : "verified";

	return {
		report: {
			status,
			checks,
			upstreamHost: proof.upstream_host,
			upstreamPath: path,
			pcr0: result.attestation.pcr0 ?? undefined,
			reportedModel: input.extractServedModel(parsed.body),
			bytes: (input.clientBytes ?? parsed.body).length,
		},
	};
}

// ── the fetch wrapper ──────────────────────────────────────────────────────────

type FetchArg = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

export function createProbingFetch(deps: ProbeDeps): typeof globalThis.fetch {
	const realFetch = globalThis.fetch.bind(globalThis);

	return async function probingFetch(input: FetchArg, init?: FetchInit): Promise<Response> {
		const startedAt = Date.now();
		const capture = await captureRequestBytes(input, init);
		const requestBytes = capture.requestBytes;
		const response = await realFetch(input, capture.init ?? init);
		const contentType = response.headers.get("content-type") ?? "";

		const finish = (wireBytes: Buffer, clientBytes: Buffer, reason?: string): void => {
			try {
				let report: ProofVerdict;
				try {
					report = verifyExchange(
						{
							wireBytes,
							clientBytes,
							requestBytes,
							expectedModel: deps.expectedModel,
							extractServedModel: deps.extractServedModel,
							attestationVerifier: deps.attestationVerifier,
						},
						deps.policy,
					).report;
				} catch (error) {
					report = {
						status: "failed",
						checks: [{ name: "自证校验", ok: false, detail: `校验异常:${error instanceof Error ? error.message : String(error)}` }],
						bytes: clientBytes.length,
					};
				}
				deps.onReport({
					...report,
					finishedAt: Date.now(),
					durationMs: Date.now() - startedAt,
					...(reason ? { reason } : {}),
				});
			} catch {
				// Reporting must never break the request path.
			}
		};

		// Non-streaming: the whole body is already in hand. Deliver the upstream body,
		// not the relay's proof envelope, so the bytes the client receives are exactly
		// the bytes the signature covers.
		if (!response.body || !/text\/event-stream/i.test(contentType)) {
			const bytes = Buffer.from(await response.arrayBuffer());
			const parsedBytes = parseTeeProofEvent(bytes);
			const delivered = parsedBytes.proof ? parsedBytes.body : bytes;
			finish(bytes, delivered);
			return new Response(delivered, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		}

		// Streaming: verify one branch, hand the adapter the other (minus proof).
		// Peak memory is ~2x the response (tee lag buffer + the verifier's drain);
		// acceptable for tool-call-sized output, worth revisiting at 1M context.
		const [verifyBranch, clientBranch] = response.body.tee();
		void drain(verifyBranch)
			.then((full) => {
				// Verify exactly what the client was given, not the raw wire bytes. The
				// record is trailing by protocol; a forged mid-stream marker therefore
				// extends the hashed prefix past what the client saw, failing the run.
				const idx = Math.max(full.lastIndexOf(PROOF_EVENT_LF), full.lastIndexOf(PROOF_EVENT_CRLF));
				const clientBytes = idx >= 0 ? full.subarray(0, idx) : full;
				finish(full, clientBytes, idx < 0 ? "no tee.proof event in stream" : undefined);
			})
			.catch(() => finish(Buffer.alloc(0), Buffer.alloc(0), "could not read response for verification"));

		return new Response(stripTrailingProofEvent(clientBranch), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}