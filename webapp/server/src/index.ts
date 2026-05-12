/**
 * Pixel Agents — standalone web server.
 *
 *  - HTTP: serves the built web app (apps/web/dist) in production
 *  - WS  : protocol bridge between the browser UI and OpenCode
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { ClientMessage } from '@pixel-agents/protocol';
import Fastify from 'fastify';

import { AgentManager } from './agents.js';
import { loadAssetBundle, resolveAssetsDir } from './assets.js';
import { bootstrapFactoryAgents, startAutoDemo, watchFactoryState } from './factory.js';
import { initOpenCode } from './opencode.js';
import { handleClientMessage, WsHub } from './ws.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 5179);
const HOST = process.env.HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(fastifyWebsocket);

  // ── Boot subsystems ────────────────────────────────────────────────────────
  const assetsDir = resolveAssetsDir();
  app.log.info({ assetsDir }, 'loading assets');
  const assets = loadAssetBundle(assetsDir);
  app.log.info(
    {
      characters: assets.characters.length,
      floors: assets.floorSprites.length,
      walls: assets.wallSets.length,
      furniture: assets.catalog.length,
    },
    'assets loaded',
  );

  const hub = new WsHub();
  const agents = new AgentManager((msg) => hub.broadcast(msg));
  await agents.init();

  // Boot the OpenCode runtime in the background — it spawns the `opencode`
  // binary which can take a few seconds. We don't block server startup so
  // the UI can show a "connecting…" state. WS handlers that need the client
  // will throw a clear error until init completes.
  initOpenCode()
    .then(async (client) => {
      app.log.info('opencode runtime ready');

      // Push auth status to all clients as soon as the device-flow background
      // callback resolves — avoids waiting for the next 2s frontend poll tick.
      client.onAuthComplete((providerId, ok) => {
        app.log.info({ providerId, ok }, 'oauth completed');
        if (ok) {
          hub.broadcast({ type: 'copilotAuthComplete' });
          hub.broadcast({ type: 'copilotStatus', authenticated: true });
          // Auth just succeeded — (re)spawn any factory agents that were
          // skipped because Copilot wasn't ready during the initial bootstrap.
          // bootstrapFactoryAgents is idempotent (tracks `bootstrappedKeys`).
          bootstrapFactoryAgents(agents, (msg) => hub.broadcast(msg))
            .then(() => app.log.info('factory agents bootstrapped (post-auth)'))
            .catch((err: unknown) =>
              app.log.error({ err }, 'bootstrapFactoryAgents post-auth failed'),
            );
        } else {
          hub.broadcast({ type: 'copilotAuthError', error: 'OAuth flow did not complete. Try again.' });
        }
      });

      try {
        await agents.reattachPersisted();
      } catch (err) {
        app.log.error({ err }, 'reattachPersisted failed');
      }
      try {
        await bootstrapFactoryAgents(agents, (msg) => hub.broadcast(msg));
        app.log.info('factory agents bootstrapped');
      } catch (err) {
        app.log.error({ err }, 'bootstrapFactoryAgents failed');
      }
      startAutoDemo(agents, (msg) => hub.broadcast(msg));
    })
    .catch((err: unknown) => app.log.error({ err }, 'opencode runtime failed to start'));

  // Start watching factory-state/ regardless of OpenCode readiness — the TV
  // and tablet must still see the seed state even before Copilot auth.
  watchFactoryState((msg) => hub.broadcast(msg));

  // ── HTTP routes ────────────────────────────────────────────────────────────
  app.get('/api/health', async () => ({
    ok: true,
    version: '0.1.0-webapp',
    agents: 0,
  }));

  // Static: built web app (only if it exists — dev uses Vite directly).
  const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.log.info({ webDist }, 'serving built web app');
  } else {
    app.log.info('web/dist not found — assuming Vite dev server is on a separate port');
    app.get('/', async (_, reply) => {
      reply
        .type('text/html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>Pixel Agents Server</title>
           <body style="font-family:sans-serif;padding:2em">
           <h1>Pixel Agents server is running</h1>
           <p>WebSocket endpoint: <code>ws://${HOST}:${PORT.toString()}/ws</code></p>
           <p>Run the web app with <code>npm run dev:web</code> and open it.</p>
           </body>`,
        );
    });
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────
  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket /* , req */) => {
      hub.add(socket);
      app.log.info('ws connected');

      socket.on('message', (raw: Buffer) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(raw.toString()) as ClientMessage;
        } catch (err) {
          app.log.warn({ err }, 'invalid ws payload');
          return;
        }
        void handleClientMessage(msg, socket, { hub, agents, assets, assetsDir }).catch((err) => {
          app.log.error({ err, msgType: msg.type }, 'handler failed');
        });
      });

      socket.on('close', () => {
        hub.remove(socket);
        app.log.info('ws disconnected');
      });
    });
  });

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`listening on http://${HOST}:${PORT.toString()}  (ws: /ws)`);
}

main().catch((err: unknown) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
