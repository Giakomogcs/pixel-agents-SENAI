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

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOpencodeClient, createOpencodeServer } from '@opencode-ai/sdk';

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

export interface ProviderInfo {
  id: string;
  name: string;
  models: { id: string; name: string }[];
}

export interface OpenCodeClientApi {
  startOAuth(providerId: string): Promise<OAuthAuthorizeResult>;
  pollOAuth(providerId: string): Promise<boolean>;
  isAuthenticated(providerId: string): Promise<boolean>;
  logout(providerId: string): Promise<void>;
  /**
   * Register a callback invoked when the (single) background OAuth device-flow
   * `callback` resolves — i.e. the user has approved on github.com and a
   * token has been stored. Used to push `copilotAuthComplete` immediately
   * instead of waiting for the next poll tick.
   */
  onAuthComplete(handler: (providerId: string, ok: boolean) => void): () => void;

  listProviders(): Promise<{ providers: ProviderInfo[]; defaultProviderId: string; defaultModelId: string }>;

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

  /**
   * Background callback promises per provider. The opencode-ai
   * `provider.oauth.callback` endpoint for the GitHub Copilot device flow
   * is a SINGLE long-running call: it loops internally polling GitHub's
   * token endpoint until the user types the code on github.com/login/device
   * and approves. We must trigger it exactly ONCE per `authorize` — calling
   * it repeatedly each tick spawns competing polls and never resolves the
   * UI. `pollOAuth` then just checks `isAuthenticated()`.
   */
  private pendingCallbacks = new Map<string, Promise<boolean>>();
  private callbackMethodIndex = new Map<string, number>();
  private authCompleteHandlers = new Set<(providerId: string, ok: boolean) => void>();

  onAuthComplete(handler: (providerId: string, ok: boolean) => void): () => void {
    this.authCompleteHandlers.add(handler);
    return () => {
      this.authCompleteHandlers.delete(handler);
    };
  }

  async startOAuth(providerId: string): Promise<OAuthAuthorizeResult> {
    // Discover which method index corresponds to OAuth for this provider.
    // Hardcoding 0 is fragile because providers may expose multiple auth
    // methods (e.g. "OAuth" + "API key") in any order.
    let method = 0;
    try {
      const methodsRes = (await this.sdk.provider.auth()) as {
        data?: Record<string, { type: string; label: string }[]>;
      };
      const methods = methodsRes.data?.[providerId] ?? [];
      console.log(
        `[opencode] auth methods for ${providerId}:`,
        methods.map((m, i) => `${i.toString()}=${m.type}:${m.label}`).join(', ') || '(none)',
      );
      const idx = methods.findIndex((m) => m.type === 'oauth');
      if (idx >= 0) method = idx;
    } catch (err) {
      console.warn(`[opencode] failed to list auth methods for ${providerId}:`, err);
    }

    const res = await this.sdk.provider.oauth.authorize({
      path: { id: providerId },
      body: { method },
    });
    if (res.error || !res.data) {
      throw new Error(
        `Failed to start OAuth for ${providerId}: ${JSON.stringify(res.error ?? 'no data')}`,
      );
    }
    const { url, instructions } = res.data;
    console.log(`[opencode] authorize OK provider=${providerId} method=${method.toString()} url=${url}`);

    // Kick off the (single, long-running) device-flow poll in the background.
    // It resolves when the user approves on GitHub and the token is stored.
    this.callbackMethodIndex.set(providerId, method);
    this.startCallbackLoop(providerId, method);

    return { verificationUri: url, userCode: extractUserCode(instructions ?? ''), instructions: instructions ?? '' };
  }

  private startCallbackLoop(providerId: string, method: number): void {
    // If a prior callback is already in-flight (e.g. retry after refresh),
    // don't stack a second one — the opencode server only holds ONE pending
    // entry per provider and a second authorize would have replaced it.
    if (this.pendingCallbacks.has(providerId)) return;

    const promise = (async () => {
      try {
        console.log(`[opencode] oauth.callback START provider=${providerId} method=${method.toString()}`);
        const res = (await this.sdk.provider.oauth.callback({
          path: { id: providerId },
          body: { method },
        })) as { error?: unknown; data?: unknown; response?: { status?: number } };
        console.log(
          `[opencode] oauth.callback RESPONSE provider=${providerId}`,
          'status=', res.response?.status,
          'data=', JSON.stringify(res.data),
          'error=', JSON.stringify(res.error),
        );
        if (res.error) {
          console.warn(`[opencode] oauth.callback for ${providerId} errored:`, res.error);
          return false;
        }
        const ok = await this.isAuthenticated(providerId);
        console.log(`[opencode] isAuthenticated(${providerId}) → ${String(ok)}`);
        return ok;
      } catch (err) {
        console.warn(`[opencode] oauth.callback for ${providerId} threw:`, err);
        return false;
      } finally {
        this.pendingCallbacks.delete(providerId);
      }
    })();
    this.pendingCallbacks.set(providerId, promise);
    void promise.then((ok) => {
      for (const h of this.authCompleteHandlers) {
        try {
          h(providerId, ok);
        } catch (err) {
          console.warn('[opencode] authComplete handler threw:', err);
        }
      }
    });
  }

  async pollOAuth(providerId: string): Promise<boolean> {
    // The authoritative signal — the background `callback` updates the
    // opencode auth store, which makes `provider.list().connected` include
    // this provider. We never call `callback` from here.
    return this.isAuthenticated(providerId);
  }

  async isAuthenticated(providerId: string): Promise<boolean> {
    try {
      const res = await this.sdk.provider.list();
      const data = res.data as { connected?: string[] } | undefined;
      const connected = data?.connected ?? [];
      return connected.includes(providerId);
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

  // ── Providers / models ─────────────────────────────────────────

  async listProviders(): Promise<{
    providers: ProviderInfo[];
    defaultProviderId: string;
    defaultModelId: string;
  }> {
    let providers: ProviderInfo[] = [];
    let defaultProviderId = COPILOT_PROVIDER_ID;
    let defaultModelId = 'claude-sonnet-4';
    try {
      const res = await this.sdk.provider.list();
      const data = res.data as
        | {
            all?: { id: string; name: string; models?: Record<string, { id?: string; name?: string }> }[];
            default?: Record<string, string>;
            connected?: string[];
          }
        | undefined;

      const all = data?.all ?? [];
      const connected = new Set(data?.connected ?? []);
      const def = data?.default ?? {};

      // Only surface providers that are authenticated. Falls back to all if
      // the server doesn't report `connected` (older builds).
      const visible = connected.size > 0 ? all.filter((p) => connected.has(p.id)) : all;

      providers = visible.map((p) => {
        const models = Object.entries(p.models ?? {}).map(([mKey, m]) => ({
          id: m?.id ?? mKey,
          name: m?.name ?? m?.id ?? mKey,
        }));
        return { id: p.id, name: p.name, models };
      });

      // Pick a sensible default: prefer Copilot if connected, else the first.
      const preferred = providers.find((p) => p.id === COPILOT_PROVIDER_ID) ?? providers[0];
      if (preferred) {
        defaultProviderId = preferred.id;
        defaultModelId =
          def[preferred.id] ??
          preferred.models.find((m) => /sonnet/i.test(m.id))?.id ??
          preferred.models[0]?.id ??
          defaultModelId;
      }
    } catch (err) {
      console.warn('[opencode] listProviders failed:', err);
    }

    if (providers.length === 0) {
      // Fallback so the UI is still usable before/without OpenCode being fully ready.
      providers = [
        {
          id: COPILOT_PROVIDER_ID,
          name: 'GitHub Copilot',
          models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }],
        },
      ];
    }
    return { providers, defaultProviderId, defaultModelId };
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
    // Don't await the entire turn — events stream via SSE. But we DO need to
    // await the HTTP request itself so failures (bad model id, missing auth,
    // 400/404) propagate to the caller, who logs them to the UI. The SDK
    // doesn't reject on error; it returns { data, error }.
    try {
      const res = (await this.sdk.session.prompt({ path: { id: sessionId }, body })) as {
        error?: unknown;
        data?: unknown;
      };
      if (res.error) {
        const errStr = typeof res.error === 'string' ? res.error : JSON.stringify(res.error);
        throw new Error(`session.prompt error: ${errStr}`);
      }
    } catch (err) {
      console.error(`[opencode] prompt failed for ${sessionId}:`, err);
      throw err;
    }
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
