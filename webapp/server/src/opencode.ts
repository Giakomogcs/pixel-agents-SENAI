/**
 * OpenCode runtime integration — backed by `@opencode-ai/sdk` and the
 * `opencode` binary (provided by the `opencode-ai` npm package).
 *
 * On boot we spawn an OpenCode HTTP server (createOpencodeServer) and create
 * a client. A single SSE subscription via client.event.subscribe() routes
 * session-scoped events back to per-session listeners.
 *
 * OAuth: client.provider.oauth.authorize/callback wrap the device flow for
 * the "github-copilot" provider id used by opencode.
 */

import { createOpencodeClient, createOpencodeServer } from '@opencode-ai/sdk';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COPILOT_PROVIDER_ID } from './constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Public types ────────────────────────────────────────────────────────────

export interface OAuthAuthorizeResult {
  /** URL the user must open in a browser (e.g. github.com/login/device). */
  verificationUri: string;
  /** Human-readable code (e.g. "ABCD-1234") if the provider returns one. */
  userCode: string;
  /** Raw instructions string returned by the SDK (kept for diagnostics). */
  instructions: string;
}

export interface OpenCodeSession {
  id: string;
  close(): Promise<void>;
}

export type OpenCodeEvent =
  | { type: 'tool_start'; sessionId: string; toolId: string; tool: string; input?: unknown }
  | { type: 'tool_done'; sessionId: string; toolId: string; output?: string }
  | { type: 'tool_error'; sessionId: string; toolId: string; error: string }
  | { type: 'text_delta'; sessionId: string; text: string }
  | { type: 'turn_end'; sessionId: string }
  | { type: 'permission_request'; sessionId: string; toolId: string };

export type OpenCodeEventHandler = (e: OpenCodeEvent) => void;

export interface OpenCodeClientApi {
  startOAuth(providerId: string): Promise<OAuthAuthorizeResult>;
  pollOAuth(providerId: string): Promise<boolean>;
  isAuthenticated(providerId: string): Promise<boolean>;
  logout(providerId: string): Promise<void>;

  createSession(opts?: { title?: string }): Promise<OpenCodeSession>;
  sendPrompt(
    sessionId: string,
    text: string,
    opts?: { providerId?: string; modelId?: string },
  ): Promise<void>;
  onEvent(sessionId: string, handler: OpenCodeEventHandler): () => void;

  shutdown(): Promise<void>;
}

// ── Implementation ──────────────────────────────────────────────────────────

class RealOpenCodeClient implements OpenCodeClientApi {
  private serverHandle: { url: string; close(): void };
  private sdk: ReturnType<typeof createOpencodeClient>;
  private listeners = new Map<string, Set<OpenCodeEventHandler>>();
  /** Tracks last-seen tool state per (sessionId:callID) to dedupe events. */
  private toolState = new Map<string, 'pending' | 'running' | 'completed'>();
  private subscribed = false;

  constructor(serverHandle: { url: string; close(): void }) {
    this.serverHandle = serverHandle;
    this.sdk = createOpencodeClient({ baseUrl: serverHandle.url });
  }

  // ── OAuth ────────────────────────────────────────────────────────────────

  async startOAuth(providerId: string): Promise<OAuthAuthorizeResult> {
    const res = await this.sdk.provider.oauth.authorize({
      path: { id: providerId },
      body: { method: 0 },
    });
    if (res.error || !res.data) {
      throw new Error(
        `Failed to start OAuth for ${providerId}: ${JSON.stringify(res.error ?? 'no data')}`,
      );
    }
    const { url, instructions } = res.data;
    return { verificationUri: url, userCode: extractUserCode(instructions ?? ''), instructions: instructions ?? '' };
  }

  async pollOAuth(providerId: string): Promise<boolean> {
    try {
      const res = await this.sdk.provider.oauth.callback({
        path: { id: providerId },
        body: { method: 0 },
      });
      if (res.error) {
        const errStr = JSON.stringify(res.error);
        if (/pending|wait|slow_down/i.test(errStr)) return false;
        throw new Error(`OAuth callback failed: ${errStr}`);
      }
      return res.data === true;
    } catch (err) {
      if (/pending|wait|slow_down/i.test((err as Error).message)) return false;
      throw err;
    }
  }

  async isAuthenticated(providerId: string): Promise<boolean> {
    try {
      const res = await this.sdk.provider.list();
      const data = res.data as { providers?: Array<{ id?: string }> } | undefined;
      const providers = data?.providers ?? [];
      return providers.some((p) => p.id === providerId);
    } catch {
      return false;
    }
  }

  async logout(_providerId: string): Promise<void> {
    // Auth tokens live in opencode's own store. The SDK doesn't expose a
    // delete endpoint, so this is a no-op + log. Users can run
    // `opencode auth logout <id>` manually to revoke.
    console.warn(
      '[opencode] logout() is a no-op — run `opencode auth logout <provider>` to revoke.',
    );
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  async createSession(opts: { title?: string } = {}): Promise<OpenCodeSession> {
    const res = await this.sdk.session.create({
      body: { title: opts.title ?? 'Pixel Agent' },
    });
    if (res.error || !res.data) {
      throw new Error(`Failed to create session: ${JSON.stringify(res.error ?? 'no data')}`);
    }
    const id = res.data.id;
    const sdk = this.sdk;
    const listeners = this.listeners;
    return {
      id,
      close: async () => {
        try {
          await sdk.session.delete({ path: { id } });
        } catch (err) {
          console.warn(`[opencode] session.delete failed for ${id}:`, err);
        }
        listeners.delete(id);
      },
    };
  }

  async sendPrompt(
    sessionId: string,
    text: string,
    opts: { providerId?: string; modelId?: string } = {},
  ): Promise<void> {
    const body: Parameters<typeof this.sdk.session.prompt>[0]['body'] = {
      parts: [{ type: 'text', text }],
    };
    if (opts.providerId && opts.modelId) {
      body.model = { providerID: opts.providerId, modelID: opts.modelId };
    }
    // Don't await the entire turn — events stream via SSE.
    void this.sdk.session.prompt({ path: { id: sessionId }, body }).catch((err) => {
      console.error(`[opencode] prompt failed for ${sessionId}:`, err);
    });
  }

  onEvent(sessionId: string, handler: OpenCodeEventHandler): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(handler);
    void this.ensureSubscribed();
    return () => {
      set?.delete(handler);
    };
  }

  private async ensureSubscribed(): Promise<void> {
    if (this.subscribed) return;
    this.subscribed = true;
    void this.runEventLoop().catch((err) => {
      console.error('[opencode] event loop crashed:', err);
      this.subscribed = false;
      // Retry after a short delay so transient failures self-heal.
      setTimeout(() => void this.ensureSubscribed(), 1000);
    });
  }

  private async runEventLoop(): Promise<void> {
    const sub = await this.sdk.event.subscribe();
    const stream = (sub as { stream?: AsyncIterable<unknown> }).stream;
    if (!stream) return;
    for await (const ev of stream) {
      this.dispatchEvent(ev);
    }
    // Stream ended — schedule a reconnect.
    this.subscribed = false;
    setTimeout(() => void this.ensureSubscribed(), 1000);
  }

  private dispatchEvent(raw: unknown): void {
    const ev = raw as { type?: string; properties?: Record<string, unknown> };
    if (!ev.type || !ev.properties) return;

    switch (ev.type) {
      case 'message.part.updated': {
        const part = ev.properties.part as
          | {
              type: string;
              sessionID: string;
              tool?: string;
              callID?: string;
              state?: { status: string; output?: string; error?: string; input?: unknown };
              text?: string;
            }
          | undefined;
        const delta = ev.properties.delta as string | undefined;
        if (!part) return;

        if (part.type === 'tool' && part.callID && part.state) {
          const key = `${part.sessionID}:${part.callID}`;
          const prev = this.toolState.get(key);
          if (part.state.status === 'running' && prev !== 'running' && prev !== 'completed') {
            this.toolState.set(key, 'running');
            this.emit(part.sessionID, {
              type: 'tool_start',
              sessionId: part.sessionID,
              toolId: part.callID,
              tool: part.tool ?? 'unknown',
              input: part.state.input,
            });
          } else if (part.state.status === 'completed' && prev !== 'completed') {
            this.toolState.set(key, 'completed');
            this.emit(part.sessionID, {
              type: 'tool_done',
              sessionId: part.sessionID,
              toolId: part.callID,
              output: part.state.output,
            });
          } else if (part.state.status === 'error') {
            this.emit(part.sessionID, {
              type: 'tool_error',
              sessionId: part.sessionID,
              toolId: part.callID,
              error: part.state.error ?? 'unknown error',
            });
          }
        } else if (part.type === 'text' && delta) {
          this.emit(part.sessionID, {
            type: 'text_delta',
            sessionId: part.sessionID,
            text: delta,
          });
        }
        break;
      }

      case 'session.idle': {
        const sessionID = ev.properties.sessionID as string | undefined;
        if (sessionID) this.emit(sessionID, { type: 'turn_end', sessionId: sessionID });
        break;
      }

      case 'permission.updated': {
        const perm = ev.properties as { sessionID?: string; callID?: string; id?: string };
        if (perm.sessionID) {
          this.emit(perm.sessionID, {
            type: 'permission_request',
            sessionId: perm.sessionID,
            toolId: perm.callID ?? perm.id ?? 'unknown',
          });
        }
        break;
      }

      default:
        break;
    }
  }

  private emit(sessionId: string, event: OpenCodeEvent): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch (err) {
        console.warn('[opencode] event handler threw:', err);
      }
    }
  }

  async shutdown(): Promise<void> {
    try {
      this.serverHandle.close();
    } catch {
      /* already closed */
    }
  }
}

function extractUserCode(instructions: string): string {
  // GitHub device codes look like "ABCD-1234". Try to extract any
  // hyphen-grouped uppercase alphanumeric token.
  const m = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(instructions);
  return m ? m[1] : '';
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

let _instance: OpenCodeClientApi | null = null;
let _initPromise: Promise<OpenCodeClientApi> | null = null;

export async function initOpenCode(): Promise<OpenCodeClientApi> {
  if (_instance) return _instance;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    // Make sure the bundled `opencode` binary in node_modules/.bin is found.
    const binDir = path.resolve(__dirname, '..', '..', 'node_modules', '.bin');
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;

    const handle = await createOpencodeServer({
      hostname: '127.0.0.1',
      port: 0, // let the OS pick
      timeout: 30000,
      config: { logLevel: 'INFO' },
    });
    console.log(`[opencode] server up at ${handle.url}`);
    _instance = new RealOpenCodeClient(handle);
    return _instance;
  })();

  try {
    return await _initPromise;
  } catch (err) {
    _initPromise = null;
    throw err;
  }
}

export function getOpenCodeClient(): OpenCodeClientApi {
  if (!_instance) {
    throw new Error('OpenCode client not initialized — call initOpenCode() at boot.');
  }
  return _instance;
}

export { COPILOT_PROVIDER_ID };
