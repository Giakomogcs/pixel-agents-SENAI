/**
 * WebSocket message protocol shared between the web UI and the server.
 *
 * The names mirror the existing extension ↔ webview postMessage protocol so
 * the React UI requires minimal changes. The server forwards/translates
 * OpenCode events into ServerMessage shapes.
 */

// ── Client → Server ──────────────────────────────────────────────────────────

export type ClientMessage =
  // Lifecycle
  | { type: 'webviewReady' }
  | { type: 'requestDiagnostics' }

  // Agent control
  | { type: 'openClaude'; folderPath?: string; bypassPermissions?: boolean }
  | { type: 'focusAgent'; id: number }
  | { type: 'closeAgent'; id: number }
  | { type: 'sendPrompt'; agentId: number; text: string }

  // Layout / persistence
  | { type: 'saveLayout'; layout: unknown }
  | { type: 'saveAgentSeats'; seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> }
  | { type: 'exportLayout' }
  | { type: 'importLayout' }

  // Settings
  | { type: 'setSoundEnabled'; enabled: boolean }
  | { type: 'setAlwaysShowLabels'; enabled: boolean }
  | { type: 'setWatchAllSessions'; enabled: boolean }
  | { type: 'setHooksEnabled'; enabled: boolean }
  | { type: 'setHooksInfoShown' }
  | { type: 'setLastSeenVersion'; version: string }
  | { type: 'openSessionsFolder' }
  | { type: 'addExternalAssetDirectory' }
  | { type: 'removeExternalAssetDirectory'; path: string }

  // Copilot OAuth (new — webapp only)
  | { type: 'startCopilotAuth' }
  | { type: 'pollCopilotAuth' }
  | { type: 'logoutCopilot' }
  | { type: 'getCopilotStatus' };

// ── Server → Client ──────────────────────────────────────────────────────────

export type ServerMessage =
  // Asset bootstrap (parity with extension)
  | { type: 'characterSpritesLoaded'; characters: unknown[] }
  | { type: 'floorTilesLoaded'; sprites: unknown[] }
  | { type: 'wallTilesLoaded'; sets: unknown[] }
  | { type: 'furnitureAssetsLoaded'; catalog: unknown[]; sprites: Record<string, unknown> }
  | { type: 'layoutLoaded'; layout: unknown }
  | { type: 'workspaceFolders'; folders: { name: string; path: string }[] }
  | {
      type: 'settingsLoaded';
      soundEnabled: boolean;
      alwaysShowLabels?: boolean;
      watchAllSessions?: boolean;
      hooksEnabled?: boolean;
      hooksInfoShown?: boolean;
      extensionVersion: string;
      lastSeenVersion: string;
      externalAssetDirectories?: string[];
    }
  | { type: 'externalAssetDirectoriesUpdated'; dirs: string[] }

  // Agent lifecycle
  | { type: 'agentCreated'; id: number; name: string; palette?: number; hueShift?: number; seatId?: string | null }
  | { type: 'agentClosed'; id: number }
  | { type: 'existingAgents'; agents: { id: number; name: string; palette?: number; hueShift?: number; seatId?: string | null }[] }
  | { type: 'agentSelected'; id: number | null }
  | { type: 'agentStatus'; id: number; status: 'active' | 'waiting' | 'idle' }

  // Tools
  | { type: 'agentToolStart'; id: number; toolId: string; tool: string; input?: unknown; status?: string }
  | { type: 'agentToolDone'; id: number; toolId: string }
  | { type: 'agentToolsClear'; id: number }
  | { type: 'agentToolPermission'; id: number; toolId: string }
  | { type: 'agentToolPermissionClear'; id: number; toolId: string }

  // Subagents
  | { type: 'subagentToolStart'; parentAgentId: number; parentToolId: string; toolId: string; tool: string; input?: unknown }
  | { type: 'subagentToolDone'; parentAgentId: number; parentToolId: string; toolId: string }
  | { type: 'subagentClear'; parentAgentId: number; parentToolId: string }
  | { type: 'subagentToolPermission'; parentAgentId: number; parentToolId: string; toolId: string }

  // Copilot OAuth
  | { type: 'copilotAuthCode'; userCode: string; verificationUri: string; expiresIn: number; interval: number }
  | { type: 'copilotAuthPending' }
  | { type: 'copilotAuthComplete' }
  | { type: 'copilotAuthError'; error: string }
  | { type: 'copilotStatus'; authenticated: boolean }

  // Misc
  | { type: 'agentPrompt'; agentId: number; text: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type AnyMessage = ClientMessage | ServerMessage;
