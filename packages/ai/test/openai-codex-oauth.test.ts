import { afterEach, describe, expect, it, vi } from "vitest";
import {
	loginOpenAICodexDeviceCode,
	openaiCodexOAuthProvider,
	refreshOpenAICodexToken,
} from "../src/utils/oauth/openai-codex.js";
import type { OAuthSelectPrompt } from "../src/utils/oauth/types.js";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function createAccessToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: accountId,
			},
		}),
	).toString("base64");
	return `${header}.${payload}.signature`;
}

describe("OpenAI Codex OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("logs in with the OpenAI Codex device code flow", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-05-19T00:00:00Z");
		vi.setSystemTime(startTime);

		const accessToken = createAccessToken("account-123");
		const authInfos: { userCode: string; verificationUri: string; instructions?: string }[] = [];
		const progressMessages: string[] = [];
		const pollTimes: number[] = [];
		const pollResponses = [
			jsonResponse(
				{
					error: {
						message: "Device authorization is pending. Please try again.",
						type: "invalid_request_error",
						code: "deviceauth_authorization_pending",
					},
				},
				403,
			),
			jsonResponse({ code: "oauth-code", code_verifier: "device-code-verifier" }),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
				expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
				return jsonResponse({
					device_auth_id: "device-auth-id",
					user_code: "ABCD-1234",
					interval: "5",
				});
			}

			if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
				pollTimes.push(Date.now());
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
				expect(JSON.parse(String(init?.body))).toEqual({
					device_auth_id: "device-auth-id",
					user_code: "ABCD-1234",
				});
				const response = pollResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra device auth poll");
				}
				return response;
			}

			if (url === "https://auth.openai.com/oauth/token") {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("authorization_code");
				expect(params.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
				expect(params.get("code")).toBe("oauth-code");
				expect(params.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
				expect(params.get("code_verifier")).toBe("device-code-verifier");
				return jsonResponse({
					access_token: accessToken,
					refresh_token: "refresh-token",
					expires_in: 3600,
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const onAuth = vi.fn();
		const credentialsPromise = loginOpenAICodexDeviceCode({
			onAuth,
			onDeviceCode: (info) => authInfos.push(info),
			onProgress: (message) => progressMessages.push(message),
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(authInfos).toEqual([
			{
				userCode: "ABCD-1234",
				verificationUri: "https://auth.openai.com/codex/device",
				instructions: "Enter code: ABCD-1234",
				intervalSeconds: 5,
			},
		]);
		expect(onAuth).not.toHaveBeenCalled();
		expect(progressMessages).toEqual(["Waiting for authentication..."]);

		await vi.advanceTimersByTimeAsync(4999);
		expect(pollTimes).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		expect(pollTimes).toEqual([startTime.getTime() + 5000]);

		await vi.advanceTimersByTimeAsync(5000);
		await expect(credentialsPromise).resolves.toMatchObject({
			access: accessToken,
			refresh: "refresh-token",
			expires: startTime.getTime() + 10_000 + 3600 * 1000,
			accountId: "account-123",
		});
		expect(pollTimes).toEqual([startTime.getTime() + 5000, startTime.getTime() + 10_000]);
	});

	it("selects device code login as an OpenAI Codex login option", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-19T00:00:00Z"));

		const accessToken = createAccessToken("account-123");
		const selectPrompts: OAuthSelectPrompt[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					return jsonResponse({ device_auth_id: "device-auth-id", user_code: "ABCD-1234", interval: "1" });
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					return jsonResponse({ code: "oauth-code", code_verifier: "device-code-verifier" });
				}
				if (url === "https://auth.openai.com/oauth/token") {
					return jsonResponse({ access_token: accessToken, refresh_token: "refresh-token", expires_in: 3600 });
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialsPromise = openaiCodexOAuthProvider.login({
			onAuth: () => {},
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onSelect: async (prompt) => {
				selectPrompts.push(prompt);
				return "device";
			},
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(selectPrompts).toEqual([
			{
				message: "Choose OpenAI Codex login method",
				options: [
					{ id: "browser", label: "Browser login (default)" },
					{ id: "device", label: "Device code login" },
				],
			},
		]);

		await vi.advanceTimersByTimeAsync(1000);
		await expect(credentialsPromise).resolves.toMatchObject({ accountId: "account-123" });
	});

	it("cancels the OpenAI Codex device code flow while waiting", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const authInfos: { userCode: string; verificationUri: string }[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "5",
					});
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialsPromise = loginOpenAICodexDeviceCode({
			onAuth: () => {},
			onDeviceCode: (info) => authInfos.push(info),
			signal: controller.signal,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(authInfos).toHaveLength(1);

		controller.abort();
		await expect(credentialsPromise).rejects.toThrow("Login cancelled");
	});

	it("does not write token refresh failures to stderr", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				return new Response(
					JSON.stringify({
						error: {
							message: "Could not validate your token. Please try signing in again.",
							type: "invalid_request_error",
						},
					}),
					{ status: 401, statusText: "Unauthorized", headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		await expect(refreshOpenAICodexToken("invalid-refresh-token")).rejects.toThrow(
			/OpenAI Codex token refresh failed \(401\).*Could not validate your token/,
		);
		expect(consoleError).not.toHaveBeenCalled();
	});
});
