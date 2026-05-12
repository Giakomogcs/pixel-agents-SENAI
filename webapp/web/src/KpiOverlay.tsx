/**
 * KpiOverlay — pequeno HUD no canto superior direito da TV mostrando os
 * KPIs da fábrica (pedidos hoje, lead time médio, OEE). Atualiza ao receber
 * `factoryState` via WS.
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { FactoryKpis } from '@pixel-agents/protocol';

interface VsApi {
  postMessage(msg: unknown): void;
}
function vsApi(): VsApi {
  return (globalThis as unknown as { acquireVsCodeApi: () => VsApi }).acquireVsCodeApi();
}

const EMPTY: FactoryKpis = { ordersToday: 0, leadTimeAvgMin: 0, oeePercent: 0 };

function KpiOverlay() {
  const [kpis, setKpis] = useState<FactoryKpis>(EMPTY);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const m = e.data as { type?: string; kpis?: FactoryKpis };
      if (m?.type === 'factoryState' && m.kpis) setKpis(m.kpis);
    }
    window.addEventListener('message', onMessage);
    vsApi().postMessage({ type: 'factoryGetState' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: 9999,
        padding: '12px 18px',
        background: 'rgba(15,15,15,0.85)',
        border: '2px solid #FF6B00',
        borderRadius: 8,
        color: '#FAFAFA',
        fontFamily: '"FS Pixel Sans", system-ui, sans-serif',
        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        display: 'grid',
        gridTemplateColumns: 'repeat(3, auto)',
        gap: '4px 18px',
        alignItems: 'center',
        pointerEvents: 'none',
      }}
    >
      <Cell label="PEDIDOS" value={String(kpis.ordersToday)} accent="#FF6B00" />
      <Cell label="LEAD" value={`${kpis.leadTimeAvgMin}m`} accent="#5DADE2" />
      <Cell label="OEE" value={`${kpis.oeePercent}%`} accent="#27AE60" />
    </div>
  );
}

function Cell({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 60 }}>
      <div style={{ fontSize: 10, letterSpacing: 1.5, opacity: 0.6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: accent, lineHeight: 1 }}>{value}</div>
    </div>
  );
}

export function mountKpiOverlay(): void {
  const div = document.createElement('div');
  div.id = 'kpi-overlay';
  document.body.appendChild(div);
  createRoot(div).render(<KpiOverlay />);
}
