import { useState, useEffect } from 'react';
import {
  ClerkProvider,
  SignedIn,
  SignedOut,
  SignIn,
  useAuth as useClerkAuth,
} from "@clerk/clerk-react";
import type { PropsWithChildren } from "react";
import { readConfigValue } from "./runtime-config";

const configuredPublishableKey = readConfigValue("VITE_CLERK_PUBLISHABLE_KEY");
const publishableKey = configuredPublishableKey?.endsWith("_replace_me") ? undefined : configuredPublishableKey;
const localAuthBypass = readConfigValue("VITE_LOCAL_AUTH_BYPASS") === "true";
const localAuthBypassToken = "local.eyJzdWIiOiJkZW1vX2FnZW50X21hcmluYSJ9.bypass";
const localAuth = {
  getToken: async () => localAuthBypassToken
};

// ── Design tokens ─────────────────────────────────────────────────────────────
const ACCENT   = '#34d399';
const BG       = '#080c0a';
const SURFACE  = '#0f1511';
const BORDER   = '#1e2a24';
const TEXT     = '#e8f0eb';
const TEXT_MUTED = '#4d6259';
const FONT = '"Area Normal","Aptos","SF Pro Display","Segoe UI Variable",system-ui,sans-serif';

// ── Talk logo mark ────────────────────────────────────────────────────────────
function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <path d="M3 4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7l-4 3V4Z"
        stroke="#0f1511" strokeWidth="1.6" strokeLinejoin="round" />
      <line x1="7" y1="7" x2="13" y2="7" stroke="#0f1511" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="7" y1="10" x2="11" y2="10" stroke="#0f1511" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// ── Decorative: chat bubble stream ────────────────────────────────────────────
const BUBBLES = [
  { side: 'left',  width: '72%', text: 'Oi! Preciso de ajuda com meu pedido 🙏' },
  { side: 'right', width: '60%', text: 'Claro! Me passa o número do pedido?' },
  { side: 'left',  width: '44%', text: 'É o #34891' },
  { side: 'right', width: '78%', text: 'Encontrei! Saiu hoje às 9h, entrega amanhã até 18h.' },
  { side: 'left',  width: '35%', text: 'Perfeito, obrigada 😊' },
  { side: 'right', width: '50%', text: 'Fico à disposição! 👋' },
  { side: 'left',  width: '62%', text: 'Vocês são incríveis, sempre tão rápidos!' },
  { side: 'right', width: '42%', text: 'Sempre que precisar!' },
];

function ChatBubbles() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      padding: '0 8px',
    }}>
      {BUBBLES.map((b, i) => (
        <div key={i} style={{
          display: 'flex',
          justifyContent: b.side === 'right' ? 'flex-end' : 'flex-start',
        }}>
          <div style={{
            width: b.width,
            padding: '9px 13px',
            borderRadius: b.side === 'right'
              ? '14px 14px 3px 14px'
              : '14px 14px 14px 3px',
            background: b.side === 'right'
              ? 'rgba(52,211,153,0.13)'
              : 'rgba(255,255,255,0.05)',
            border: `1px solid ${b.side === 'right' ? 'rgba(52,211,153,0.2)' : 'rgba(255,255,255,0.07)'}`,
            fontSize: 12,
            lineHeight: 1.5,
            color: b.side === 'right'
              ? 'rgba(232,240,235,0.75)'
              : 'rgba(232,240,235,0.45)',
            fontFamily: FONT,
          }}>
            {b.text}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Login layout ──────────────────────────────────────────────────────────────
function TalkLoginLayout() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 60);
    return () => clearTimeout(t);
  }, []);

  return (
    <>
      <style>{`
        @keyframes talk-bubble-in {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .talk-bubble {
          animation: talk-bubble-in 0.4s ease both;
        }
      `}</style>

      <div style={{
        minHeight: '100vh',
        display: 'flex',
        background: BG,
        fontFamily: FONT,
        color: TEXT,
      }}>
        {/* ── Left brand panel ── */}
        <div style={{
          flex: '0 0 52%',
          maxWidth: 580,
          minHeight: '100vh',
          background: SURFACE,
          borderRight: `1px solid ${BORDER}`,
          display: 'flex',
          flexDirection: 'column',
          padding: '48px 52px',
          position: 'relative',
          overflow: 'hidden',
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'none' : 'translateX(-16px)',
          transition: 'opacity 0.6s ease, transform 0.6s ease',
        }}>
          {/* Radial glow */}
          <div style={{
            position: 'absolute',
            bottom: -120,
            left: -120,
            width: 500,
            height: 500,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(52,211,153,0.06) 0%, transparent 65%)',
            pointerEvents: 'none',
          }} />

          {/* Header */}
          <div>
            <p style={{
              margin: '0 0 24px',
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: `rgba(52,211,153,0.45)`,
            }}>by Prymeira</p>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <div style={{
                width: 36,
                height: 36,
                background: ACCENT,
                borderRadius: 9,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 16px rgba(52,211,153,0.35)',
                flexShrink: 0,
              }}>
                <LogoMark size={18} />
              </div>
              <span style={{ fontSize: 22, fontWeight: 900, letterSpacing: '-0.03em' }}>Talk</span>
            </div>

            <p style={{
              margin: '0 0 36px',
              fontSize: 14,
              lineHeight: 1.65,
              color: TEXT_MUTED,
              maxWidth: '32ch',
            }}>
              Toda conversa com seus clientes, num só lugar.
            </p>

            {/* Feature chips */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 40 }}>
              {['WhatsApp', 'Automações', 'Disparos', 'Relatórios'].map(chip => (
                <span key={chip} style={{
                  padding: '5px 12px',
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 700,
                  color: `rgba(52,211,153,0.65)`,
                  border: `1px solid rgba(52,211,153,0.15)`,
                  background: 'rgba(52,211,153,0.05)',
                }}>{chip}</span>
              ))}
            </div>
          </div>

          {/* Chat bubbles decoration */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{
              background: `${BG}`,
              borderRadius: 16,
              border: `1px solid ${BORDER}`,
              padding: '20px 16px',
              overflow: 'hidden',
            }}>
              {/* Mini topbar */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                paddingBottom: 14,
                borderBottom: `1px solid ${BORDER}`,
                marginBottom: 16,
              }}>
                <div style={{
                  width: 26, height: 26, borderRadius: '50%',
                  background: 'rgba(52,211,153,0.15)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 700, color: ACCENT,
                }}>M</div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: TEXT }}>Marina Costa</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{ width: 5, height: 5, borderRadius: '50%', background: ACCENT }} />
                    <span style={{ fontSize: 9, color: TEXT_MUTED }}>WhatsApp · online</span>
                  </div>
                </div>
              </div>

              <ChatBubbles />
            </div>
          </div>
        </div>

        {/* ── Right auth panel ── */}
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '48px 32px',
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'none' : 'translateX(16px)',
          transition: 'opacity 0.6s ease 0.1s, transform 0.6s ease 0.1s',
        }}>
          <SignIn
            routing="hash"
            appearance={{
              variables: {
                colorBackground: '#0f1511',
                colorInputBackground: '#141c18',
                colorText: '#e8f0eb',
                colorTextSecondary: '#4d6259',
                colorPrimary: '#34d399',
                colorInputText: '#e8f0eb',
                borderRadius: '10px',
                fontFamily: FONT,
              },
              elements: {
                card: {
                  background: '#0f1511',
                  border: '1px solid #1e2a24',
                  boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
                },
                headerTitle: { color: '#e8f0eb' },
                headerSubtitle: { color: '#4d6259' },
                formFieldLabel: { color: '#8da899' },
                formFieldInput: {
                  background: '#141c18',
                  border: '1px solid #1e2a24',
                  color: '#e8f0eb',
                },
                footerActionLink: { color: '#34d399' },
                identityPreviewText: { color: '#8da899' },
                identityPreviewEditButton: { color: '#34d399' },
              },
            }}
          />
        </div>
      </div>
    </>
  );
}

// ── Providers & gate ──────────────────────────────────────────────────────────
export function AuthProvider({ children }: PropsWithChildren) {
  if (localAuthBypass) {
    return <>{children}</>;
  }

  if (!publishableKey) {
    return <div className="center-state">Configure VITE_CLERK_PUBLISHABLE_KEY.</div>;
  }

  return <ClerkProvider publishableKey={publishableKey}>{children}</ClerkProvider>;
}

export function AuthGate({ children }: PropsWithChildren) {
  if (localAuthBypass) {
    return <>{children}</>;
  }

  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <TalkLoginLayout />
      </SignedOut>
    </>
  );
}

export function useTalkAuth() {
  if (localAuthBypass) {
    return localAuth;
  }

  return useClerkAuth();
}
