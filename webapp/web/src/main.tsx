/**
 * Pixel Agents Webapp — entry.
 *
 * Roteamento por `?mode=` (POC Fábrica SENAI):
 *   - `tablet`: renderiza apenas `TabletPanel` (iPad de chão de fábrica).
 *               NÃO importa o webview-ui — economiza memória/CPU no iPad.
 *   - `tv`:     comportamento padrão + KPI overlay + CSS para esconder
 *               toolbar/cursor (TV em fullscreen).
 *   - default:  modo de desenvolvimento, igual ao Pixel Agents original.
 *
 * Em qualquer modo o WS bridge é instalado primeiro para que
 * acquireVsCodeApi() já exista quando o resto do código carregar.
 */

import './index.css';
import { installWsBridge } from './wsBridge.ts';

installWsBridge();

const mode = new URLSearchParams(location.search).get('mode') ?? 'default';

if (mode === 'tablet') {
  const { mountTabletPanel } = await import('./TabletPanel.tsx');
  mountTabletPanel();
} else {
  const { mountCopilotOverlay } = await import('./CopilotOverlay.tsx');
  const { mountChatPanel } = await import('./ChatPanel.tsx');

  await import('@webview/main.tsx');

  mountCopilotOverlay();
  mountChatPanel();

  if (mode === 'tv') {
    const { mountKpiOverlay } = await import('./KpiOverlay.tsx');
    mountKpiOverlay();

    const css = document.createElement('style');
    css.textContent = `
      html, body { cursor: none !important; background: #0E0E0E !important; }
      #copilot-toolbar, #chat-panel, .pixel-agents-chat-panel { display: none !important; }
      [data-tv-hide], .copilot-overlay-floating-button { display: none !important; }
    `;
    document.head.appendChild(css);
  }
}

export {};
