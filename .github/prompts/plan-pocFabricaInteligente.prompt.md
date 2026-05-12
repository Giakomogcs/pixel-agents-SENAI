# Plan: POC Fábrica Inteligente — MVP feira 14/05

**TL;DR** — Em ~2 dias, transformar o Pixel Agents em uma "fábrica de autopeças metalúrgicas" com **3 agentes** (Vendas, PCP, Produção) executando **1 cenário** (Pedido Express). TV e iPad acessam a **mesma webapp** via WiFi local — TV em modo display, iPad em modo controle PT-BR. Estado em JSON files. Extensão VS Code **não** é tocada.

## Contexto

- Empresa: metalurgia / autopeças (workspace SENAI)
- Feira: 14/05/2026 (hoje 12/05) — prazo apertado
- Hardware: iPad (Safari iOS) como tablet, TV (Chrome fullscreen)
- Internet na feira: instável → reconexão WS já existe em `wsBridge.ts`
- UI 100% PT-BR
- Copilot OAuth no webapp: **NÃO testado ainda** — bloqueador #1
- SKUs: produtos reais de metalurgia (normas DIN/ABNT/ISO)

## Decisões fechadas

- ✅ Webapp-only (não mexer em extensão VS Code) — economiza ~1 dia de bridge
- ✅ Usar `sendPrompt` do webapp (já existe em `webapp/server/src/agents.ts:106-190` e `ws.ts:118-126`), **não** `terminal.sendText`
- ✅ JSON files para estado (não SQLite/MCP)
- ✅ Escopo ENXUTO: 3 agentes + 1 cenário
- ✅ Sem sub-agentes (Task tool) no MVP
- ✅ Plano B offline fica como evolução pós-feira
- ✅ SKUs metalúrgicos com normas reais

## Conflitos resolvidos das respostas iniciais

1. Usuário escolheu "nova aba no webview" + "iPad" — incompatível (iPad precisa servidor de rede). **Resolvido → webapp/**
2. Usuário escolheu "terminal.sendText" — webapp não fala com extensão. **Resolvido → `sendPrompt` via WS**

## Fases

### Fase 0 — Validação de pré-requisitos (~1h) 🚨 BLOQUEADOR

0. Validar Copilot OAuth do webapp: `cd webapp/server && npm run dev`, abrir `http://localhost:5178`, completar fluxo de auth, criar 1 agente teste, enviar 1 prompt, ver resposta. Se falhar → fallback Anthropic API key (`ANTHROPIC_API_KEY` no env do server).

### Fase 1 — Fundação (Dia 1 manhã, ~4h) — paralelizável após Fase 0

1. **Layout** — `webview-ui/public/assets/default-layout-factory.json` com 3 estações (Balcão Vendas na entrada, Mesa PCP no centro, Bancada Produção com 2 monitores como CNC fake). Copiar formato de `default-layout-1.json`.
2. **Estado JSON** — pasta `factory-state/` na raiz do workspace:
   - `orders.json` — array de `{ id, sku, qty, status, createdAt }`
   - `inventory.json` — dict `{ sku: { name, stock, minStock, unit } }`
   - `production.json` — array de OPs em andamento
   - `kpis.json` — `{ ordersToday, leadTimeAvgMin, oeePercent }`
   - `README.md` documentando schemas
3. **SKUs metalúrgicos reais** em `inventory.json`:
   - `PAR-M8X40-INX-A2` — Parafuso sextavado M8x40 inox A2 (DIN 933)
   - `FLG-DN50-PN16-CS` — Flange sobreposta DN50 PN16 aço carbono (ABNT NBR 7675)
   - `ROL-6204-2RS` — Rolamento rígido de esferas 6204-2RS (DIN 625)
   - `EIX-AISI1045-D25-L500` — Eixo retificado AISI 1045 Ø25mm × 500mm
   - `JUN-NBR-DN50` — Junta NBR para flange DN50
   - `PIN-EL-D6-L40-CL10.9` — Pino elástico Ø6 × 40 classe 10.9 (DIN 1481)
4. **System prompts PT-BR** em `prompts/`:
   - `vendas.md` — recebe pedido do tablet, valida SKU em `inventory.json`, cria entry em `orders.json`, pinga PCP
   - `pcp.md` — lê `orders.json` pendentes, valida estoque, cria OP em `production.json`, aciona Produção
   - `producao.md` — executa OP (simula com sleep/Write), atualiza status para "concluído", atualiza `kpis.json`

### Fase 2 — Backend webapp (Dia 1 tarde, ~4h) — depende de Fase 1

5. **Protocol** — `webapp/protocol/src/index.ts`:
   - `ClientMessage`: `{ type: 'factoryScenario', scenario: 'pedido', sku, qty }`, `{ type: 'factoryReset' }`
   - `ServerMessage`: `{ type: 'factoryState', orders, inventory, production, kpis }`
6. **Handler WS** — `webapp/server/src/ws.ts`:
   - case `factoryScenario` → garante agentes bootstrapados → `sendPrompt` no agente Vendas com template "Cliente solicitou {qty}x {sku}. Processe o pedido."
   - case `factoryReset` → reseta JSONs para defaults
7. **Watcher** — `fs.watch('factory-state/', ...)` com debounce 200ms → `WsHub.broadcast({ type: 'factoryState', ... })`
8. **Bootstrap agentes** — `webapp/server/src/agents.ts` adicionar `bootstrapFactoryAgents()`:
   - Cria 3 agentes (Vendas, PCP, Produção) com `name`, `prompt` lido de `prompts/*.md`, posição (seat) fixa do layout
   - Idempotente: se já existem com mesmo nome, reusa
   - Chamado uma vez no startup do server

### Fase 3 — Tablet UI (Dia 2 manhã, ~3h) — depende de Fase 2

9. **Modo via query param** — `webapp/web/src/main.tsx` lê `?mode=tv|tablet|default`:
   - `tv`: esconde toolbar, fullscreen, sem cursor, mostra KPI overlay
   - `tablet`: renderiza só `TabletPanel`, esconde canvas
   - `default` (sem param): comportamento atual de dev
10. **`TabletPanel.tsx`** novo em `webapp/web/src/`:
    - Header com logo "FÁBRICA SENAI"
    - Card grande "Fazer Pedido": dropdown de SKU (lê inventory via `factoryState`) + input quantidade + botão "Enviar Pedido"
    - Lista "Pedidos em Andamento" (live de `factoryState.orders`)
    - Botão pequeno "Reset Demo" no rodapé
    - Visual: laranja-segurança (#FF6B00) sobre cinza chão de fábrica (#3A3A3A), fonte FS Pixel Sans existente
11. **`KpiOverlay.tsx`** no modo TV — canto superior direito, mostra `ordersToday`, `leadTimeAvgMin`, `oeePercent`

### Fase 4 — Cenário + polish (Dia 2 tarde, ~4h) — depende de Fase 3

12. **Roteiro Pedido Express**: tablet → Vendas (anda até mesa, escreve em `orders.json`) → PCP (anda até PCP, lê orders + inventory, cria OP) → Produção (anda até bancada, animação "typing" ~30s simulando execução, atualiza status + KPIs) → tablet mostra "Pedido #N pronto". Iterar prompts até fluxo limpo.
13. **Auto-demo** — `webapp/server/src/ws.ts` timer 2min idle → dispara `factoryScenario` com SKU/qty aleatório
14. **Smoke test E2E**: TV em fullscreen + iPad via Chrome responsive mode → cenário completo 3x
15. **Teste de resiliência**: desligar WiFi 10s → confirmar reconexão WS

## Arquivos relevantes

- `webapp/server/src/ws.ts` — handlers `factoryScenario`/`factoryReset` + watcher
- `webapp/server/src/agents.ts` — `bootstrapFactoryAgents()` reusando `spawn()`
- `webapp/server/src/index.ts` — chamar bootstrap no startup
- `webapp/protocol/src/index.ts` — novos tipos do namespace factory
- `webapp/web/src/main.tsx` — roteamento por `?mode=`
- `webapp/web/src/TabletPanel.tsx` (novo)
- `webapp/web/src/KpiOverlay.tsx` (novo)
- `webview-ui/public/assets/default-layout-factory.json` (novo, copiar de `default-layout-1.json`)
- `prompts/vendas.md`, `prompts/pcp.md`, `prompts/producao.md` (novos)
- `factory-state/orders.json`, `inventory.json`, `production.json`, `kpis.json`, `README.md` (novos)

## Verificação

1. `npm run build` raiz + `npm --prefix webapp/server run build` + `npm --prefix webapp/web run build` sem erros TS
2. `npm test` (vitest server) + adicionar teste para handler `factoryScenario`
3. **Manual TV**: `http://localhost:5178/?mode=tv` em Chrome fullscreen → 3 agentes nas estações
4. **Manual tablet**: `http://<ip-laptop>:5178/?mode=tablet` no Safari iPad → tocar "Fazer Pedido" → ver cascata Vendas→PCP→Produção na TV → KPI atualiza
5. **Auto-demo**: idle 2min → cenário dispara sozinho
6. **Reconexão**: desligar WiFi iPad 10s → reconecta automaticamente
7. **Reset**: botão "Reset Demo" zera JSONs e atualiza tablet+TV

## Fora de escopo (pós-feira)

- Agentes Logística, Qualidade, Manutenção, Compras, Supervisor
- Cenários B (Ruptura), C (Manutenção), D (Pergunte ao Gerente)
- Sprites industriais customizados (esteira, empilhadeira)
- SQLite + MCP server
- Plano B offline com replay gravado
- Integração com extensão VS Code
- Sub-agentes via Task tool

## Riscos conhecidos

- **R1 (alto):** Copilot OAuth no webapp não validado — Fase 0 destrava. Mitigação: fallback Anthropic API key
- **R2 (médio):** Prompts encadeados podem alucinar ou não seguir fluxo — mitigação: prompts curtos, regras explícitas, testar 5+ vezes na Fase 4
- **R3 (médio):** Latência LLM pode tornar cenário muito lento para feira — mitigação: animações visuais "ocupam" enquanto LLM pensa; KPI overlay dá feedback
- **R4 (baixo):** WiFi da feira pode bloquear porta 5178 — mitigação: usar hotspot do celular; testar antecipadamente
