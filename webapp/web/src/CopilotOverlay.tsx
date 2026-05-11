/**
 * CopilotOverlay — pixel-styled OAuth + prompt input UI for the webapp.
 *
 * Listens for server messages routed through the WS bridge:
 *   - copilotStatus      → tracks auth state
 *   - copilotAuthCode    → opens login modal with device code
 *   - copilotAuthPending → keeps polling
 *   - copilotAuthError   → shows error
 *   - copilotAuthComplete → closes modal
 *
 * Sends client messages directly via the shimmed acquireVsCodeApi():
 *   - getCopilotStatus    on mount
 *   - startCopilotAuth    when user clicks "Sign in"
 *   - pollCopilotAuth     every 5s while modal open
 *   - logoutCopilot       from settings
 *   - sendPrompt          when user submits the prompt input
 *
 * The login modal also triggers automatically when the user clicks "+ Agent"
 * without being authenticated. We detect that by intercepting the
 * `copilotStatus: { authenticated: false }` reply that the server sends
 * back when openClaude is rejected (TODO: server doesn't yet send that;
 * we listen for the user manually opening login from the floating button).
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface VsApi {
  postMessage(msg: unknown): void;
}
function vsApi(): VsApi {
  return (globalThis as unknown as { acquireVsCodeApi: () => VsApi }).acquireVsCodeApi();
}

interface AuthCode {
  userCode: string;
  verificationUri: string;
}

function CopilotOverlay() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [authCode, setAuthCode] = useState<AuthCode | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollSeconds, setPollSeconds] = useState(0);
  const [copied, setCopied] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [promptAgentId, setPromptAgentId] = useState<number | null>(null);

  // ── message listener ────────────────────────────────────
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data as { type?: string; [k: string]: unknown };
      if (!msg?.type) return;
      switch (msg.type) {
        case 'copilotStatus':
          setAuthed(Boolean(msg.authenticated));
          if (msg.authenticated) {
            setAuthCode(null);
            setPolling(false);
            setAuthError(null);
          }
          break;
        case 'copilotAuthCode':
          setAuthCode({
            userCode: String(msg.userCode ?? ''),
            verificationUri: String(msg.verificationUri ?? 'https://github.com/login/device'),
          });
          setAuthError(null);
          setPollSeconds(0);
          setPolling(true);
          break;
        case 'copilotAuthPending':
          // keep polling
          break;
        case 'copilotAuthError':
          setAuthError(String(msg.error ?? 'Authentication failed'));
          setPolling(false);
          break;
        case 'copilotAuthComplete':
          setAuthCode(null);
          setPolling(false);
          setAuthed(true);
          break;
      }
    }
    window.addEventListener('message', onMessage);
    vsApi().postMessage({ type: 'getCopilotStatus' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // ── poll loop ───────────────────────────────────────
  // Poll every 2s for snappy UX. Server checks `provider.list().connected`
  // on every poll, so as soon as the user finishes the GitHub flow we
  // detect it within ~2s.
  useEffect(() => {
    if (!polling) return;
    const tick = setInterval(() => {
      setPollSeconds((s) => s + 2);
      vsApi().postMessage({ type: 'pollCopilotAuth' });
    }, 2000);
    return () => clearInterval(tick);
  }, [polling]);

  // ── prompt-input keyboard shortcut: "P" focuses the floating prompt
  // for the currently selected agent. We piggyback on the webview-ui's
  // selection by listening for our own custom event.
  useEffect(() => {
    function onOpenPrompt(e: Event) {
      const detail = (e as CustomEvent).detail as { agentId?: number } | undefined;
      if (!detail || typeof detail.agentId !== 'number') return;
      setPromptAgentId(detail.agentId);
      setPromptOpen(true);
    }
    window.addEventListener('pixel-agents:openPrompt' as keyof WindowEventMap, onOpenPrompt as EventListener);
    return () =>
      window.removeEventListener(
        'pixel-agents:openPrompt' as keyof WindowEventMap,
        onOpenPrompt as EventListener,
      );
  }, []);

  function startLogin() {
    setAuthError(null);
    vsApi().postMessage({ type: 'startCopilotAuth' });
  }

  function logout() {
    vsApi().postMessage({ type: 'logoutCopilot' });
  }

  function submitPrompt() {
    const text = promptText.trim();
    if (!text || promptAgentId == null) return;
    vsApi().postMessage({ type: 'sendPrompt', agentId: promptAgentId, text });
    setPromptText('');
    setPromptOpen(false);
  }

  return (
    <>
      {/* Floating auth status pill, top-left */}
      <div style={pillStyle}>
        <span style={{ opacity: 0.7 }}>Copilot:</span>{' '}
        <span style={{ color: authed ? '#7ee787' : '#f0a020' }}>
          {authed === null ? '…' : authed ? 'connected' : 'signed out'}
        </span>{' '}
        {authed ? (
          <button style={linkBtn} onClick={logout}>
            sign out
          </button>
        ) : (
          <button style={linkBtn} onClick={startLogin}>
            sign in
          </button>
        )}
      </div>

      {/* Device code modal */}
      {authCode && (
        <div style={modalBackdrop}>
          <div style={modalBox}>
            <h2 style={{ margin: '0 0 12px 0', fontSize: 14 }}>Sign in to GitHub Copilot</h2>
            <p style={{ margin: '0 0 8px 0', fontSize: 11 }}>
              1. Click the button below to open GitHub.
            </p>
            <p style={{ margin: '0 0 12px 0', fontSize: 11 }}>2. Paste this code on the GitHub page:</p>
            <div
              style={{ ...codeBox, cursor: 'pointer' }}
              title="Click to copy"
              onClick={() => {
                void navigator.clipboard.writeText(authCode.userCode);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {authCode.userCode}
            </div>
            <p style={{ margin: '12px 0 0 0', fontSize: 10, opacity: 0.7 }}>
              {polling
                ? `Waiting for you to authorize on GitHub… (${pollSeconds.toString()}s)`
                : 'Polling stopped.'}
            </p>
            {copied && (
              <p style={{ color: '#7ee787', fontSize: 10, margin: '4px 0 0 0' }}>Code copied!</p>
            )}
            {authError && (
              <p style={{ color: '#ff8080', fontSize: 10, margin: '8px 0 0 0' }}>{authError}</p>
            )}
            <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                style={btn}
                onClick={() => {
                  void navigator.clipboard.writeText(authCode.userCode);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                Copy code
              </button>
              <a
                href={authCode.verificationUri}
                target="_blank"
                rel="noreferrer"
                style={{ ...btn, background: '#2d4a3a', textDecoration: 'none', color: '#cdd6f4' }}
              >
                Open GitHub ↗
              </a>
              <button
                style={btn}
                onClick={() => {
                  setAuthCode(null);
                  setPolling(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Prompt input modal */}
      {promptOpen && (
        <div style={modalBackdrop} onClick={() => setPromptOpen(false)}>
          <div style={modalBox} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 12px 0', fontSize: 14 }}>
              Send prompt to Agent #{promptAgentId}
            </h2>
            <textarea
              autoFocus
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submitPrompt();
                }
              }}
              placeholder="Type your prompt… (Ctrl+Enter to send)"
              style={textareaStyle}
            />
            <div style={{ marginTop: 12, textAlign: 'right' }}>
              <button style={btn} onClick={() => setPromptOpen(false)}>
                Cancel
              </button>{' '}
              <button style={{ ...btn, background: '#2d4a3a' }} onClick={submitPrompt}>
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── styles ────────────────────────────────────────────────
const pillStyle: React.CSSProperties = {
  position: 'fixed',
  top: 8,
  left: 8,
  background: '#1e1e2e',
  border: '2px solid #444',
  padding: '4px 10px',
  fontSize: 11,
  fontFamily: 'monospace',
  color: '#cdd6f4',
  zIndex: 9999,
  boxShadow: '2px 2px 0px #0a0a14',
};
const linkBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#7ee787',
  cursor: 'pointer',
  textDecoration: 'underline',
  fontSize: 11,
  padding: 0,
  fontFamily: 'monospace',
};
const modalBackdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 10000,
};
const modalBox: React.CSSProperties = {
  background: '#1e1e2e',
  border: '2px solid #7ee787',
  padding: 20,
  minWidth: 320,
  fontFamily: 'monospace',
  color: '#cdd6f4',
  boxShadow: '4px 4px 0px #0a0a14',
};
const codeBox: React.CSSProperties = {
  fontSize: 24,
  letterSpacing: 4,
  background: '#0a0a14',
  padding: '12px 16px',
  textAlign: 'center',
  border: '2px dashed #7ee787',
  color: '#7ee787',
  userSelect: 'all',
};
const btn: React.CSSProperties = {
  background: '#2a2a3e',
  color: '#cdd6f4',
  border: '2px solid #555',
  padding: '4px 12px',
  fontFamily: 'monospace',
  fontSize: 11,
  cursor: 'pointer',
};
const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 100,
  background: '#0a0a14',
  border: '2px solid #444',
  color: '#cdd6f4',
  fontFamily: 'monospace',
  fontSize: 12,
  padding: 8,
  resize: 'vertical',
  boxSizing: 'border-box',
};

export function mountCopilotOverlay() {
  const el = document.getElementById('copilot-overlay');
  if (!el) return;
  createRoot(el).render(<CopilotOverlay />);
}
