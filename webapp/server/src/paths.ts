/**
 * Filesystem paths for user-level persistence.
 * Mirrors the extension's ~/.pixel-agents/ directory so layouts and
 * config are shared across the extension and webapp.
 */

import * as os from 'node:os';
import * as path from 'node:path';

export const PIXEL_AGENTS_DIR = path.join(os.homedir(), '.pixel-agents');
export const LAYOUT_FILE = path.join(PIXEL_AGENTS_DIR, 'layout.json');
export const CONFIG_FILE = path.join(PIXEL_AGENTS_DIR, 'config.json');
export const AGENTS_FILE = path.join(PIXEL_AGENTS_DIR, 'agents.json');
export const AUTH_FILE = path.join(PIXEL_AGENTS_DIR, 'auth.json');

export const APP_VERSION = '0.1.0-webapp';
