/**
 * AgentManager — owns the in-memory roster of agents (each backed by an
 * OpenCode session). Maps OpenCode events to ServerMessages the webview
 * already understands.
 */

import type { ServerMessage } from '@pixel-agents/protocol';

import { getOpenCodeClient, type OpenCodeEvent, type OpenCodeSession } from './opencode.js';
import { type AgentsState, readAgents, writeAgents } from './persistence.js';

export interface RuntimeAgent {
  id: number;
  name: string;
  session: OpenCodeSession;
  palette: number;
  hueShift: number;
  seatId: string | null;
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

  emitExisting(): void {
    this.broadcast({
      type: 'existingAgents',
      agents: this.state.agents.map((a) => ({
        id: a.id,
        name: a.name,
        palette: a.palette,
        hueShift: a.hueShift,
        seatId: a.seatId,
      })),
    });
  }

  async spawn(): Promise<RuntimeAgent | null> {
    const client = getOpenCodeClient();
    if (!(await client.isAuthenticated('copilot'))) {
      this.broadcast({
        type: 'log',
        level: 'warn',
        message: 'Cannot spawn agent: Copilot is not authenticated. Open Settings → Copilot.',
      });
      return null;
    }

    const id = this.state.nextId++;
    let session: OpenCodeSession;
    try {
      session = await client.createSession('copilot');
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
      name: `Agent ${id.toString()}`,
      session,
      palette: id % 6,
      hueShift: 0,
      seatId: null,
    };
    this.agents.set(id, agent);

    client.onEvent(session.id, (e) => this.handleEvent(agent, e));

    this.state.agents.push({
      id: agent.id,
      sessionId: session.id,
      name: agent.name,
      palette: agent.palette,
      hueShift: agent.hueShift,
      seatId: agent.seatId,
    });
    await writeAgents(this.state);

    this.broadcast({
      type: 'agentCreated',
      id: agent.id,
      name: agent.name,
      palette: agent.palette,
      hueShift: agent.hueShift,
      seatId: agent.seatId,
    });
    return agent;
  }

  async close(id: number): Promise<void> {
    const agent = this.agents.get(id);
    if (agent) {
      try {
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
    if (!agent) return;
    await getOpenCodeClient().sendPrompt(agent.session.id, text);
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
        break;
      case 'text_delta':
        // Future: forward streaming text to a chat panel.
        break;
    }
  }
}
