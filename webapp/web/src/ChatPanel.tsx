/**
 * ChatPanel — right-side panel that shows the conversation with the selected
 * agent. Listens for `agentMessage` from the server: streamed `text_delta`s
 * arrive without `final`; we accumulate them on the latest assistant entry.
 * `final: true` either marks the entry complete (for assistant) or pushes a
 * brand-new finalized user message.
 *
 * Selection is driven by the same `pixel-agents:openPrompt` event used by
 * the prompt modal — clicking a character now both opens the prompt modal
 * AND surfaces the chat panel.
 */

import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  done: boolean;
}

interface VsApi {
  postMessage(msg: unknown): void;
}
function vsApi(): VsApi {
  return (globalThis as unknown as { acquireVsCodeApi: () => VsApi }).acquireVsCodeApi();
}

function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState<number | null>(null);
  const [agentNames, setAgentNames] = useState<Record<number, string>>({});
  const [conversations, setConversations] = useState<Record<number, ChatMessage[]>>({});
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // ── message listener ──────────────────────────────────────
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data as { type?: string; [k: string]: unknown };
      if (!msg?.type) return;

      switch (msg.type) {
        case 'agentCreated': {
          const id = Number(msg.id);
          const name = String(msg.folderName ?? msg.name ?? '');
          if (Number.isFinite(id) && name) {
            setAgentNames((prev) => ({ ...prev, [id]: name }));
          }
          break;
        }
        case 'existingAgents': {
          const folderNames = (msg.folderNames ?? {}) as Record<string, string>;
          if (folderNames && Object.keys(folderNames).length > 0) {
            setAgentNames((prev) => {
              const next = { ...prev };
              for (const [k, v] of Object.entries(folderNames)) next[Number(k)] = v;
              return next;
            });
          }
          break;
        }
        case 'agentClosed': {
          const id = Number(msg.id);
          if (Number.isFinite(id)) {
            setAgentNames((prev) => {
              const next = { ...prev };
              delete next[id];
              return next;
            });
            setConversations((prev) => {
              if (!(id in prev)) return prev;
              const next = { ...prev };
              delete next[id];
              return next;
            });
          }
          break;
        }
        case 'agentMessage': {
          const id = Number(msg.agentId);
          const role = msg.role === 'user' ? 'user' : 'assistant';
          const text = String(msg.text ?? '');
          const final = Boolean(msg.final);
          if (!Number.isFinite(id)) break;
          setConversations((prev) => {
            const list = prev[id] ? [...prev[id]] : [];
            const last = list[list.length - 1];
            if (role === 'assistant' && !final && last && last.role === 'assistant' && !last.done) {
              // append delta to the in-progress assistant message
              list[list.length - 1] = { ...last, text: last.text + text };
            } else if (role === 'assistant' && final) {
              // mark current assistant message as done; if none in progress
              // and we have buffered text, push it.
              if (last && last.role === 'assistant' && !last.done) {
                list[list.length - 1] = { ...last, done: true };
              } else if (text) {
                list.push({ role: 'assistant', text, done: true });
              }
            } else if (role === 'user') {
              list.push({ role: 'user', text, done: true });
            } else {
              // assistant + non-final + no in-progress message → start one
              list.push({ role: 'assistant', text, done: false });
            }
            return { ...prev, [id]: list };
          });
          break;
        }
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Selection: react to character clicks (same event as the prompt modal).
  useEffect(() => {
    function onSelect(e: Event) {
      const detail = (e as CustomEvent).detail as { agentId?: number } | undefined;
      if (!detail || typeof detail.agentId !== 'number') return;
      setAgentId(detail.agentId);
      setOpen(true);
    }
    window.addEventListener(
      'pixel-agents:openPrompt' as keyof WindowEventMap,
      onSelect as EventListener,
    );
    return () =>
      window.removeEventListener(
        'pixel-agents:openPrompt' as keyof WindowEventMap,
        onSelect as EventListener,
      );
  }, []);

  // Auto-scroll on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversations, agentId, open]);

  function send() {
    const text = draft.trim();
    if (!text || agentId == null) return;
    vsApi().postMessage({ type: 'sendPrompt', agentId, text });
    setDraft('');
  }

  if (!open) return null;
  const messages = agentId != null ? conversations[agentId] ?? [] : [];
  const title = agentId != null ? agentNames[agentId] ?? `Agent #${agentId}` : 'Agent';

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span style={{ flex: 1 }}>
          <span style={{ opacity: 0.6 }}>chat:</span>{' '}
          <span style={{ color: '#7ee787' }}>{title}</span>
        </span>
        <button style={iconBtnStyle} onClick={() => setOpen(false)} title="Close">
          ×
        </button>
      </div>

      <div ref={scrollRef} style={listStyle}>
        {messages.length === 0 && (
          <div style={{ opacity: 0.5, fontSize: 11 }}>No messages yet. Type below to send.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <div style={roleStyle(m.role)}>{m.role === 'user' ? 'you' : 'assistant'}</div>
            <div style={bubbleStyle(m.role)}>
              {m.text || (m.role === 'assistant' && !m.done ? '…' : '')}
            </div>
          </div>
        ))}
      </div>

      <div style={composerStyle}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          style={textareaStyle}
        />
        <button style={sendBtnStyle} onClick={send} disabled={!draft.trim() || agentId == null}>
          Send
        </button>
      </div>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────
const panelStyle: React.CSSProperties = {
  position: 'fixed',
  top: 8,
  right: 8,
  width: 380,
  maxHeight: 'calc(100vh - 16px)',
  background: '#1e1e2e',
  border: '2px solid #7ee787',
  boxShadow: '4px 4px 0px #0a0a14',
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'monospace',
  color: '#cdd6f4',
  zIndex: 9998,
};
const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '6px 10px',
  borderBottom: '2px solid #444',
  fontSize: 12,
  background: '#16161f',
};
const iconBtnStyle: React.CSSProperties = {
  background: 'transparent',
  color: '#cdd6f4',
  border: '1px solid #444',
  width: 22,
  height: 22,
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: '18px',
  fontFamily: 'monospace',
  padding: 0,
};
const listStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: 10,
  fontSize: 12,
  minHeight: 200,
};
const composerStyle: React.CSSProperties = {
  borderTop: '2px solid #444',
  padding: 8,
  display: 'flex',
  gap: 6,
};
const textareaStyle: React.CSSProperties = {
  flex: 1,
  background: '#0a0a14',
  border: '2px solid #444',
  color: '#cdd6f4',
  fontFamily: 'monospace',
  fontSize: 12,
  padding: 6,
  resize: 'none',
  height: 56,
  boxSizing: 'border-box',
};
const sendBtnStyle: React.CSSProperties = {
  background: '#2d4a3a',
  color: '#cdd6f4',
  border: '2px solid #555',
  padding: '0 14px',
  fontFamily: 'monospace',
  fontSize: 11,
  cursor: 'pointer',
};
function roleStyle(role: 'user' | 'assistant'): React.CSSProperties {
  return {
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 1,
    opacity: 0.6,
    color: role === 'user' ? '#7aa2f7' : '#7ee787',
    marginBottom: 2,
  };
}
function bubbleStyle(role: 'user' | 'assistant'): React.CSSProperties {
  return {
    background: role === 'user' ? '#1a2335' : '#0f1a14',
    border: `1px solid ${role === 'user' ? '#2a3a5a' : '#2a4a3a'}`,
    padding: '6px 8px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: 12,
    lineHeight: 1.4,
  };
}

export function mountChatPanel() {
  let el = document.getElementById('chat-panel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'chat-panel';
    document.body.appendChild(el);
  }
  createRoot(el).render(<ChatPanel />);
}
