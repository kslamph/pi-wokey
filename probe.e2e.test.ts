/**
 * End-to-end test of the probing fetch against a real HTTP server.
 *
 * The Ed25519 half is genuine — a real keypair signs a real statement over real
 * bytes — so the response-signature and content-binding gates run for real. Only
 * the COSE/P-384 → AWS Nitro root chain is stubbed, since that needs real
 * Nitro hardware. What is under test is this extension's own code: byte-exact
 * request capture, streaming preservation, proof stripping across chunk
 * boundaries, and that a clean run is reported clean.
 */

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createHash, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig, PUBLISHED_PCR0, type WokeyConfig } from "./config.ts";
import { getRoute } from "./routes.ts";
import { buildV2Statement } from "./verify/signing.ts";
import { createProbingFetch, verifyExchange, type ProofReport, type VerificationPolicy } from "./verify/probe.ts";
import { WOKEY_SSE_TRANSPORT_KEEPALIVE_V1, type AttestationVerifier, type TeeProofWire } from "./verify/tee-verify-core.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBKEY_SPKI_B64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const NONCE = Buffer.from("integration-nonce-0123", "utf8").toString("base64");

const CONFIG: WokeyConfig = resolveConfig();
/**
 * Both measured routes mark request binding "unavailable" (the relay rewrites the
 * body before the enclave sees it), so even a byte-exact exchange reports
 * verified-with-gaps with Request binding as the documented gap. Task 3 makes the
 * binding policy per-route explicit in `VerificationPolicy`.
 */

/** Signs a genuine v2 statement over the given bodies. */
function signProof(upstreamBody: Buffer, requestBody: Buffer, over: Partial<TeeProofWire> = {}): TeeProofWire {
	const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
	const proof: TeeProofWire = {
		v: 2,
		alg: "ed25519",
		public_key: PUBKEY_SPKI_B64,
		nonce: NONCE,
		upstream_host: "chatgpt.com",
		upstream_path: "/backend-api/codex/responses",
		http_method: "POST",
		http_status: 200,
		resp_content_type: "text/event-stream",
		request_body_sha256: sha(requestBody),
		response_body_sha256: sha(upstreamBody),
		signature: "",
		attestation: "stubbed",
		pcr0: PUBLISHED_PCR0,
		...over,
	};
	const statement = buildV2Statement({
		nonceB64: proof.nonce,
		upstreamHost: proof.upstream_host,
		upstreamPath: proof.upstream_path,
		httpMethod: proof.http_method,
		httpStatus: proof.http_status,
		respContentType: proof.resp_content_type,
		requestBodySha256Hex: proof.request_body_sha256,
		responseBodySha256Hex: proof.response_body_sha256,
	});
	proof.signature = nodeSign(null, statement, privateKey).toString("base64");
	return proof;
}

function stubAttestation(): AttestationVerifier {
	return () => ({
		ok: true,
		sigOk: true,
		chainOk: true,
		rootSelf: true,
		rootPinned: true,
		timeValid: true,
		pcr0: PUBLISHED_PCR0,
		publicKey: PUBKEY_SPKI_B64,
		nonce: NONCE,
		rootFingerprint: "64:1A:03:21:A3:E2:44:EF:E4:56:46:31:95:D6:06:31:7E:D7:CD:CC:3C:17:56:E0:98:93:F3:C6:8F:79:BB:5B",
	});
}

let server: Server;
let origin = "";
/** Rewritten per test: what the mock server should reply with. */
let reply: (requestBody: Buffer) => { chunks: string[]; contentType: string } = () => ({
	chunks: [],
	contentType: "text/event-stream",
});

beforeAll(async () => {
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const { chunks: out, contentType } = reply(Buffer.concat(chunks));
			res.writeHead(200, { "content-type": contentType });
			for (const c of out) res.write(c);
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address();
	if (typeof addr === "string" || addr === null) throw new Error("no address");
	origin = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

async function run(body: string, policyOver: Partial<VerificationPolicy> = {}): Promise<{ clientBytes: Buffer; report: ProofReport }> {
	let report: ProofReport | undefined;
	const route = getRoute("openai-codex");
	const probing = createProbingFetch({
		policy: { expectedPcr0: CONFIG.expectedPcr0, endpoint: route.endpoint, requestBinding: route.requestBinding, ...policyOver },
		onReport: (r) => {
			report = r;
		},
		extractServedModel: route.extractServedModel,
		attestationVerifier: stubAttestation(),
	});
	const res = await probing(`${origin}/v1/responses`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
	const chunks: Buffer[] = [];
	const reader = res.body!.getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) chunks.push(Buffer.from(value));
	}
	// The report is produced on the drain of the verification branch.
	for (let i = 0; i < 100 && !report; i++) await new Promise((r) => setTimeout(r, 10));
	if (!report) throw new Error("no report produced");
	return { clientBytes: Buffer.concat(chunks), report };
}

const REQUEST_BODY = JSON.stringify({ model: "gpt-6.1-sol", input: "hello", stream: true });

describe("probing fetch, end to end", () => {
	it("verifies a genuine signed exchange and hides the proof from the client", async () => {
		const upstream = 'event: response.completed\ndata: {"response":{"model":"gpt-6.1-sol","status":"completed"}}\n\n';
		const proof = signProof(Buffer.from(upstream, "utf8"), Buffer.from(REQUEST_BODY, "utf8"));
		reply = () => ({
			contentType: "text/event-stream",
			// Split the proof record across chunk boundaries on purpose.
			chunks: [
				"event: response.completed\ndata: {\"response\":{\"model\":\"gpt-6.1-sol\",",
				"\"status\":\"completed\"}}\n\n",
				"event: tee.proof\ndata: " + JSON.stringify(proof).slice(0, 40),
				JSON.stringify(proof).slice(40) + "\n\n",
			],
		});

		const { clientBytes, report } = await run(REQUEST_BODY);

		expect(clientBytes.toString("utf8")).toBe(upstream);
		expect(clientBytes.toString("utf8")).not.toContain("tee.proof");
		expect(report.status).toBe("verified-with-gaps");
		expect(report.reportedModel).toBe("gpt-6.1-sol");
		expect(report.upstreamHost).toBe("chatgpt.com");
		for (const c of report.checks) {
			if (c.name === "Request binding") expect(c.ok).toBe(false); // documented gap
			else expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
		}
	});

	it("reports a strict verified when the route policy verifies request binding", async () => {
		const upstream = 'event: response.completed\ndata: {"response":{"model":"gpt-6.1-sol","status":"completed"}}\n\n';
		const proof = signProof(Buffer.from(upstream, "utf8"), Buffer.from(REQUEST_BODY, "utf8"));
		reply = () => ({
			contentType: "text/event-stream",
			chunks: [upstream, `event: tee.proof\ndata: ${JSON.stringify(proof)}\n\n`],
		});

		// Same byte-exact exchange, but the policy says binding is achievable: the
		// gap lifts and the run is strictly verified. This pins that the gap is
		// per-route policy, not hard-coded.
		const { report } = await run(REQUEST_BODY, { requestBinding: "verify" });
		expect(report.checks.find((c) => c.name === "Request binding")?.ok).toBe(true);
		expect(report.status).toBe("verified");
	});

	it("flags a tampered response body while still delivering it (warn-only)", async () => {
		const signed = 'event: response.completed\ndata: {"response":{"model":"gpt-6.1-sol"}}\n\n';
		const proof = signProof(Buffer.from(signed, "utf8"), Buffer.from(REQUEST_BODY, "utf8"));
		const tampered = signed.replace("gpt-6.1-sol", "gpt-6-luna");
		reply = () => ({ contentType: "text/event-stream", chunks: [tampered, `event: tee.proof\ndata: ${JSON.stringify(proof)}\n\n`] });

		const { clientBytes, report } = await run(REQUEST_BODY);

		// Warn-only: the content still reaches pi.
		expect(clientBytes.toString("utf8")).toContain("gpt-6-luna");
		expect(report.status).toBe("failed");
		expect(report.checks.find((c) => !c.ok)?.name).toBe("Response signature");
	});

	it("reports a request that does not match as a binding gap, not a failure", async () => {
		const upstream = 'event: response.completed\ndata: {}\n\n';
		// Sign a *different* request than the one we are about to send.
		const proof = signProof(Buffer.from(upstream, "utf8"), Buffer.from('{"model":"gpt-6-astra"}', "utf8"));
		reply = () => ({ contentType: "text/event-stream", chunks: [upstream, `event: tee.proof\ndata: ${JSON.stringify(proof)}\n\n`] });

		const { report } = await run(REQUEST_BODY);
		expect(report.status).toBe("verified-with-gaps");
		expect(report.checks.find((c) => c.name === "Request binding")?.ok).toBe(false);
	});

	it("reports 'unproven' when the relay sends no proof", async () => {
		reply = () => ({ contentType: "text/event-stream", chunks: ['event: response.completed\ndata: {"response":{"model":"gpt-6.1-sol"}}\n\n'] });
		const { clientBytes, report } = await run(REQUEST_BODY);
		expect(clientBytes.toString("utf8")).toContain("gpt-6.1-sol");
		expect(report.status).toBe("unproven");
	});

	it("verifies-with-gaps when the relay rewrites the body (the real wokey case)", async () => {
		const upstream = 'event: response.completed\ndata: {"response":{"model":"gpt-6-luna"}}\n\n';
		// Sign a body that is NOT what we send, exactly as wokey does.
		const proof = signProof(Buffer.from(upstream, "utf8"), Buffer.from('{"model":"gpt-6-luna","rewritten":true}', "utf8"));
		reply = () => ({ contentType: "text/event-stream", chunks: [upstream, `event: tee.proof\ndata: ${JSON.stringify(proof)}\n\n`] });

		const { report } = await run(REQUEST_BODY);
		expect(report.checks.find((c) => c.name === "Request binding")?.ok).toBe(false);
		expect(report.checks.find((c) => c.name === "Response signature")?.ok).toBe(true);
		expect(report.status).toBe("verified-with-gaps");
	});

	it("verifies a stream that carries relay transport keepalives", async () => {
		const upstream = 'event: response.completed\ndata: {"response":{"model":"gpt-6.1-sol"}}\n\n';
		const proof = signProof(Buffer.from(upstream, "utf8"), Buffer.from(REQUEST_BODY, "utf8"));
		reply = () => ({
			contentType: "text/event-stream",
			chunks: [WOKEY_SSE_TRANSPORT_KEEPALIVE_V1, upstream, `event: tee.proof\ndata: ${JSON.stringify(proof)}\n\n`],
		});

		const { clientBytes, report } = await run(REQUEST_BODY);

		// The keepalive is relay transport noise, not part of the signed body; it
		// must not make the delivered bytes hash differently from the signature.
		expect(clientBytes.toString("utf8")).toContain(WOKEY_SSE_TRANSPORT_KEEPALIVE_V1);
		expect(report.status).toBe("verified-with-gaps");
		expect(report.checks.find((c) => c.name === "Response signature")?.ok).toBe(true);
	});

	it("fails verification when a forged mid-stream proof marker appears", async () => {
		const upstream = 'event: response.completed\ndata: {"response":{"model":"gpt-6.1-sol"}}\n\n';
		const proof = signProof(Buffer.from(upstream, "utf8"), Buffer.from(REQUEST_BODY, "utf8"));
		reply = () => ({
			contentType: "text/event-stream",
			chunks: [
				upstream,
				// A forged marker before the genuine trailing proof record.
				'event: tee.proof\ndata: {"forged":true}\n\n',
				`event: tee.proof\ndata: ${JSON.stringify(proof)}\n\n`,
			],
		});

		const { report } = await run(REQUEST_BODY);

		// A forged mid-stream marker must not pass quietly: the hashed prefix runs
		// past what the client saw, so the run is reported as failed.
		expect(report.status).toBe("failed");
		expect(report.checks.find((c) => c.name === "Response signature")?.ok).toBe(false);
	});

	it("fails closed on a multipart envelope it did not negotiate", async () => {
		const body = JSON.stringify({ model: "gpt-6.1-sol", output: [] });
		const proof = signProof(Buffer.from(body, "utf8"), Buffer.from(REQUEST_BODY, "utf8"));
		const boundary = "wokey-boundary-1234";
		const envelope =
			`--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n` +
			`--${boundary}\r\nContent-Disposition: form-data; name="proof"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(proof)}\r\n` +
			`--${boundary}--\r\n`;
		reply = () => ({ contentType: `multipart/form-data; boundary=${boundary}`, chunks: [envelope] });

		const { clientBytes, report } = await run(REQUEST_BODY);

		// The provider only speaks the relay's default SSE proof transport. An
		// unnegotiated multipart envelope is passed through untouched and cannot
		// be mistaken for a verified response.
		expect(clientBytes.toString("utf8")).toBe(envelope);
		expect(report.status).toBe("unproven");
	});

	it("verifies a non-streaming JSON response and strips the proof from the body", async () => {
		const body = JSON.stringify({ model: "gpt-6.1-sol", output: [] });
		const proof = signProof(Buffer.from(body, "utf8"), Buffer.from(REQUEST_BODY, "utf8"));
		reply = () => ({ contentType: "application/json", chunks: [body, `event: tee.proof\ndata: ${JSON.stringify(proof)}\n\n`] });

		const { clientBytes, report } = await run(REQUEST_BODY);

		// The client must not receive the trailing proof record, and the hash must
		// cover only the upstream body.
		expect(clientBytes.toString("utf8")).toBe(body);
		expect(report.status).toBe("verified-with-gaps"); // request binding is a documented gap
	});
});
/**
 * Anthropic-route regression coverage over the committed live-shaped fixtures
 * (test-fixtures/anthropic-opus-5-5*.sse). Same wrapper, same gates as the GPT
 * block above, but with a message_start/thinking/tool_use body, Anthropic ping
 * records, and prompt-cache usage — proving proof stripping leaves valid
 * downstream SSE for both adapters.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "test-fixtures");

function loadFixture(name: string): { wire: string; proof: TeeProofWire; requestBody: string } {
	const wire = readFileSync(join(FIXTURES, `${name}.sse`), "utf8");
	const doc = JSON.parse(readFileSync(join(FIXTURES, `${name}-proof.json`), "utf8")) as {
		proof: TeeProofWire;
		sanitized_request_body: string;
	};
	return { wire, proof: doc.proof, requestBody: doc.sanitized_request_body };
}

/** Stub attestation derived from the fixture itself: key, nonce, and PCR0 must match the proof. */
function stubAttestationFor(proof: TeeProofWire): AttestationVerifier {
	return () => ({
		ok: true,
		sigOk: true,
		chainOk: true,
		rootSelf: true,
		rootPinned: true,
		timeValid: true,
		pcr0: PUBLISHED_PCR0,
		publicKey: proof.public_key,
		nonce: proof.nonce,
		rootFingerprint: "fixture-test-only",
	});
}

function anthropicPolicy(over: Partial<VerificationPolicy> = {}): VerificationPolicy {
	const route = getRoute("anthropic-direct");
	return { expectedPcr0: CONFIG.expectedPcr0, endpoint: route.endpoint, requestBinding: route.requestBinding, ...over };
}

async function runAnthropicFixture(
	name: string,
	opts: { sendBody?: string; policyOver?: Partial<VerificationPolicy>; expectedModel?: string; tamper?: (body: string) => string } = {},
): Promise<{ clientBytes: Buffer; report: ProofReport; proof: TeeProofWire; body: string; requestBody: string }> {
	const { wire, proof, requestBody } = loadFixture(name);
	const marker = wire.lastIndexOf("event: tee.proof");
	const body = wire.slice(0, marker);
	const record = wire.slice(marker);
	const served = (opts.tamper ? opts.tamper(body) : body) + record;
	// Odd 13-byte slices on purpose: the marker is split across chunk
	// boundaries, so stripping must reassemble before matching.
	const chunks: string[] = [];
	for (let i = 0; i < served.length; i += 13) chunks.push(served.slice(i, i + 13));
	reply = () => ({ contentType: "text/event-stream", chunks });

	let report: ProofReport | undefined;
	const route = getRoute("anthropic-direct");
	const probing = createProbingFetch({
		policy: anthropicPolicy(opts.policyOver),
		onReport: (r) => {
			report = r;
		},
		expectedModel: opts.expectedModel ?? "claude-opus-5-5",
		extractServedModel: route.extractServedModel,
		attestationVerifier: stubAttestationFor(proof),
	});
	const res = await probing(`${origin}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: opts.sendBody ?? JSON.stringify({ model: "claude-opus-5-5", stream: true }),
	});
	const parts: Buffer[] = [];
	const reader = res.body!.getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) parts.push(Buffer.from(value));
	}
	for (let i = 0; i < 100 && !report; i++) await new Promise((r) => setTimeout(r, 10));
	if (!report) throw new Error("no report produced");
	return { clientBytes: Buffer.concat(parts), report, proof, body, requestBody };
}

describe("anthropic-direct route against recorded fixtures", () => {
	it("pins the fixture signature against the repo statement builder", () => {
		for (const name of ["anthropic-opus-5-5", "anthropic-opus-5-5-cache-read"]) {
			const { wire, proof } = loadFixture(name);
			const marker = wire.lastIndexOf("event: tee.proof");
			const body = wire.slice(0, marker);
			// The hash relationship is genuine, not decorative.
			expect(createHash("sha256").update(body, "utf8").digest("hex")).toBe(proof.response_body_sha256);
			// ...and the Ed25519 signature verifies under the repo's own
			// statement layout, so generator drift fails here, not in CI.
			const statement = buildV2Statement({
				nonceB64: proof.nonce,
				upstreamHost: proof.upstream_host,
				upstreamPath: proof.upstream_path,
				httpMethod: proof.http_method,
				httpStatus: proof.http_status,
				respContentType: proof.resp_content_type,
				requestBodySha256Hex: proof.request_body_sha256,
				responseBodySha256Hex: proof.response_body_sha256,
			});
			const key = createPublicKey({ key: Buffer.from(proof.public_key, "base64"), format: "der", type: "spki" });
			expect(nodeVerify(null, statement, key, Buffer.from(proof.signature, "base64"))).toBe(true);
			expect(proof.upstream_host).toBe("api.anthropic.com");
			expect(proof.upstream_path).toBe("/v1/messages");
		}
	});

	it("verifies a live-shaped Claude exchange; the only gap is request binding", async () => {
		const { clientBytes, report, body } = await runAnthropicFixture("anthropic-opus-5-5");

		// Proof stripping leaves valid downstream SSE: byte-exact body, no proof.
		expect(clientBytes.toString("utf8")).toBe(body);
		expect(clientBytes.toString("utf8")).not.toContain("tee.proof");
		expect(report.status).toBe("verified-with-gaps");
		expect(report.reportedModel).toBe("claude-opus-5-5");
		expect(report.upstreamHost).toBe("api.anthropic.com");
		expect(report.upstreamPath).toBe("/v1/messages");
		expect(report.upstreamMethod).toBe("POST");
		for (const c of report.checks) {
			if (c.name === "Request binding") expect(c.ok).toBe(false); // documented gap
			else expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
		}
	});

	it("keeps pings, tool calls, thinking signatures, and cache usage in the delivered SSE", async () => {
		const { clientBytes } = await runAnthropicFixture("anthropic-opus-5-5");
		const text = clientBytes.toString("utf8");
		// Anthropic pings are upstream content: they stay in the signed body and
		// reach pi's adapter, which drops them as keepalives per SSE handling.
		expect(text).toContain('event: ping\ndata: {"type":"ping"}');
		expect(text).toContain('"type":"tool_use"');
		expect(text).toContain('"name":"get_time"');
		expect(text).toContain("sig_fixture_redacted_001");
		expect(text).toContain('"cache_creation_input_tokens":2048');
		expect(text).toContain("event: message_stop");
		// ...and the served-model reader skips pings to find message_start.
		expect(getRoute("anthropic-direct").extractServedModel(clientBytes)).toBe("claude-opus-5-5");
	});

	it("verifies strictly when the exact sanitized request bytes are sent under a verify policy", async () => {
		const { requestBody } = loadFixture("anthropic-opus-5-5");
		const { report } = await runAnthropicFixture("anthropic-opus-5-5", {
			sendBody: requestBody,
			policyOver: { requestBinding: "verify" },
		});
		expect(report.checks.find((c) => c.name === "Request binding")?.ok).toBe(true);
		expect(report.status).toBe("verified");
	});

	it("flags a tampered Claude body while still delivering it (warn-only)", async () => {
		const { clientBytes, report } = await runAnthropicFixture("anthropic-opus-5-5", {
			tamper: (body) => body.replace("The fixture clock says noon.", "The fixture clock says midnight."),
		});

		expect(clientBytes.toString("utf8")).toContain("midnight");
		expect(report.status).toBe("failed");
		expect(report.checks.find((c) => !c.ok)?.name).toBe("Response signature");
	});

	it("rejects a Claude substitution and names both models", async () => {
		const { wire, proof } = loadFixture("anthropic-opus-5-5");
		const { report } = verifyExchange(
			{
				wireBytes: Buffer.from(wire, "utf8"),
				expectedModel: "claude-opus-9-9",
				extractServedModel: getRoute("anthropic-direct").extractServedModel,
				attestationVerifier: stubAttestationFor(proof),
			},
			anthropicPolicy(),
		);
		const served = report.checks.find((c) => c.name === "Served model");
		expect(served?.ok).toBe(false);
		expect(served?.detail).toContain("claude-opus-5-5");
		expect(served?.detail).toContain("claude-opus-9-9");
		// The substitution gate fires on its own: the response signature over
		// the genuine fixture body still passes.
		expect(report.checks.find((c) => c.name === "Response signature")?.ok).toBe(true);
	});

	it("verifies the cache-read repeat with its read tokens intact", async () => {
		const { clientBytes, report } = await runAnthropicFixture("anthropic-opus-5-5-cache-read");

		expect(clientBytes.toString("utf8")).toContain('"cache_read_input_tokens":2048');
		expect(clientBytes.toString("utf8")).toContain("event: message_stop");
		expect(clientBytes.toString("utf8")).not.toContain("tee.proof");
		expect(report.status).toBe("verified-with-gaps");
		expect(report.reportedModel).toBe("claude-opus-5-5");
	});

	it("strips the trailing proof for both adapters, leaving each completion marker", async () => {
		// GPT Responses body through the GPT policy...
		const gptUpstream = 'event: response.completed\ndata: {"response":{"model":"gpt-6-luna","status":"completed"}}\n\n';
		const gptProof = signProof(Buffer.from(gptUpstream, "utf8"), Buffer.from(REQUEST_BODY, "utf8"));
		reply = () => ({ contentType: "text/event-stream", chunks: [gptUpstream, `event: tee.proof\ndata: ${JSON.stringify(gptProof)}\n\n`] });
		const { clientBytes: gptBytes } = await run(REQUEST_BODY);
		expect(gptBytes.toString("utf8")).toBe(gptUpstream);

		// ...and the Anthropic fixture through the Anthropic policy: same
		// wrapper, same trailing-record strip, each downstream SSE valid.
		const { clientBytes: claudeBytes } = await runAnthropicFixture("anthropic-opus-5-5-cache-read");
		expect(claudeBytes.toString("utf8")).toContain("event: message_stop");
		for (const bytes of [gptBytes, claudeBytes]) {
			expect(bytes.toString("utf8")).not.toContain("tee.proof");
		}
	});
});
