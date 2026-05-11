/**
 * OpenCode runtime integration.
 *
 * This module abstracts the OpenCode SDK behind a small interface so we can
 * swap implementations (real SDK, mock, or a future direct-Copilot client)
 * without touching the agent manager.
 *
 * Status: STUB. The real implementation will spawn the OpenCode runtime as
 *   a child process and use `@opencode-ai/sdk` to manage sessions. For now
 *   methods log warnings and return placeholder values so the rest of the
 *   server boots and the WS contract can be validated end-to-end.
 *
 * See: copilot-oauth-explained.md → "Caminho 1 — Mais fácil".
 */

export interface OAuthAuthorizeResult {
  /** URL the user must open in a browser (e.g. https://github.com/login/device). */
  verificationUri: string;
  /** Human-readable code (e.g. "ABCD-1234") to enter on the verification page. */
  userCode: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Polling interval in seconds. */
  interval: number;
}

export interface OpenCodeSession {
  id: string;
  /** Unsubscribe from this session's event stream. */
  close(): Promise<void>;
}

export interface OpenCodeEvent {
  type: 'tool_start' | 'tool_done' | 'text_delta' | 'turn_end' | 'permission_request';
  toolId?: string;
  tool?: string;
  text?: string;
  input?: unknown;
}

export interface OpenCodeClient {
  /** Begin OAuth device flow for the Copilot provider. */
  startOAuth(providerId: 'copilot'): Promise<OAuthAuthorizeResult>;
  /** Poll for OAuth completion. Returns true when the token has been stored. */
  pollOAuth(providerId: 'copilot'): Promise<boolean>;
  /** True if a stored token exists for the provider. */
  isAuthenticated(providerId: 'copilot'): Promise<boolean>;
  /** Drop stored tokens for the provider. */
  logout(providerId: 'copilot'): Promise<void>;

  /** Create a new session bound to the given provider. */
  createSession(providerId: 'copilot'): Promise<OpenCodeSession>;
  /** Send a user prompt to a session. */
  sendPrompt(sessionId: string, text: string): Promise<void>;
  /** Subscribe to a session's event stream. */
  onEvent(sessionId: string, handler: (event: OpenCodeEvent) => void): void;
}

/** Stub implementation — replace once @opencode-ai/sdk is wired in. */
class StubOpenCodeClient implements OpenCodeClient {
  private warned = new Set<string>();

  private warn(method: string): void {
    if (this.warned.has(method)) return;
    this.warned.add(method);
    console.warn(
      `[opencode/stub] ${method}() called but the OpenCode SDK is not wired yet. ` +
        `See webapp/server/src/opencode.ts.`,
    );
  }

  async startOAuth(): Promise<OAuthAuthorizeResult> {
    this.warn('startOAuth');
    return {
      verificationUri: 'https://github.com/login/device',
      userCode: 'STUB-CODE',
      expiresIn: 900,
      interval: 5,
    };
  }

  async pollOAuth(): Promise<boolean> {
    this.warn('pollOAuth');
    return false;
  }

  async isAuthenticated(): Promise<boolean> {
    this.warn('isAuthenticated');
    return false;
  }

  async logout(): Promise<void> {
    this.warn('logout');
  }

  async createSession(): Promise<OpenCodeSession> {
    this.warn('createSession');
    return {
      id: `stub_${Date.now().toString(36)}`,
      close: async () => undefined,
    };
  }

  async sendPrompt(): Promise<void> {
    this.warn('sendPrompt');
  }

  onEvent(): void {
    this.warn('onEvent');
  }
}

let _instance: OpenCodeClient | null = null;

export function getOpenCodeClient(): OpenCodeClient {
  if (!_instance) _instance = new StubOpenCodeClient();
  return _instance;
}

/** For tests / future replacement with the real SDK-backed client. */
export function setOpenCodeClient(client: OpenCodeClient): void {
  _instance = client;
}
