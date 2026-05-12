/**
 * User-level persistence (layout / config / agents).
 *
 * All files live under `~/.pixel-agents/`, intentionally compatible with the
 * VS Code extension so users can share state.
 *
 * Atomic writes via tmp + rename to avoid partial reads from cross-process
 * watchers.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { AGENTS_FILE, CONFIG_FILE, LAYOUT_FILE, PIXEL_AGENTS_DIR } from './paths.js';

async function ensureDir(): Promise<void> {
  await fs.mkdir(PIXEL_AGENTS_DIR, { recursive: true });
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const txt = await fs.readFile(file, 'utf8');
    return JSON.parse(txt) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  // Serialize per-destination so two concurrent writes (e.g. agentCreated +
  // saveAgentSeats arriving back-to-back) don't race on the same target.
  const prev = writeQueue.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => doWriteJsonAtomic(file, data));
  writeQueue.set(file, next);
  try {
    await next;
  } finally {
    if (writeQueue.get(file) === next) writeQueue.delete(file);
  }
}

const writeQueue = new Map<string, Promise<void>>();

async function doWriteJsonAtomic(file: string, data: unknown): Promise<void> {
  await ensureDir();
  const uniq = `${process.pid.toString()}.${Date.now().toString()}.${Math.random().toString(36).slice(2)}`;
  const tmp = `${file}.${uniq}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  // On Windows, fs.rename can fail with EPERM/EBUSY if another process
  // (e.g. the VS Code extension watcher or an editor) momentarily holds
  // the destination. Retry a few times with backoff before falling back to
  // a non-atomic copy + unlink.
  const maxAttempts = 6;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EEXIST') || i === maxAttempts - 1) {
        if (code === 'EPERM' || code === 'EBUSY') {
          // Last-ditch fallback: copy then delete tmp.
          try {
            await fs.copyFile(tmp, file);
            await fs.unlink(tmp).catch(() => undefined);
            return;
          } catch (fallbackErr) {
            await fs.unlink(tmp).catch(() => undefined);
            throw fallbackErr;
          }
        }
        await fs.unlink(tmp).catch(() => undefined);
        throw err;
      }
      await new Promise((r) => setTimeout(r, 30 * (i + 1)));
    }
  }
}

// ── Layout ───────────────────────────────────────────────────────────────────

export async function readLayout(): Promise<unknown | null> {
  return readJson<unknown>(LAYOUT_FILE);
}

export async function writeLayout(layout: unknown): Promise<void> {
  await writeJsonAtomic(LAYOUT_FILE, layout);
}

/**
 * Falls back to the bundled default-layout-1.json from webview-ui/public.
 */
export async function readLayoutOrDefault(assetsDir: string): Promise<unknown | null> {
  const saved = await readLayout();
  if (saved) return saved;
  const candidates = [
    path.join(assetsDir, 'default-layout-factory.json'),
    path.join(assetsDir, 'default-layout-1.json'),
    path.join(assetsDir, 'default-layout.json'),
  ];
  for (const c of candidates) {
    const fromDefault = await readJson<unknown>(c);
    if (fromDefault) return fromDefault;
  }
  return null;
}

// ── Config (sound, hooks, externalAssetDirectories, etc) ─────────────────────

export interface AppConfig {
  soundEnabled: boolean;
  alwaysShowLabels: boolean;
  watchAllSessions: boolean;
  hooksEnabled: boolean;
  hooksInfoShown: boolean;
  lastSeenVersion: string;
  externalAssetDirectories: string[];
}

const DEFAULT_CONFIG: AppConfig = {
  soundEnabled: true,
  alwaysShowLabels: false,
  watchAllSessions: false,
  hooksEnabled: false,
  hooksInfoShown: false,
  lastSeenVersion: '',
  externalAssetDirectories: [],
};

export async function readConfig(): Promise<AppConfig> {
  const cfg = await readJson<Partial<AppConfig>>(CONFIG_FILE);
  return { ...DEFAULT_CONFIG, ...(cfg ?? {}) };
}

export async function writeConfig(cfg: AppConfig): Promise<void> {
  await writeJsonAtomic(CONFIG_FILE, cfg);
}

export async function patchConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const current = await readConfig();
  const next = { ...current, ...patch };
  await writeConfig(next);
  return next;
}

// ── Agents (persisted seats / palettes) ──────────────────────────────────────

export interface PersistedAgent {
  id: number;
  sessionId?: string;
  name: string;
  palette: number;
  hueShift: number;
  seatId: string | null;
  providerId?: string;
  modelId?: string;
}

export interface AgentsState {
  nextId: number;
  agents: PersistedAgent[];
}

export async function readAgents(): Promise<AgentsState> {
  const data = await readJson<AgentsState>(AGENTS_FILE);
  return data ?? { nextId: 1, agents: [] };
}

export async function writeAgents(state: AgentsState): Promise<void> {
  await writeJsonAtomic(AGENTS_FILE, state);
}
