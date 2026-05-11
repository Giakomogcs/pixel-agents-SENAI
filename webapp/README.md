# Pixel Agents — Web App (Standalone)

Standalone web application port of the Pixel Agents VS Code extension. Uses
[OpenCode](https://github.com/opencode-ai/opencode) as the AI runtime and
authenticates with **GitHub Copilot** via OAuth Device Flow.

## Layout

```
webapp/
├── package.json          ← npm workspaces root (server, web, protocol)
├── protocol/             ← shared WS message types
├── server/               ← Fastify + ws + @opencode-ai/sdk
└── web/                  ← Vite app (re-uses ../../webview-ui via alias)
```

## Dev

```sh
cd webapp
npm install
npm run dev          # starts server (:5179) + web (:5178) concurrently
# open http://localhost:5178
```

## Status

- [x] Workspace skeleton
- [ ] WS bridge (server ↔ web)
- [ ] OpenCode runtime integration
- [ ] Copilot OAuth device flow
- [ ] Agent session ↔ pixel character mapping
- [ ] Prompt input UI
