/**
 * Pixel Agents Webapp — entry.
 *
 * The webview-ui codebase has two runtime modes:
 *   1) "vscode": uses globalThis.acquireVsCodeApi() to talk to the host.
 *   2) "browser": uses a local mock that fetches assets and dispatches
 *      pre-canned messages to demo the UI.
 *
 * We hijack mode (1) by installing acquireVsCodeApi() BEFORE importing the
 * webview-ui source. Our shim posts messages over a WebSocket to
 * webapp/server, and the server's responses are dispatched as window
 * "message" events — which is exactly what the webview-ui already listens
 * for. This means the entire React app + game engine runs unmodified.
 */

import './index.css';
import { installWsBridge } from './wsBridge.ts';

installWsBridge();

// Import the webview-ui's main.tsx by path so its useEffect hooks run.
// The dynamic import happens AFTER acquireVsCodeApi is installed.
await import('@webview/main.tsx');

export {};
