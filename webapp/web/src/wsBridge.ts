/**
 * WebSocket bridge — installs a shim acquireVsCodeApi() global and forwards
 * server messages back to the webview-ui as window "message" events.
 *
 * The webview-ui treats the runtime as VS Code (because acquireVsCodeApi
 * is defined), so its existing message handling code runs unmodified.
 */

interface VsCodeApiShim {
  postMessage(msg: unknown): void;
  setState?(s: unknown): void;
  getState?(): unknown;
}

declare global {
  var acquireVsCodeApi: () => VsCodeApiShim;
}

const WS_URL = (() => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
})();

let socket: WebSocket | null = null;
const outbox: string[] = [];

function connect(): void {
  socket = new WebSocket(WS_URL);

  socket.addEventListener('open', () => {
    console.log('[ws] connected', WS_URL);
    while (outbox.length) {
      socket!.send(outbox.shift()!);
    }
  });

  socket.addEventListener('message', (e) => {
    let data: unknown;
    try {
      data = JSON.parse(e.data as string);
    } catch {
      return;
    }
    // The webview-ui listens for window "message" events with a typed payload.
    window.dispatchEvent(new MessageEvent('message', { data }));
  });

  socket.addEventListener('close', () => {
    console.warn('[ws] disconnected, reconnecting in 1s');
    socket = null;
    setTimeout(connect, 1000);
  });

  socket.addEventListener('error', (e) => {
    console.error('[ws] error', e);
  });
}

export function installWsBridge(): void {
  const api: VsCodeApiShim = {
    postMessage(msg: unknown) {
      const m = msg as { type?: string; id?: number };
      // Side-channel: intercept focusAgent clicks and surface a prompt input.
      if (m?.type === 'focusAgent' && typeof m.id === 'number') {
        window.dispatchEvent(
          new CustomEvent('pixel-agents:openPrompt', { detail: { agentId: m.id } }),
        );
      }
      // Intercept "+ Agent" clicks: open the create-agent modal instead of
      // forwarding `openClaude` straight to the server. The modal will send
      // a `createAgent` message with name + prompt + provider + model.
      if (m?.type === 'openClaude') {
        window.dispatchEvent(new CustomEvent('pixel-agents:createAgent'));
        return;
      }
      const payload = JSON.stringify(msg);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      } else {
        outbox.push(payload);
      }
    },
    setState() {
      /* no-op — server is the source of truth */
    },
    getState() {
      return undefined;
    },
  };

  // Use Object.defineProperty so the runtime detection
  // (`typeof acquireVsCodeApi !== 'undefined'`) sees it as a real global.
  Object.defineProperty(globalThis, 'acquireVsCodeApi', {
    value: () => api,
    writable: false,
    configurable: false,
  });

  connect();
}
