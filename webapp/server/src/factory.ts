/**
 * Factory POC (SENAI) — file-backed state for the "Fábrica Inteligente" demo.
 *
 *  - Reads/writes 4 JSON files under `<repoRoot>/factory-state/`:
 *      orders.json, inventory.json, production.json, kpis.json
 *  - Watches the directory (fs.watch + 200ms debounce) and broadcasts a
 *    `factoryState` message to all WS clients whenever something changes.
 *    The 3 Claude agents (Vendas, PCP, Produção) edit these files directly
 *    via their Read/Write tools — the watcher closes the loop and pushes
 *    the new state to the TV and tablet automatically.
 *  - Resets state back to seeded defaults via `resetFactoryState()`.
 *  - Bootstraps the 3 fixed agents once on server start.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  FactoryInventoryItem,
  FactoryKpis,
  FactoryOp,
  FactoryOrder,
  ServerMessage,
} from '@pixel-agents/protocol';

import type { AgentManager } from './agents.js';
import { COPILOT_DEFAULT_MODEL, COPILOT_PROVIDER_ID } from './constants.js';
import { getOpenCodeClient } from './opencode.js';

/**
 * Cached resolution of the actual github-copilot default model. The model id
 * exposed by OpenCode changes between versions (`claude-sonnet-4` vs
 * `claude-sonnet-4-5` vs `claude-3.5-sonnet` …) so we ask the server instead
 * of hardcoding. Falls back to the compile-time default if listProviders
 * fails or doesn't include Copilot.
 */
let cachedCopilotModel: { providerId: string; modelId: string } | null = null;

export async function resolveCopilotModel(): Promise<{ providerId: string; modelId: string }> {
  if (cachedCopilotModel) return cachedCopilotModel;
  try {
    const client = getOpenCodeClient();
    const { providers, defaultProviderId, defaultModelId } = await client.listProviders();
    const copilot = providers.find((p) => p.id === COPILOT_PROVIDER_ID);
    if (copilot && copilot.models.length > 0) {
      // Prefer a model that mentions "sonnet" (Claude default for our prompts),
      // else the provider's reported default, else the first model.
      const sonnet = copilot.models.find((m) => /sonnet/i.test(m.id));
      const resolved =
        sonnet?.id ??
        (copilot.models.find((m) => m.id === defaultModelId) ? defaultModelId : copilot.models[0].id);
      cachedCopilotModel = { providerId: COPILOT_PROVIDER_ID, modelId: resolved };
      console.log(
        `[factory] resolved Copilot model: ${cachedCopilotModel.modelId} (available: ${copilot.models.map((m) => m.id).join(', ')})`,
      );
      return cachedCopilotModel;
    }
    // No Copilot connected — return whatever the server defaults to.
    cachedCopilotModel = { providerId: defaultProviderId, modelId: defaultModelId };
    return cachedCopilotModel;
  } catch (err) {
    console.warn('[factory] resolveCopilotModel failed, using compile-time default:', err);
    return { providerId: COPILOT_PROVIDER_ID, modelId: COPILOT_DEFAULT_MODEL };
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Repo root resolution: server/src → ../../../.. (server → webapp → repo). */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const FACTORY_STATE_DIR = path.join(REPO_ROOT, 'factory-state');
export const FACTORY_PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');

const ORDERS_FILE = path.join(FACTORY_STATE_DIR, 'orders.json');
const INVENTORY_FILE = path.join(FACTORY_STATE_DIR, 'inventory.json');
const PRODUCTION_FILE = path.join(FACTORY_STATE_DIR, 'production.json');
const KPIS_FILE = path.join(FACTORY_STATE_DIR, 'kpis.json');

// Seeded inventory used by `resetFactoryState`. Kept in sync with
// factory-state/inventory.json so the demo always boots in a known state.
const SEED_INVENTORY: Record<string, FactoryInventoryItem> = {
  'PAR-M8X40-INX-A2': {
    name: 'Parafuso sextavado M8x40 inox A2 (DIN 933)',
    stock: 1200,
    minStock: 200,
    unit: 'pç',
  },
  'FLG-DN50-PN16-CS': {
    name: 'Flange sobreposta DN50 PN16 aço carbono (ABNT NBR 7675)',
    stock: 48,
    minStock: 12,
    unit: 'pç',
  },
  'ROL-6204-2RS': {
    name: 'Rolamento rígido de esferas 6204-2RS (DIN 625)',
    stock: 96,
    minStock: 24,
    unit: 'pç',
  },
  'EIX-AISI1045-D25-L500': {
    name: 'Eixo retificado AISI 1045 Ø25mm × 500mm',
    stock: 32,
    minStock: 8,
    unit: 'pç',
  },
  'JUN-NBR-DN50': {
    name: 'Junta NBR para flange DN50',
    stock: 150,
    minStock: 30,
    unit: 'pç',
  },
  'PIN-EL-D6-L40-CL10.9': {
    name: 'Pino elástico Ø6 × 40 classe 10.9 (DIN 1481)',
    stock: 800,
    minStock: 150,
    unit: 'pç',
  },
};

const SEED_KPIS: FactoryKpis = { ordersToday: 0, leadTimeAvgMin: 0, oeePercent: 0 };

type Broadcast = (msg: ServerMessage) => void;

// ── File I/O ─────────────────────────────────────────────────────────────────

async function readJsonSafe<T>(file: string, fallback: T): Promise<T> {
  try {
    const txt = await fsp.readFile(file, 'utf8');
    if (!txt.trim()) return fallback;
    return JSON.parse(txt) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    console.warn(`[factory] failed to read ${file}:`, err);
    return fallback;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export async function readFactoryState(): Promise<{
  orders: FactoryOrder[];
  inventory: Record<string, FactoryInventoryItem>;
  production: FactoryOp[];
  kpis: FactoryKpis;
}> {
  const [orders, inventory, production, kpis] = await Promise.all([
    readJsonSafe<FactoryOrder[]>(ORDERS_FILE, []),
    readJsonSafe<Record<string, FactoryInventoryItem>>(INVENTORY_FILE, SEED_INVENTORY),
    readJsonSafe<FactoryOp[]>(PRODUCTION_FILE, []),
    readJsonSafe<FactoryKpis>(KPIS_FILE, SEED_KPIS),
  ]);
  return { orders, inventory, production, kpis };
}

export async function resetFactoryState(): Promise<void> {
  await Promise.all([
    writeJson(ORDERS_FILE, []),
    writeJson(INVENTORY_FILE, SEED_INVENTORY),
    writeJson(PRODUCTION_FILE, []),
    writeJson(KPIS_FILE, SEED_KPIS),
  ]);
}

// ── Watcher (fs.watch + debounce) ────────────────────────────────────────────

export function watchFactoryState(broadcast: Broadcast): () => void {
  let timer: NodeJS.Timeout | null = null;
  let lastSig = '';

  const push = async (): Promise<void> => {
    try {
      const state = await readFactoryState();
      const sig = JSON.stringify(state);
      if (sig === lastSig) return;
      lastSig = sig;
      broadcast({ type: 'factoryState', ...state });
    } catch (err) {
      console.warn('[factory] watcher push failed:', err);
    }
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void push();
    }, 200);
  };

  try {
    fs.mkdirSync(FACTORY_STATE_DIR, { recursive: true });
  } catch {
    /* best effort */
  }

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(FACTORY_STATE_DIR, { persistent: false }, () => schedule());
  } catch (err) {
    console.warn('[factory] fs.watch unavailable, falling back to polling:', err);
  }

  // Polling backup every 1.5s — fs.watch is unreliable on some filesystems
  // (network drives, certain Linux containers). Cheap to read 4 small JSONs.
  const poll = setInterval(() => schedule(), 1500);

  // Initial broadcast so a fresh client sees state immediately.
  void push();

  return () => {
    if (timer) clearTimeout(timer);
    clearInterval(poll);
    watcher?.close();
  };
}

// ── Agent bootstrap ──────────────────────────────────────────────────────────

interface FactoryAgentSpec {
  key: 'vendas' | 'pcp' | 'producao';
  name: string;
  greeting: string;
}

const FACTORY_AGENTS: FactoryAgentSpec[] = [
  {
    key: 'vendas',
    name: 'Vendas',
    greeting:
      'Apresente-se em 1 frase curta como atendente de Vendas da Fábrica SENAI, em português do Brasil.',
  },
  {
    key: 'pcp',
    name: 'PCP',
    greeting:
      'Apresente-se em 1 frase curta como responsável pelo PCP da Fábrica SENAI, em português do Brasil.',
  },
  {
    key: 'producao',
    name: 'Produção',
    greeting:
      'Apresente-se em 1 frase curta como operador de Produção da Fábrica SENAI, em português do Brasil.',
  },
];

async function readPrompt(key: FactoryAgentSpec['key']): Promise<string> {
  const file = path.join(FACTORY_PROMPTS_DIR, `${key}.md`);
  return fsp.readFile(file, 'utf8');
}

/**
 * Spawn the 3 factory agents once. Idempotent across calls within the same
 * process (we track which keys we already booted). Persistence across server
 * restarts is handled by `AgentManager`: persisted agents are re-attached,
 * so we skip names that already exist live OR persisted.
 */
const bootstrappedKeys = new Set<string>();

export async function bootstrapFactoryAgents(
  agents: AgentManager,
  broadcast: Broadcast,
): Promise<void> {
  // Pre-warm the system prompt cache for ALL factory agents — even if Copilot
  // auth isn't ready yet. This guarantees that `runPedidoScenario` can always
  // re-inject the persona on every prompt, so the agent "already has" its
  // instructions the moment it becomes live.
  for (const spec of FACTORY_AGENTS) {
    try {
      const txt = await readPrompt(spec.key);
      systemPromptCache.set(spec.name, txt);
    } catch (err) {
      broadcast({
        type: 'log',
        level: 'warn',
        message: `[factory] prompt ${spec.key}.md não encontrado: ${(err as Error).message}`,
      });
    }
  }

  const existingNames = new Set(agents.listNames());
  const { providerId, modelId } = await resolveCopilotModel();

  // Heal any previously-persisted factory agents whose modelId is stale
  // (e.g. saved as `claude-sonnet-4` when OpenCode now expects a different id).
  for (const spec of FACTORY_AGENTS) {
    if (existingNames.has(spec.name)) {
      const changed = await agents.updateAgentModel(spec.name, providerId, modelId);
      if (changed) {
        broadcast({
          type: 'log',
          level: 'info',
          message: `[factory] migrated ${spec.name} to ${providerId}/${modelId}`,
        });
      }
    }
  }

  for (const spec of FACTORY_AGENTS) {
    if (bootstrappedKeys.has(spec.key)) continue;
    if (existingNames.has(spec.name)) {
      bootstrappedKeys.add(spec.key);
      continue;
    }

    let systemPrompt: string;
    try {
      systemPrompt = await readPrompt(spec.key);
    } catch (err) {
      broadcast({
        type: 'log',
        level: 'error',
        message: `[factory] missing prompt for ${spec.key}: ${(err as Error).message}`,
      });
      continue;
    }

    // Initial prompt = full system prompt + a tiny "introduce yourself" task.
    // This is sent as a regular user message because OpenCode/Copilot don't
    // expose a separate system slot in our minimal wiring. The model treats
    // the long preamble as durable context for subsequent turns.
    const initialPrompt = `${systemPrompt}\n\n---\n\n${spec.greeting}`;

    const agent = await agents.spawn({
      name: spec.name,
      prompt: initialPrompt,
      providerId,
      modelId,
    });
    if (!agent) {
      broadcast({
        type: 'log',
        level: 'warn',
        message: `[factory] bootstrap skipped for ${spec.name} (spawn returned null — Copilot auth?)`,
      });
      continue;
    }
    bootstrappedKeys.add(spec.key);

    // Serialize greetings — wait a bit before the next agent so the TV doesn't
    // light up 3 speech bubbles at once. 1.5s is enough for the matrix spawn
    // animation to play and the character to start walking to its seat.
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ── Scenario: pedido (order) ─────────────────────────────────────────────────

/** Cache of system prompts per factory agent name. Populated by bootstrap. */
const systemPromptCache = new Map<string, string>();

async function getSystemPrompt(key: FactoryAgentSpec['key']): Promise<string> {
  const spec = FACTORY_AGENTS.find((a) => a.key === key);
  if (!spec) throw new Error(`unknown factory agent key: ${key}`);
  let cached = systemPromptCache.get(spec.name);
  if (!cached) {
    cached = await readPrompt(key);
    systemPromptCache.set(spec.name, cached);
  }
  return cached;
}

async function appendOrder(sku: string, qty: number): Promise<FactoryOrder> {
  const orders = await readJsonSafe<FactoryOrder[]>(ORDERS_FILE, []);
  const nextId = orders.reduce((max, o) => Math.max(max, o.id), 0) + 1;
  const order: FactoryOrder = {
    id: nextId,
    sku,
    qty,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  orders.push(order);
  await writeJson(ORDERS_FILE, orders);
  return order;
}

export async function runPedidoScenario(
  agents: AgentManager,
  sku: string,
  qty: number,
  broadcast: Broadcast,
): Promise<void> {
  lastActivityAt = Date.now();

  // 1) Always write the order to disk first. This guarantees the tablet/TV
  //    update immediately even if Copilot auth is pending or the Vendas agent
  //    hasn't been spawned yet. The watcher pushes the new state to all clients.
  let order: FactoryOrder;
  try {
    order = await appendOrder(sku, qty);
    broadcast({
      type: 'log',
      level: 'info',
      message: `[factory] pedido #${order.id.toString()} registrado: ${qty.toString()}x ${sku}`,
    });
  } catch (err) {
    broadcast({
      type: 'log',
      level: 'error',
      message: `[factory] falha ao registrar pedido: ${(err as Error).message}`,
    });
    return;
  }

  // 2) If the Vendas agent is live, kick it off with full context (system
  //    prompt + this specific task). We re-send the system prompt every time
  //    so the agent always has its persona/rules even after session restarts.
  const vendas = agents.findByName('Vendas');
  if (!vendas) {
    broadcast({
      type: 'log',
      level: 'warn',
      message:
        '[factory] agente Vendas não está pronto — pedido registrado, mas não processado. Verifique o Copilot.',
    });
    return;
  }

  let systemPrompt = '';
  try {
    systemPrompt = await getSystemPrompt('vendas');
  } catch (err) {
    broadcast({
      type: 'log',
      level: 'warn',
      message: `[factory] não consegui ler o prompt de Vendas: ${(err as Error).message}`,
    });
  }

  const task = `Cliente solicitou ${qty.toString()}x ${sku}. Pedido registrado como #${order.id.toString()} em orders.json (status: pending). Processe o pedido seguindo seu fluxo.`;
  const prompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${task}` : task;
  await agents.sendPrompt(vendas.id, prompt);
}

// ── Auto-demo (idle trigger) ─────────────────────────────────────────────────

let lastActivityAt = Date.now();

/** Update the activity clock from outside (e.g. on `factoryReset`). */
export function markFactoryActivity(): void {
  lastActivityAt = Date.now();
}

/**
 * Every 30s, check whether the factory has been idle for >= idleMs. If so,
 * pick a random SKU + qty and trigger the pedido scenario. Mitigates dead
 * air on the SENAI fair floor.
 */
export function startAutoDemo(
  agents: AgentManager,
  broadcast: Broadcast,
  idleMs = 2 * 60 * 1000,
): () => void {
  const skus = Object.keys(SEED_INVENTORY);
  const tick = setInterval(() => {
    if (Date.now() - lastActivityAt < idleMs) return;
    const sku = skus[Math.floor(Math.random() * skus.length)];
    const qty = 5 + Math.floor(Math.random() * 30);
    broadcast({
      type: 'log',
      level: 'info',
      message: `[factory] auto-demo: ${qty.toString()}x ${sku}`,
    });
    void runPedidoScenario(agents, sku, qty, broadcast);
  }, 30 * 1000);
  return () => clearInterval(tick);
}
