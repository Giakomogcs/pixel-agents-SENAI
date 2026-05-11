/**
 * AgentManager — owns the in-memory roster of agents (each backed by an
 * OpenCode session). Maps OpenCode events to ServerMessages the webview
 * already understands.
 */

import type { ServerMessage } from '@pixel-agents/protocol';

import { COPILOT_DEFAULT_MODEL,COPILOT_PROVIDER_ID } from './constants.js';
import { getOpenCodeClient, type OpenCodeEvent, type OpenCodeSession } from './opencode.js';
import { type AgentsState, readAgents, writeAgents } from './persistence.js';

export interface RuntimeAgent {
  id: number;
  name: string;
  session: OpenCodeSession;
  unsubscribe: () => void;
  palette: number;
  hueShift: number;
  seatId: string | null;
  providerId: string;
  modelId: string;
}

export interface SpawnOptions {
  name?: string;
  prompt?: string;
  providerId?: string;
  modelId?: string;
}

type Broadcast = (msg: ServerMessage) => void;

export class AgentManager {
  private agents = new Map<number, RuntimeAgent>();
  private state: AgentsState = { nextId: 1, agents: [] };

  constructor(private broadcast: Broadcast) {}

  async init(): Promise<void> {
    this.state = await readAgents();
    // Note: we do NOT auto-spawn sessions here. After the webview connects we
    // emit the persisted agents (without live OpenCode sessions). The user
    // can re-spawn or remove them via the UI. This keeps boot fast and
    // avoids surprising the user with new Copilot calls.
  }

  /**
   * Re-subscribe to OpenCode events for every persisted agent so they keep
   * streaming after a server restart. Safe to call multiple times — agents
   * already in `this.agents` are skipped. Requires the OpenCode client to be
   * ready and Copilot to be authenticated.
   */
  async reattachPersisted(): Promise<void> {
    let client;
    try {
      client = getOpenCodeClient();
    } catch {
      return; // OpenCode not booted yet — caller can retry later.
    }
    if (!(await client.isAuthenticated(COPILOT_PROVIDER_ID))) return;

    for (const persisted of this.state.agents) {
      if (this.agents.has(persisted.id)) continue;
      if (!persisted.sessionId) continue; // legacy entry without a session
      const sessionId = persisted.sessionId;
      const session = {
        id: sessionId,
        close: async () => {
          /* OpenCode session lifecycle is managed elsewhere on re-attach */
        },
      };
      const agent: RuntimeAgent = {
        id: persisted.id,
        name: persisted.name,
        session,
        unsubscribe: () => undefined,
        palette: persisted.palette,
        hueShift: persisted.hueShift,
        seatId: persisted.seatId,
        providerId: persisted.providerId ?? COPILOT_PROVIDER_ID,
        modelId: persisted.modelId ?? COPILOT_DEFAULT_MODEL,
      };
      this.agents.set(agent.id, agent);
      agent.unsubscribe = client.onEvent(sessionId, (e) => this.handleEvent(agent, e));
    }
    if (this.state.agents.length > 0) {
      this.broadcast({
        type: 'log',
        level: 'info',
        message: `Reattached ${this.state.agents.length.toString()} persisted agent session(s).`,
      });
    }
  }

  emitExisting(): void {
    const agentMeta: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {};
    const folderNames: Record<number, string> = {};
    for (const a of this.state.agents) {
      agentMeta[a.id] = { palette: a.palette, hueShift: a.hueShift, seatId: a.seatId };
      folderNames[a.id] = a.name;
    }
    this.broadcast({
      type: 'existingAgents',
      agents: this.state.agents.map((a) => a.id),
      agentMeta,
      folderNames,
    });
  }

  async spawn(opts: SpawnOptions = {}): Promise<RuntimeAgent | null> {
    const client = getOpenCodeClient();
    if (!(await client.isAuthenticated(COPILOT_PROVIDER_ID))) {
      this.broadcast({
        type: 'log',
        level: 'warn',
        message: 'Cannot spawn agent: Copilot is not authenticated. Open Settings → Connect Copilot.',
      });
      return null;
    }

    const id = this.state.nextId++;
    const name = (opts.name?.trim() || `Agent ${id.toString()}`);
    const providerId = opts.providerId || COPILOT_PROVIDER_ID;
    const modelId = opts.modelId || COPILOT_DEFAULT_MODEL;

    let session: OpenCodeSession;
    try {
      session = await client.createSession({ title: name });
    } catch (err) {
      this.broadcast({
        type: 'log',
        level: 'error',
        message: `Failed to create OpenCode session: ${(err as Error).message}`,
      });
      return null;
    }

    const agent: RuntimeAgent = {
      id,
      name,
      session,
      unsubscribe: () => undefined,
      palette: id % 6,
      hueShift: 0,
      seatId: null,
      providerId,
      modelId,
    };
    this.agents.set(id, agent);

    agent.unsubscribe = client.onEvent(session.id, (e) => this.handleEvent(agent, e));

    this.state.agents.push({
      id: agent.id,
      sessionId: session.id,
      name: agent.name,
      palette: agent.palette,
      hueShift: agent.hueShift,
      seatId: agent.seatId,
      providerId: agent.providerId,
      modelId: agent.modelId,
    });
    await writeAgents(this.state);

    this.broadcast({
      type: 'agentCreated',
      id: agent.id,
      name: agent.name,
      folderName: agent.name,
      palette: agent.palette,
      hueShift: agent.hueShift,
      seatId: agent.seatId,
      providerId: agent.providerId,
      modelId: agent.modelId,
    });

    const initialPrompt = opts.prompt?.trim();
    if (initialPrompt) {
      this.broadcast({
        type: 'log',
        level: 'info',
        message: `Sending initial prompt to "${name}" via ${providerId}/${modelId} (${initialPrompt.length.toString()} chars)`,
      });
      this.broadcast({ type: 'agentMessage', agentId: agent.id, role: 'user', text: initialPrompt, final: true });
      try {
        await client.sendPrompt(session.id, initialPrompt, { providerId, modelId });
        this.broadcast({ type: 'agentStatus', id: agent.id, status: 'active' });
      } catch (err) {
        this.broadcast({
          type: 'log',
          level: 'error',
          message: `Initial prompt failed for "${name}" (${providerId}/${modelId}): ${(err as Error).message}`,
        });
      }
    }
    return agent;
  }

  async close(id: number): Promise<void> {
    const agent = this.agents.get(id);
    if (agent) {
      try {
        agent.unsubscribe();
        await agent.session.close();
      } catch (err) {
        console.warn(`[agents] close() failed for ${id.toString()}:`, err);
      }
      this.agents.delete(id);
    }
    this.state.agents = this.state.agents.filter((a) => a.id !== id);
    await writeAgents(this.state);
    this.broadcast({ type: 'agentClosed', id });
  }

  async sendPrompt(id: number, text: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) {
      this.broadcast({
        type: 'log',
        level: 'warn',
        message: `sendPrompt: no live agent with id ${id.toString()}`,
      });
      return;
    }
    this.broadcast({ type: 'agentMessage', agentId: id, role: 'user', text, final: true });
    try {
      await getOpenCodeClient().sendPrompt(agent.session.id, text, {
        providerId: agent.providerId,
        modelId: agent.modelId,
      });
      this.broadcast({ type: 'agentStatus', id, status: 'active' });
    } catch (err) {
      this.broadcast({
        type: 'log',
        level: 'error',
        message: `Prompt failed for "${agent.name}" (${agent.providerId}/${agent.modelId}): ${(err as Error).message}`,
      });
    }
  }

  async saveSeats(
    seats: Record<number, { palette: number; hueShift: number; seatId: string | null }>,
  ): Promise<void> {
    for (const [idStr, info] of Object.entries(seats)) {
      const id = Number(idStr);
      const persisted = this.state.agents.find((a) => a.id === id);
      if (persisted) {
        persisted.palette = info.palette;
        persisted.hueShift = info.hueShift;
        persisted.seatId = info.seatId;
      }
      const live = this.agents.get(id);
      if (live) {
        live.palette = info.palette;
        live.hueShift = info.hueShift;
        live.seatId = info.seatId;
      }
    }
    await writeAgents(this.state);
  }

  // ── Event translation ──────────────────────────────────────────────────────

  private handleEvent(agent: RuntimeAgent, e: OpenCodeEvent): void {
    switch (e.type) {
      case 'tool_start':
        this.broadcast({
          type: 'agentToolStart',
          id: agent.id,
          toolId: e.toolId ?? 'unknown',
          tool: e.tool ?? 'unknown',
          input: e.input,
        });
        this.broadcast({ type: 'agentStatus', id: agent.id, status: 'active' });
        break;
      case 'tool_done':
        this.broadcast({
          type: 'agentToolDone',
          id: agent.id,
          toolId: e.toolId ?? 'unknown',
        });
        break;
      case 'permission_request':
        this.broadcast({
          type: 'agentToolPermission',
          id: agent.id,
          toolId: e.toolId ?? 'unknown',
        });
        break;
      case 'turn_end':
        this.broadcast({ type: 'agentToolsClear', id: agent.id });
        this.broadcast({ type: 'agentStatus', id: agent.id, status: 'waiting' });
        this.broadcast({ type: 'agentMessage', agentId: agent.id, role: 'assistant', text: '', final: true });
        this.broadcast({ type: 'agentTurnEnd', agentId: agent.id });
        break;
      case 'text_delta':
        // Stream assistant text deltas to the chat panel. The webview
        // accumulates them keyed by agentId until `final: true` lands.
        if (e.text) {
          this.broadcast({
            type: 'agentMessage',
            agentId: agent.id,
            role: 'assistant',
            text: e.text,
          });
        }
        break;
    }
  }
}
