/**
 * Pixel Agents — standalone web server.
 *
 *  - HTTP: serves the built web app (apps/web/dist) in production
 *  - WS  : protocol bridge between the browser UI and OpenCode
 */

import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ClientMessage } from '@pixel-agents/protocol';

import { AgentManager } from './agents.js';
import { loadAssetBundle, resolveAssetsDir } from './assets.js';
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

      socket.on('message', (raw) => {
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
