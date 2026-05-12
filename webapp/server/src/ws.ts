/**
 * WebSocket router — receives ClientMessages from the browser and dispatches
 * to the appropriate subsystem (agents, persistence, OAuth). Per-connection
 * fan-out is centralized via the broadcaster so the AgentManager doesn't
 * have to track sockets.
 */

import type { WebSocket } from '@fastify/websocket';
import type { ClientMessage, ServerMessage } from '@pixel-agents/protocol';

import type { AgentManager } from './agents.js';
import type { AssetBundle } from './assets.js';
import { COPILOT_PROVIDER_ID } from './constants.js';
import {
  markFactoryActivity,
  readFactoryState,
  resetFactoryState,
  runPedidoScenario,
} from './factory.js';
import { getOpenCodeClient, type OpenCodeClientApi } from './opencode.js';
import { APP_VERSION } from './paths.js';

/** Safely fetch the OpenCode client; returns null if it's still booting. */
function tryGetClient(): OpenCodeClientApi | null {
  try {
    return getOpenCodeClient();
  } catch {
    return null;
  }
}
import {
  patchConfig,
  readConfig,
  readLayout,
  readLayoutOrDefault,
  writeLayout,
} from './persistence.js';

export class WsHub {
  private sockets = new Set<WebSocket>();

  add(ws: WebSocket): void {
    this.sockets.add(ws);
  }
  remove(ws: WebSocket): void {
    this.sockets.delete(ws);
  }
  broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.sockets) {
      try {
        ws.send(payload);
      } catch {
        /* socket closed */
      }
    }
  }
  send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket closed */
    }
  }
}

interface RouterDeps {
  hub: WsHub;
  agents: AgentManager;
  assets: AssetBundle;
  assetsDir: string;
}

export async function handleClientMessage(
  msg: ClientMessage,
  ws: WebSocket,
  deps: RouterDeps,
): Promise<void> {
  const { hub, agents, assets, assetsDir } = deps;

  switch (msg.type) {
    case 'webviewReady': {
      // Ship the same boot sequence the extension does, in the documented
      // order: characters → floors → walls → furniture → layout → settings.
      hub.send(ws, { type: 'characterSpritesLoaded', characters: assets.characters });
      hub.send(ws, { type: 'floorTilesLoaded', sprites: assets.floorSprites });
      hub.send(ws, { type: 'wallTilesLoaded', sets: assets.wallSets });
      hub.send(ws, {
        type: 'furnitureAssetsLoaded',
        catalog: assets.catalog,
        sprites: assets.furnitureSprites,
      });
      const layout = await readLayoutOrDefault(assetsDir);
      hub.send(ws, { type: 'layoutLoaded', layout });
      const cfg = await readConfig();
      hub.send(ws, {
        type: 'settingsLoaded',
        soundEnabled: cfg.soundEnabled,
        alwaysShowLabels: cfg.alwaysShowLabels,
        watchAllSessions: cfg.watchAllSessions,
        hooksEnabled: cfg.hooksEnabled,
        hooksInfoShown: cfg.hooksInfoShown,
        externalAssetDirectories: cfg.externalAssetDirectories,
        extensionVersion: APP_VERSION,
        lastSeenVersion: cfg.lastSeenVersion,
      });
      hub.send(ws, { type: 'workspaceFolders', folders: [] });
      agents.emitExisting();
      const authClient = tryGetClient();
      const authed = authClient ? await authClient.isAuthenticated(COPILOT_PROVIDER_ID) : false;
      hub.send(ws, { type: 'copilotStatus', authenticated: authed });
      break;
    }

    case 'openClaude': {
      // Legacy "+ Agent" path — spawn with defaults. Newer UI uses createAgent.
      await agents.spawn();
      break;
    }

    case 'createAgent': {
      await agents.spawn({
        name: msg.name,
        prompt: msg.prompt,
        providerId: msg.providerId,
        modelId: msg.modelId,
      });
      break;
    }

    case 'listModels': {
      const client = tryGetClient();
      if (!client) {
        // Send a minimal fallback so the UI is not stuck.
        hub.send(ws, {
          type: 'modelsLoaded',
          providers: [
            {
              id: COPILOT_PROVIDER_ID,
              name: 'GitHub Copilot',
              models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }],
            },
          ],
          defaultProviderId: COPILOT_PROVIDER_ID,
          defaultModelId: 'claude-sonnet-4',
        });
        break;
      }
      const info = await client.listProviders();
      hub.send(ws, { type: 'modelsLoaded', ...info });
      break;
    }

    case 'closeAgent': {
      await agents.close(msg.id);
      break;
    }

    case 'sendPrompt': {
      await agents.sendPrompt(msg.agentId, msg.text);
      break;
    }

    case 'focusAgent': {
      hub.broadcast({ type: 'agentSelected', id: msg.id });
      break;
    }

    case 'saveLayout': {
      await writeLayout(msg.layout);
      break;
    }

    case 'saveAgentSeats': {
      await agents.saveSeats(msg.seats);
      break;
    }

    case 'setSoundEnabled':
      await patchConfig({ soundEnabled: msg.enabled });
      break;
    case 'setAlwaysShowLabels':
      await patchConfig({ alwaysShowLabels: msg.enabled });
      break;
    case 'setWatchAllSessions':
      await patchConfig({ watchAllSessions: msg.enabled });
      break;
    case 'setHooksEnabled':
      await patchConfig({ hooksEnabled: msg.enabled });
      break;
    case 'setHooksInfoShown':
      await patchConfig({ hooksInfoShown: true });
      break;
    case 'setLastSeenVersion':
      await patchConfig({ lastSeenVersion: msg.version });
      break;

    case 'startCopilotAuth': {
      const client = tryGetClient();
      if (!client) {
        hub.send(ws, { type: 'copilotAuthError', error: 'OpenCode runtime is still starting up. Try again in a moment.' });
        break;
      }
      try {
        const r = await client.startOAuth(COPILOT_PROVIDER_ID);
        hub.send(ws, {
          type: 'copilotAuthCode',
          userCode: r.userCode,
          verificationUri: r.verificationUri,
          expiresIn: 900,
          interval: 5,
        });
      } catch (err) {
        hub.send(ws, { type: 'copilotAuthError', error: (err as Error).message });
      }
      break;
    }

    case 'pollCopilotAuth': {
      const client = tryGetClient();
      if (!client) {
        hub.send(ws, { type: 'copilotAuthPending' });
        break;
      }
      try {
        const done = await client.pollOAuth(COPILOT_PROVIDER_ID);
        if (done) {
          hub.broadcast({ type: 'copilotAuthComplete' });
          hub.broadcast({ type: 'copilotStatus', authenticated: true });
        } else {
          hub.send(ws, { type: 'copilotAuthPending' });
        }
      } catch (err) {
        hub.send(ws, { type: 'copilotAuthError', error: (err as Error).message });
      }
      break;
    }

    case 'logoutCopilot': {
      const client = tryGetClient();
      if (client) await client.logout(COPILOT_PROVIDER_ID);
      hub.broadcast({ type: 'copilotStatus', authenticated: false });
      break;
    }

    case 'getCopilotStatus': {
      const client = tryGetClient();
      const authed = client ? await client.isAuthenticated(COPILOT_PROVIDER_ID) : false;
      hub.send(ws, { type: 'copilotStatus', authenticated: authed });
      break;
    }

    case 'requestDiagnostics':
    case 'exportLayout':
    case 'importLayout':
    case 'addExternalAssetDirectory':
    case 'removeExternalAssetDirectory':
    case 'openSessionsFolder':
      // No-op (or future impl). Prevent runtime errors by acknowledging.
      hub.send(ws, {
        type: 'log',
        level: 'info',
        message: `[webapp] ${msg.type} not implemented yet`,
      });
      break;

    case 'factoryScenario': {
      if (msg.scenario === 'pedido') {
        await runPedidoScenario(agents, msg.sku, msg.qty, (m) => hub.broadcast(m));
      }
      break;
    }

    case 'factoryReset': {
      await resetFactoryState();
      markFactoryActivity();
      const state = await readFactoryState();
      hub.broadcast({ type: 'factoryState', ...state });
      break;
    }

    case 'factoryGetState': {
      const state = await readFactoryState();
      hub.send(ws, { type: 'factoryState', ...state });
      break;
    }

    default: {
      const _exhaustive: never = msg;
      void _exhaustive;
    }
  }
}
