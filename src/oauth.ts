/**
 * Command Code OAuth provider for pi's /login flow.
 *
 * Implements a browser-assisted API key retrieval flow:
 * 1. Starts a local HTTP server on a Command Code CLI-compatible port
 * 2. Opens the Command Code Studio auth page in the browser
 * 3. The user authenticates on the Command Code website
 * 4. The website POSTs the API key back to the local server
 * 5. If browser transfer fails, the user can paste the API key manually
 * 6. The API key is stored in pi's auth.json as OAuth credentials
 *
 * Since Command Code API keys don't expire, we store them as
 * OAuth credentials with a far-future expiry.
 */

import { randomBytes } from "node:crypto";
import { startAuthServer } from "./auth-server.js";
import { sanitizeApiKey } from "./logic.js";

const STUDIO_BASE_URL = "https://commandcode.ai";
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000; // API keys don't expire
const DEFAULT_AUTH_TIMEOUT_MS = 15_000;

export interface OAuthLoginCallbacks {
  onAuth(params: { url: string }): void;
  onPrompt(params: { message: string }): Promise<string>;
}

export interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
}

class AuthTimeoutError extends Error {
  constructor() {
    super("Browser authentication timed out");
    this.name = "AuthTimeoutError";
  }
}

function generateStateToken(): string {
  return randomBytes(32).toString("base64url");
}

function getAuthTimeoutMs(): number {
  const raw = process.env.COMMANDCODE_AUTH_TIMEOUT_MS;
  if (!raw) return DEFAULT_AUTH_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUTH_TIMEOUT_MS;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AuthTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function credentialsFromApiKey(apiKey: string): OAuthCredentials {
  return {
    refresh: apiKey,
    access: apiKey,
    expires: Date.now() + TEN_YEARS_MS,
  };
}

async function promptForApiKey(
  callbacks: OAuthLoginCallbacks,
  message: string,
): Promise<OAuthCredentials> {
  const apiKey = sanitizeApiKey(await callbacks.onPrompt({ message }));
  if (!apiKey) throw new Error("No Command Code API key provided");
  return credentialsFromApiKey(apiKey);
}

/**
 * Starts the browser-based login flow for Command Code.
 *
 * Returns OAuth credentials where access == refresh == the user's API key.
 * The keys don't expire, so we set a far-future expiry.
 */
export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  let authServer;
  try {
    authServer = await startAuthServer();
  } catch {
    return promptForApiKey(
      callbacks,
      "Could not start browser auth. Paste your Command Code API key:",
    );
  }

  const stateToken = generateStateToken();
  const callbackUrl = `http://localhost:${authServer.port}/callback`;
  const authUrl = `${STUDIO_BASE_URL}/studio/auth/cli?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(stateToken)}`;

  // Tell pi to open the browser
  callbacks.onAuth({ url: authUrl });

  // Wait for the Command Code Studio to POST the API key back.
  // If the browser cannot reach localhost, fall back to manual paste.
  let callback: { apiKey: string; state: string };
  try {
    callback = await withTimeout(authServer.waitForCallback, getAuthTimeoutMs());
  } catch (error) {
    authServer.server.close();
    if (error instanceof AuthTimeoutError) {
      return promptForApiKey(
        callbacks,
        "Automatic transfer failed or timed out. Paste your Command Code API key:",
      );
    }
    throw error;
  }

  // Validate state token to prevent CSRF
  if (callback.state !== stateToken) {
    authServer.server.close();
    throw new Error("State token mismatch. Authentication may have been tampered with.");
  }

  return credentialsFromApiKey(callback.apiKey);
}

/**
 * Command Code API keys don't expire, so "refresh" is a no-op.
 * Returns the same credentials with an updated far-future expiry.
 */
export async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return credentialsFromApiKey(credentials.refresh);
}

/**
 * Returns the access token (API key) from OAuth credentials.
 */
export function getApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}