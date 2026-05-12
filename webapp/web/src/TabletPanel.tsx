/**
 * TabletPanel — UI exclusiva do modo `?mode=tablet` (iPad da feira SENAI).
 *
 *  - Mostra o catálogo de SKUs (lido de `factoryState.inventory`).
 *  - Permite escolher SKU + quantidade e enviar um pedido (`factoryScenario`).
 *  - Lista pedidos em andamento (live de `factoryState.orders`).
 *  - Botão "Reset Demo" zera o estado (envia `factoryReset`).
 *
 * Estilo: laranja-segurança (#FF6B00) sobre cinza chão de fábrica (#3A3A3A),
 * fontes grandes e botões com área de toque generosa para o iPad.
 */

import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type {
  FactoryInventoryItem,
  FactoryKpis,
  FactoryOp,
  FactoryOrder,
} from '@pixel-agents/protocol';

interface VsApi {
  postMessage(msg: unknown): void;
}
function vsApi(): VsApi {
  return (globalThis as unknown as { acquireVsCodeApi: () => VsApi }).acquireVsCodeApi();
}

interface FactoryState {
  orders: FactoryOrder[];
  inventory: Record<string, FactoryInventoryItem>;
  production: FactoryOp[];
  kpis: FactoryKpis;
}

const EMPTY_STATE: FactoryState = { orders: [], inventory: {}, production: [], kpis: { ordersToday: 0, leadTimeAvgMin: 0, oeePercent: 0 } };

const STATUS_LABELS: Record<FactoryOrder['status'], string> = {
  pending: 'Aguardando',
  accepted: 'Em PCP',
  in_production: 'Produzindo',
  done: 'Concluído',
  rejected: 'Recusado',
};

const STATUS_COLORS: Record<FactoryOrder['status'], string> = {
  pending: '#FFB84D',
  accepted: '#5DADE2',
  in_production: '#F39C12',
  done: '#27AE60',
  rejected: '#C0392B',
};

function TabletPanel() {
  const [state, setState] = useState<FactoryState>(EMPTY_STATE);
  const [sku, setSku] = useState<string>('');
  const [qty, setQty] = useState<number>(10);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const m = e.data as { type?: string; [k: string]: unknown };
      if (m?.type === 'factoryState') {
        setState({
          orders: (m.orders as FactoryOrder[]) ?? [],
          inventory: (m.inventory as Record<string, FactoryInventoryItem>) ?? {},
          production: (m.production as FactoryOp[]) ?? [],
          kpis: (m.kpis as FactoryKpis) ?? EMPTY_STATE.kpis,
        });
      }
    }
    window.addEventListener('message', onMessage);
    vsApi().postMessage({ type: 'factoryGetState' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Default SKU = first key of inventory once it loads.
  useEffect(() => {
    if (!sku) {
      const first = Object.keys(state.inventory)[0];
      if (first) setSku(first);
    }
  }, [state.inventory, sku]);

  const skuList = useMemo(() => Object.entries(state.inventory), [state.inventory]);
  const activeOrders = useMemo(
    () => state.orders.filter((o) => o.status !== 'done' && o.status !== 'rejected').slice(-8).reverse(),
    [state.orders],
  );
  const recentDone = useMemo(
    () => state.orders.filter((o) => o.status === 'done' || o.status === 'rejected').slice(-3).reverse(),
    [state.orders],
  );

  function submit(): void {
    if (!sku || qty <= 0 || sending) return;
    setSending(true);
    vsApi().postMessage({ type: 'factoryScenario', scenario: 'pedido', sku, qty });
    setTimeout(() => setSending(false), 800);
  }

  function reset(): void {
    if (!confirm('Resetar a demo? Todos os pedidos e KPIs serão zerados.')) return;
    vsApi().postMessage({ type: 'factoryReset' });
  }

  const selected = sku ? state.inventory[sku] : undefined;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#3A3A3A',
        color: '#FAFAFA',
        fontFamily: '"FS Pixel Sans", system-ui, sans-serif',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <header
        style={{
          padding: '16px 24px',
          background: '#1F1F1F',
          borderBottom: '4px solid #FF6B00',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: 2, color: '#FF6B00' }}>
          🏭 FÁBRICA SENAI
        </div>
        <div style={{ fontSize: 14, opacity: 0.7 }}>POC Fábrica Inteligente</div>
      </header>

      {/* Body */}
      <main style={{ flex: 1, padding: 24, display: 'flex', flexDirection: 'column', gap: 20, overflowY: 'auto' }}>
        {/* Card: Fazer Pedido */}
        <section
          style={{
            background: '#2A2A2A',
            borderLeft: '6px solid #FF6B00',
            padding: 20,
            borderRadius: 8,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          <h2 style={{ margin: '0 0 16px', fontSize: 22 }}>Fazer Pedido</h2>

          <label style={{ display: 'block', fontSize: 14, opacity: 0.8, marginBottom: 6 }}>SKU</label>
          <select
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            style={{
              width: '100%',
              padding: '14px 12px',
              fontSize: 16,
              background: '#1F1F1F',
              color: '#FAFAFA',
              border: '2px solid #555',
              borderRadius: 6,
              marginBottom: 12,
            }}
          >
            {skuList.length === 0 && <option value="">— Aguardando estoque —</option>}
            {skuList.map(([code, item]) => (
              <option key={code} value={code}>
                {code} — {item.name}
              </option>
            ))}
          </select>
          {selected && (
            <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 12 }}>
              Estoque atual: <strong>{selected.stock}</strong> {selected.unit}
              {selected.stock <= selected.minStock && (
                <span style={{ color: '#FFB84D', marginLeft: 8 }}>⚠ abaixo do mínimo</span>
              )}
            </div>
          )}

          <label style={{ display: 'block', fontSize: 14, opacity: 0.8, marginBottom: 6 }}>Quantidade</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
            <button
              type="button"
              onClick={() => setQty((q) => Math.max(1, q - 10))}
              style={btnSmall}
              aria-label="Diminuir 10"
            >
              −10
            </button>
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
              style={{
                flex: 1,
                padding: '14px 12px',
                fontSize: 22,
                textAlign: 'center',
                background: '#1F1F1F',
                color: '#FAFAFA',
                border: '2px solid #555',
                borderRadius: 6,
              }}
            />
            <button
              type="button"
              onClick={() => setQty((q) => q + 10)}
              style={btnSmall}
              aria-label="Aumentar 10"
            >
              +10
            </button>
          </div>

          <button
            type="button"
            onClick={submit}
            disabled={!sku || sending}
            style={{
              width: '100%',
              padding: '18px',
              fontSize: 20,
              fontWeight: 700,
              background: sending ? '#996600' : '#FF6B00',
              color: '#FFF',
              border: 'none',
              borderRadius: 8,
              cursor: sending ? 'wait' : 'pointer',
              letterSpacing: 1,
              boxShadow: '0 4px 0 #993D00',
            }}
          >
            {sending ? 'Enviando…' : '▶ ENVIAR PEDIDO'}
          </button>
        </section>

        {/* Card: Pedidos em andamento */}
        <section
          style={{
            background: '#2A2A2A',
            padding: 20,
            borderRadius: 8,
            borderLeft: '6px solid #5DADE2',
          }}
        >
          <h2 style={{ margin: '0 0 12px', fontSize: 20 }}>Pedidos em andamento</h2>
          {activeOrders.length === 0 ? (
            <div style={{ opacity: 0.6, fontStyle: 'italic' }}>Nenhum pedido em andamento.</div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {activeOrders.map((o) => (
                <li
                  key={o.id}
                  style={{
                    padding: '12px 14px',
                    background: '#1F1F1F',
                    borderRadius: 6,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700 }}>
                      #{o.id} — {o.qty}× {o.sku}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.6 }}>
                      {new Date(o.createdAt).toLocaleTimeString('pt-BR')}
                    </div>
                  </div>
                  <span
                    style={{
                      padding: '6px 10px',
                      background: STATUS_COLORS[o.status],
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 700,
                      color: '#000',
                    }}
                  >
                    {STATUS_LABELS[o.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {recentDone.length > 0 && (
          <section
            style={{
              background: '#2A2A2A',
              padding: 16,
              borderRadius: 8,
              borderLeft: '6px solid #27AE60',
            }}
          >
            <h3 style={{ margin: '0 0 8px', fontSize: 16, opacity: 0.85 }}>Últimas conclusões</h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {recentDone.map((o) => (
                <li key={o.id} style={{ fontSize: 13, opacity: 0.8 }}>
                  ✓ #{o.id} — {o.qty}× {o.sku} ({STATUS_LABELS[o.status]})
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      {/* Footer */}
      <footer
        style={{
          padding: '12px 24px',
          background: '#1F1F1F',
          borderTop: '2px solid #444',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 12,
        }}
      >
        <span style={{ opacity: 0.5 }}>
          Pedidos hoje: <strong style={{ color: '#FF6B00' }}>{state.kpis.ordersToday}</strong>
          {' · '}
          Lead time: <strong>{state.kpis.leadTimeAvgMin}min</strong>
          {' · '}
          OEE: <strong>{state.kpis.oeePercent}%</strong>
        </span>
        <button type="button" onClick={reset} style={btnReset}>
          Reset Demo
        </button>
      </footer>
    </div>
  );
}

const btnSmall: React.CSSProperties = {
  padding: '14px 16px',
  fontSize: 16,
  background: '#444',
  color: '#FFF',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontWeight: 700,
};

const btnReset: React.CSSProperties = {
  padding: '8px 14px',
  fontSize: 12,
  background: 'transparent',
  color: '#888',
  border: '1px solid #555',
  borderRadius: 4,
  cursor: 'pointer',
};

export function mountTabletPanel(): void {
  const root = document.getElementById('root');
  if (!root) {
    console.error('[tablet] #root not found');
    return;
  }
  // Wipe whatever the webview-ui might have rendered — tablet mode is exclusive.
  root.innerHTML = '';
  const div = document.createElement('div');
  div.style.height = '100%';
  root.appendChild(div);
  createRoot(div).render(<TabletPanel />);
}
