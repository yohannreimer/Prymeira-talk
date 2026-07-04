import { useState, useEffect } from 'react';

// ── Design tokens ─────────────────────────────────────────────────────────────
const ACCENT   = '#34d399';           // emerald-400 — bright on dark
const ACCENT_DIM = 'rgba(52,211,153,0.10)';
const BG       = '#080c0a';           // near-black with green tint
const SURFACE  = '#0f1511';
const SURFACE2 = '#141c18';
const BORDER   = '#1e2a24';
const BORDER2  = '#192118';
const TEXT     = '#e8f0eb';
const TEXT_SOFT = '#8da899';
const TEXT_MUTED = '#4d6259';
const FONT = '"Area Normal","Aptos","SF Pro Display","Segoe UI Variable",system-ui,sans-serif';

// ── Talk logo mark ────────────────────────────────────────────────────────────
function TalkLogoMark({ size = 20, dark = false }: { size?: number; dark?: boolean }) {
  const c = dark ? '#0f1511' : '#e8f0eb';
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <path d="M3 4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7l-4 3V4Z"
        stroke={c} strokeWidth="1.6" strokeLinejoin="round" />
      <line x1="7" y1="7" x2="13" y2="7" stroke={c} strokeWidth="1.4" strokeLinecap="round" />
      <line x1="7" y1="10" x2="11" y2="10" stroke={c} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// ── Screenshot visual wrapper ─────────────────────────────────────────────────
function ScreenshotVisual({ src, alt }: { src: string; alt: string }) {
  return (
    <div style={{
      height: 380,
      borderRadius: 16,
      border: `1px solid ${BORDER}`,
      overflow: 'hidden',
      boxShadow: '0 40px 100px rgba(0,0,0,0.6), 0 0 0 1px rgba(52,211,153,0.05)',
      position: 'relative',
    }}>
      <img
        src={src}
        alt={alt}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: 'top left',
          display: 'block',
        }}
      />
      {/* subtle green tint overlay at bottom */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 80,
        background: 'linear-gradient(to top, rgba(8,12,10,0.5) 0%, transparent 100%)',
        pointerEvents: 'none',
      }} />
    </div>
  );
}

// ── Coded visual: Inbox mockup (hero) ─────────────────────────────────────────
const CONVERSATIONS = [
  { name: 'Marina Costa', preview: 'Preciso de ajuda com meu pedido', time: '14:32', unread: 2, open: true },
  { name: 'João Silva', preview: 'Boa tarde! Queria saber se...', time: '13:51', unread: 0, open: false },
  { name: 'Ana Beatriz', preview: 'Obrigada pelo atendimento 😊', time: '13:10', unread: 0, open: false },
  { name: 'Carlos M.', preview: 'Quando chega meu produto?', time: '12:44', unread: 1, open: false },
];

const CHAT_MESSAGES = [
  { from: 'customer', text: 'Olá! Fiz um pedido há 5 dias e ainda não recebi.' },
  { from: 'agent', text: 'Oi Marina, tudo bem? Vou verificar agora mesmo para você!' },
  { from: 'customer', text: 'Seria ótimo, o número é #34891.' },
  { from: 'agent', text: 'Encontrei seu pedido. Saiu hoje às 9h, previsão de entrega amanhã até 18h.' },
];

function InboxMockup() {
  return (
    <div style={{
      background: SURFACE,
      borderRadius: 14,
      border: `1px solid ${BORDER}`,
      overflow: 'hidden',
      boxShadow: '0 40px 100px rgba(0,0,0,0.6), 0 0 0 1px rgba(52,211,153,0.05)',
      display: 'flex',
      height: 380,
    }}>
      {/* Sidebar: conversation list */}
      <div style={{
        width: 200,
        borderRight: `1px solid ${BORDER2}`,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}>
        <div style={{
          padding: '10px 12px 8px',
          borderBottom: `1px solid ${BORDER2}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: TEXT }}>Atendimento</span>
          <div style={{
            padding: '2px 6px', borderRadius: 10,
            background: ACCENT_DIM,
            fontSize: 9, fontWeight: 800, color: ACCENT,
          }}>4 abertos</div>
        </div>
        {CONVERSATIONS.map((c, i) => (
          <div key={i} style={{
            padding: '8px 12px',
            borderBottom: `1px solid ${BORDER2}`,
            background: c.open ? 'rgba(52,211,153,0.06)' : 'transparent',
            borderLeft: c.open ? `2px solid ${ACCENT}` : '2px solid transparent',
            cursor: 'pointer',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ fontSize: 11, fontWeight: c.open ? 700 : 500, color: c.open ? TEXT : TEXT_SOFT }}>{c.name}</span>
              <span style={{ fontSize: 9, color: TEXT_MUTED }}>{c.time}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{
                fontSize: 10, color: TEXT_MUTED,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120,
              }}>{c.preview}</span>
              {c.unread > 0 && (
                <div style={{
                  width: 14, height: 14, borderRadius: '50%',
                  background: ACCENT,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 8, fontWeight: 800, color: '#0f1511', flexShrink: 0,
                }}>{c.unread}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Main: chat */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* Chat header */}
        <div style={{
          padding: '10px 14px',
          borderBottom: `1px solid ${BORDER2}`,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            background: 'rgba(52,211,153,0.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, color: ACCENT, flexShrink: 0,
          }}>M</div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: TEXT }}>Marina Costa</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: ACCENT }} />
              <span style={{ fontSize: 9, color: TEXT_MUTED }}>WhatsApp · online</span>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6, overflow: 'hidden' }}>
          {CHAT_MESSAGES.map((msg, i) => (
            <div key={i} style={{
              display: 'flex',
              justifyContent: msg.from === 'agent' ? 'flex-end' : 'flex-start',
            }}>
              <div style={{
                maxWidth: '75%',
                padding: '6px 10px',
                borderRadius: msg.from === 'agent' ? '10px 10px 2px 10px' : '10px 10px 10px 2px',
                background: msg.from === 'agent' ? 'rgba(52,211,153,0.15)' : SURFACE2,
                border: `1px solid ${msg.from === 'agent' ? 'rgba(52,211,153,0.2)' : BORDER}`,
                fontSize: 10,
                color: TEXT_SOFT,
                lineHeight: 1.45,
              }}>{msg.text}</div>
            </div>
          ))}
        </div>

        {/* Input */}
        <div style={{
          padding: '8px 14px',
          borderTop: `1px solid ${BORDER2}`,
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <div style={{
            flex: 1, height: 28, borderRadius: 8,
            background: SURFACE2, border: `1px solid ${BORDER}`,
            display: 'flex', alignItems: 'center', padding: '0 10px',
          }}>
            <span style={{ fontSize: 10, color: TEXT_MUTED }}>Responder...</span>
          </div>
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: ACCENT,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 6h10M6 1l5 5-5 5" stroke="#0f1511" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Feature visual 1: Automation flow ─────────────────────────────────────────
const AUTO_NODES = [
  { x: 60,  y: 20, label: 'Nova mensagem',    type: 'trigger' },
  { x: 60,  y: 90, label: 'Fora do horário?', type: 'condition' },
  { x: 10,  y: 170, label: 'Mensagem automática', type: 'action' },
  { x: 160, y: 170, label: 'Atribuir ao time', type: 'action' },
  { x: 85,  y: 250, label: 'Notificar agente', type: 'action' },
];

function AutomationVisual() {
  const nodeColors = { trigger: ACCENT, condition: '#60a5fa', action: BORDER };
  const nodeTextColors = { trigger: '#0f1511', condition: '#1e3a5f', action: TEXT_SOFT };

  return (
    <div style={{
      height: 380,
      background: SURFACE2,
      borderRadius: 16,
      border: `1px solid ${BORDER}`,
      padding: '24px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: TEXT_MUTED, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 16 }}>
        Fluxo de automação
      </div>

      {/* SVG connections */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        {/* trigger → condition */}
        <line x1="50%" y1="75" x2="50%" y2="100" stroke={BORDER} strokeWidth="1.5" strokeDasharray="4,3" />
        {/* condition → left action */}
        <line x1="45%" y1="115" x2="25%" y2="175" stroke={BORDER} strokeWidth="1.5" strokeDasharray="4,3" />
        {/* condition → right action */}
        <line x1="55%" y1="115" x2="75%" y2="175" stroke={BORDER} strokeWidth="1.5" strokeDasharray="4,3" />
        {/* both → bottom */}
        <line x1="25%" y1="205" x2="50%" y2="255" stroke={BORDER} strokeWidth="1.5" strokeDasharray="4,3" />
        <line x1="75%" y1="205" x2="50%" y2="255" stroke={BORDER} strokeWidth="1.5" strokeDasharray="4,3" />
        {/* No labels */}
        <text x="32%" y="145" fill={ACCENT} fontSize="8" textAnchor="middle">Sim</text>
        <text x="68%" y="145" fill="#60a5fa" fontSize="8" textAnchor="middle">Não</text>
      </svg>

      {/* Nodes */}
      {AUTO_NODES.map((node, i) => {
        const type = node.type as keyof typeof nodeColors;
        return (
          <div key={i} style={{
            position: 'absolute',
            left: `calc(${node.x / 2.8}% + 12px)`,
            top: node.y + 48,
            transform: 'translateX(-50%)',
            padding: '5px 12px',
            borderRadius: 8,
            background: type === 'trigger'
              ? 'rgba(52,211,153,0.15)'
              : type === 'condition'
                ? 'rgba(96,165,250,0.12)'
                : SURFACE,
            border: `1px solid ${type === 'trigger' ? 'rgba(52,211,153,0.3)' : type === 'condition' ? 'rgba(96,165,250,0.25)' : BORDER}`,
            fontSize: 10,
            fontWeight: 600,
            color: type === 'trigger' ? ACCENT : type === 'condition' ? '#60a5fa' : TEXT_SOFT,
            whiteSpace: 'nowrap',
          }}>{node.label}</div>
        );
      })}

      {/* Stats */}
      <div style={{ position: 'absolute', bottom: 20, left: 24, right: 24, display: 'flex', gap: 10 }}>
        {[
          { label: 'Ativações hoje', value: '148' },
          { label: 'Taxa de resolução', value: '91%' },
          { label: 'Tempo médio', value: '< 2 min' },
        ].map(({ label, value }) => (
          <div key={label} style={{
            flex: 1,
            background: SURFACE,
            borderRadius: 8,
            padding: '8px 10px',
            border: `1px solid ${BORDER}`,
          }}>
            <div style={{ fontSize: 13, fontWeight: 900, color: ACCENT, lineHeight: 1 }}>{value}</div>
            <div style={{ fontSize: 9, color: TEXT_MUTED, marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Feature visual 2: Campaign broadcast ──────────────────────────────────────
const CAMPAIGN_CONTACTS = [
  { name: 'Ana Paula', status: 'entregue', time: '09:01' },
  { name: 'Bruno Costa', status: 'lido', time: '09:02' },
  { name: 'Carla Silva', status: 'respondeu', time: '09:03' },
  { name: 'Diego Mendes', status: 'entregue', time: '09:01' },
  { name: 'Elena Rocha', status: 'lido', time: '09:04' },
];

const STATUS_COLORS: Record<string, string> = {
  entregue: '#60a5fa',
  lido: '#a78bfa',
  respondeu: ACCENT,
};

function CampaignVisual() {
  return (
    <div style={{
      height: 380,
      background: SURFACE2,
      borderRadius: 16,
      border: `1px solid ${BORDER}`,
      padding: '20px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
    }}>
      {/* Campaign header */}
      <div style={{
        padding: '12px 14px',
        background: SURFACE,
        borderRadius: 10,
        border: `1px solid ${BORDER}`,
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: ACCENT_DIM,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 7l4-4 3 3 5-5" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M1 12h12" stroke={ACCENT} strokeWidth="1.2" strokeLinecap="round" opacity="0.4" />
          </svg>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: TEXT, marginBottom: 2 }}>Promoção de Inverno 2025</div>
          <div style={{ fontSize: 10, color: TEXT_MUTED }}>2.840 contatos · WhatsApp · Enviado hoje às 09:00</div>
        </div>
      </div>

      {/* Stats bar */}
      <div style={{ display: 'flex', gap: 8 }}>
        {[
          { label: 'Enviado', value: '2.840', color: TEXT_SOFT },
          { label: 'Entregue', value: '2.791', color: '#60a5fa' },
          { label: 'Lido', value: '1.943', color: '#a78bfa' },
          { label: 'Respondeu', value: '312', color: ACCENT },
        ].map(({ label, value, color }) => (
          <div key={label} style={{
            flex: 1,
            background: SURFACE,
            borderRadius: 8,
            padding: '7px 8px',
            border: `1px solid ${BORDER}`,
            textAlign: 'center',
          }}>
            <div style={{ fontSize: 13, fontWeight: 900, color, lineHeight: 1 }}>{value}</div>
            <div style={{ fontSize: 8, color: TEXT_MUTED, marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
          <span style={{ fontSize: 10, color: TEXT_MUTED }}>Taxa de leitura</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: ACCENT }}>68,4%</span>
        </div>
        <div style={{ height: 5, background: SURFACE, borderRadius: 3, border: `1px solid ${BORDER}`, overflow: 'hidden' }}>
          <div style={{ width: '68%', height: '100%', background: ACCENT, borderRadius: 3 }} />
        </div>
      </div>

      {/* Contact list */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: TEXT_MUTED, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
          Atividade recente
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {CAMPAIGN_CONTACTS.map((c, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '5px 8px',
              background: SURFACE,
              borderRadius: 6,
              border: `1px solid ${BORDER}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{
                  width: 20, height: 20, borderRadius: '50%',
                  background: 'rgba(52,211,153,0.1)',
                  fontSize: 8, fontWeight: 700, color: ACCENT,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>{c.name[0]}</div>
                <span style={{ fontSize: 10, color: TEXT_SOFT }}>{c.name}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 9, color: STATUS_COLORS[c.status] ?? TEXT_MUTED, fontWeight: 600 }}>{c.status}</span>
                <span style={{ fontSize: 9, color: TEXT_MUTED }}>{c.time}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Feature visual 3: Reports / metrics ───────────────────────────────────────
const REPORT_BARS = [28, 42, 35, 58, 72, 65, 80, 68, 75, 88, 70, 82];
const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function ReportsVisual() {
  return (
    <div style={{
      height: 380,
      background: SURFACE2,
      borderRadius: 16,
      border: `1px solid ${BORDER}`,
      padding: '20px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    }}>
      {/* KPI cards */}
      <div style={{ display: 'flex', gap: 10 }}>
        {[
          { label: 'Conversas hoje', value: '347', delta: '+12%' },
          { label: 'Tempo médio', value: '3m 42s', delta: '-8%' },
          { label: 'CSAT', value: '4.8/5', delta: '+0.2' },
        ].map(({ label, value, delta }) => (
          <div key={label} style={{
            flex: 1,
            background: SURFACE,
            borderRadius: 10,
            border: `1px solid ${BORDER}`,
            padding: '10px 12px',
          }}>
            <div style={{ fontSize: 9, color: TEXT_MUTED, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: TEXT, lineHeight: 1 }}>{value}</div>
            <div style={{ fontSize: 9, fontWeight: 700, color: ACCENT, marginTop: 3 }}>{delta}</div>
          </div>
        ))}
      </div>

      {/* Bar chart */}
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: TEXT_MUTED, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>
          Conversas por mês
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 120 }}>
          {REPORT_BARS.map((h, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
              <div style={{
                width: '100%',
                height: `${h}%`,
                borderRadius: '3px 3px 0 0',
                background: i === REPORT_BARS.length - 1
                  ? ACCENT
                  : 'rgba(52,211,153,0.25)',
              }} />
              <span style={{ fontSize: 7, color: TEXT_MUTED }}>{MONTHS[i]}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Agent breakdown */}
      <div style={{ display: 'flex', gap: 8 }}>
        {[
          { channel: 'Time de vendas', pct: 58, color: '#22c55e' },
          { channel: 'Suporte', pct: 30, color: ACCENT },
          { channel: 'Bot', pct: 12, color: '#60a5fa' },
        ].map(({ channel, pct, color }) => (
          <div key={channel} style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 9, color: TEXT_MUTED }}>{channel}</span>
              <span style={{ fontSize: 9, fontWeight: 700, color }}>{pct}%</span>
            </div>
            <div style={{ height: 3, background: SURFACE, borderRadius: 2 }}>
              <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Screenshot visual binders ─────────────────────────────────────────────────
function InboxScreenshot() {
  return <ScreenshotVisual src="/screenshots/inbox.jpg" alt="Inbox de atendimento do Prymeira Talk" />;
}
function ContatosScreenshot() {
  return <ScreenshotVisual src="/screenshots/contatos.jpg" alt="Lista de contatos do Prymeira Talk" />;
}
function AutomaçõesScreenshot() {
  return <ScreenshotVisual src="/screenshots/automações.jpg" alt="Editor visual de automações do Prymeira Talk" />;
}
function DisparosScreenshot() {
  return <ScreenshotVisual src="/screenshots/disparos.jpg" alt="Disparos e campanhas do Prymeira Talk" />;
}
function RelatoriosScreenshot() {
  return <ScreenshotVisual src="/screenshots/relatorios.jpg" alt="Relatórios de atendimento do Prymeira Talk" />;
}

// ── Features config ───────────────────────────────────────────────────────────
const FEATURES = [
  {
    id: 'inbox',
    label: 'Atendimento',
    headline: 'Todos os seus clientes do WhatsApp, numa fila organizada.',
    body: 'Inbox compartilhada entre agentes, com histórico completo de cada contato. Distribua conversas, adicione tags e responda sem perder o fio.',
    Visual: InboxScreenshot,
  },
  {
    id: 'contatos',
    label: 'Contatos',
    headline: 'Sua base de clientes centralizada e sempre atualizada.',
    body: 'Gerencie todos os contatos com histórico de conversas, empresa, e-mail e campos customizados. Busque, filtre e organize em segundos.',
    Visual: ContatosScreenshot,
  },
  {
    id: 'automation',
    label: 'Automações',
    headline: 'Fluxos que trabalham enquanto sua equipe descansa.',
    body: 'Monte automações visuais para triagem, respostas fora do horário, redistribuição de fila e muito mais — sem escrever uma linha de código.',
    Visual: AutomaçõesScreenshot,
  },
  {
    id: 'campaigns',
    label: 'Disparos',
    headline: 'Alcance milhares de contatos com uma campanha.',
    body: 'Envie mensagens em massa para sua base de contatos via WhatsApp com template aprovado. Agende, acompanhe e analise cada envio em tempo real.',
    Visual: DisparosScreenshot,
  },
  {
    id: 'reports',
    label: 'Relatórios',
    headline: 'Dados que ajudam a tomar a decisão certa.',
    body: 'Volume de atendimentos, tempo de resposta e performance por agente — tudo num painel em tempo real.',
    Visual: RelatoriosScreenshot,
  },
];

// ── Nav ───────────────────────────────────────────────────────────────────────
function Nav({ mounted }: { mounted: boolean }) {
  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 48px',
      height: 56,
      background: 'rgba(8,12,10,0.88)',
      backdropFilter: 'blur(12px)',
      borderBottom: `1px solid ${BORDER2}`,
      opacity: mounted ? 1 : 0,
      transition: 'opacity 0.5s ease',
      fontFamily: FONT,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <div style={{
          width: 30, height: 30,
          background: ACCENT,
          borderRadius: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 12px rgba(52,211,153,0.3)',
        }}>
          <TalkLogoMark size={16} dark />
        </div>
        <span style={{ fontSize: 16, fontWeight: 900, letterSpacing: '-0.03em', color: TEXT }}>Talk</span>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(52,211,153,0.4)', marginLeft: 4 }}>by Prymeira</span>
      </div>
      <a href="/" style={{
        display: 'inline-flex', alignItems: 'center',
        padding: '7px 16px',
        background: ACCENT,
        color: '#0f1511',
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 700,
        textDecoration: 'none',
        boxShadow: '0 4px 14px rgba(52,211,153,0.3)',
      }}>
        Entrar
      </a>
    </header>
  );
}

// ── Hero ──────────────────────────────────────────────────────────────────────
function Hero({ mounted }: { mounted: boolean }) {
  return (
    <section style={{
      maxWidth: 1200,
      margin: '0 auto',
      padding: '80px 48px 64px',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 64,
      alignItems: 'center',
      fontFamily: FONT,
    }}>
      <div style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'none' : 'translateY(20px)',
        transition: 'opacity 0.7s ease 0.1s, transform 0.7s ease 0.1s',
      }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 12px',
          borderRadius: 20,
          background: ACCENT_DIM,
          border: `1px solid rgba(52,211,153,0.2)`,
          marginBottom: 28,
        }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: ACCENT }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: ACCENT, letterSpacing: '0.04em' }}>Atendimento via WhatsApp</span>
        </div>

        <h1 style={{
          margin: '0 0 20px',
          fontSize: 'clamp(32px, 4vw, 54px)',
          fontWeight: 900,
          lineHeight: 1.08,
          letterSpacing: '-0.04em',
          color: TEXT,
        }}>
          Toda conversa,{' '}
          <span style={{ color: ACCENT }}>num só lugar.</span>
        </h1>

        <p style={{
          margin: '0 0 36px',
          fontSize: 17,
          lineHeight: 1.65,
          color: TEXT_MUTED,
          maxWidth: '38ch',
        }}>
          Gerencie todo seu atendimento via WhatsApp, automatize respostas e entenda seus dados — tudo numa plataforma só.
        </p>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 36 }}>
          <a href="/" style={{
            display: 'inline-flex', alignItems: 'center',
            padding: '13px 24px',
            background: ACCENT,
            color: '#0f1511',
            borderRadius: 10,
            fontSize: 15,
            fontWeight: 700,
            textDecoration: 'none',
            boxShadow: '0 6px 20px rgba(52,211,153,0.32)',
          }}>
            Começar grátis
          </a>
          <a href="#features" style={{
            display: 'inline-flex', alignItems: 'center',
            padding: '13px 24px',
            background: 'transparent',
            color: TEXT_SOFT,
            borderRadius: 10,
            fontSize: 15,
            fontWeight: 600,
            textDecoration: 'none',
            border: `1px solid ${BORDER}`,
          }}>
            Ver como funciona
          </a>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {['WhatsApp Business', 'Automações', 'Disparos', 'Relatórios', 'IA'].map(chip => (
            <span key={chip} style={{
              padding: '5px 12px',
              borderRadius: 20,
              fontSize: 11,
              fontWeight: 700,
              color: 'rgba(232,240,235,0.3)',
              border: `1px solid rgba(232,240,235,0.08)`,
            }}>{chip}</span>
          ))}
        </div>
      </div>

      <div style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'none' : 'translateY(24px)',
        transition: 'opacity 0.7s ease 0.25s, transform 0.7s ease 0.25s',
      }}>
        <ScreenshotVisual src="/screenshots/inbox.jpg" alt="Inbox de atendimento do Prymeira Talk" />
      </div>
    </section>
  );
}

// ── Features gallery ──────────────────────────────────────────────────────────
function Features({ activeIdx, setActiveIdx }: { activeIdx: number; setActiveIdx: (i: number) => void }) {
  const feature = FEATURES[activeIdx];
  const Visual = feature.Visual;

  return (
    <section id="features" style={{
      background: SURFACE,
      borderTop: `1px solid ${BORDER2}`,
      borderBottom: `1px solid ${BORDER2}`,
      padding: '72px 0',
      fontFamily: FONT,
    }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 48px' }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 48, flexWrap: 'wrap' }}>
          {FEATURES.map((f, i) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setActiveIdx(i)}
              style={{
                padding: '8px 18px',
                borderRadius: 20,
                border: i === activeIdx ? `1px solid rgba(52,211,153,0.4)` : `1px solid ${BORDER}`,
                background: i === activeIdx ? ACCENT_DIM : 'transparent',
                color: i === activeIdx ? ACCENT : TEXT_MUTED,
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: FONT,
                transition: 'all 0.2s ease',
              }}
            >{f.label}</button>
          ))}
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: '340px 1fr',
          gap: 56,
          alignItems: 'start',
        }}>
          <div>
            <h2 style={{
              margin: '0 0 16px',
              fontSize: 26,
              fontWeight: 900,
              lineHeight: 1.2,
              letterSpacing: '-0.03em',
              color: TEXT,
            }}>{feature.headline}</h2>
            <p style={{
              margin: 0,
              fontSize: 15,
              lineHeight: 1.7,
              color: TEXT_MUTED,
            }}>{feature.body}</p>

            <div style={{ display: 'flex', gap: 6, marginTop: 32 }}>
              {FEATURES.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveIdx(i)}
                  style={{
                    width: i === activeIdx ? 20 : 6,
                    height: 6,
                    borderRadius: 3,
                    background: i === activeIdx ? ACCENT : BORDER,
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    transition: 'all 0.3s ease',
                  }}
                />
              ))}
            </div>
          </div>

          <div>
            <Visual />
          </div>
        </div>
      </div>
    </section>
  );
}

// ── How it works ──────────────────────────────────────────────────────────────
const HOW_STEPS = [
  { n: '01', title: 'Conecte seu WhatsApp', body: 'Integre seu número via API oficial do WhatsApp Business em minutos. Sem código.' },
  { n: '02', title: 'Configure sua equipe', body: 'Adicione agentes, crie grupos e defina regras de distribuição de conversas.' },
  { n: '03', title: 'Monte automações', body: 'Triagem automática, respostas rápidas e fluxos de bot no construtor visual.' },
  { n: '04', title: 'Acompanhe os dados', body: 'Relatórios em tempo real de volume, SLA, satisfação e performance por agente.' },
];

function HowItWorks() {
  return (
    <section style={{ padding: '80px 48px', maxWidth: 1200, margin: '0 auto', fontFamily: FONT }}>
      <div style={{ textAlign: 'center', marginBottom: 56 }}>
        <p style={{ margin: '0 0 10px', fontSize: 11, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'rgba(52,211,153,0.45)' }}>
          Como funciona
        </p>
        <h2 style={{ margin: 0, fontSize: 34, fontWeight: 900, letterSpacing: '-0.03em', color: TEXT }}>
          Pronto para atender em{' '}
          <span style={{ color: ACCENT }}>4 passos.</span>
        </h2>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24 }}>
        {HOW_STEPS.map((step, i) => (
          <div key={i} style={{
            padding: '24px 20px',
            background: SURFACE,
            borderRadius: 12,
            border: `1px solid ${BORDER}`,
            position: 'relative',
          }}>
            <div style={{ fontSize: 11, fontWeight: 900, color: ACCENT, letterSpacing: '0.08em', marginBottom: 14, opacity: 0.7 }}>{step.n}</div>
            <h3 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 700, color: TEXT, lineHeight: 1.3 }}>{step.title}</h3>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: TEXT_MUTED }}>{step.body}</p>
            {i < HOW_STEPS.length - 1 && (
              <div style={{ position: 'absolute', right: -13, top: '50%', transform: 'translateY(-50%)', fontSize: 16, color: BORDER }}>›</div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── CTA ───────────────────────────────────────────────────────────────────────
function CTA() {
  return (
    <section style={{
      margin: '0 48px 80px',
      background: 'linear-gradient(135deg, #0c1410 0%, #121e18 100%)',
      border: `1px solid rgba(52,211,153,0.12)`,
      borderRadius: 20,
      padding: '64px 52px',
      position: 'relative',
      overflow: 'hidden',
      fontFamily: FONT,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      textAlign: 'center',
    }}>
      <div style={{
        position: 'absolute', top: -60, left: '50%', transform: 'translateX(-50%)',
        width: 400, height: 400, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(52,211,153,0.06) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      <p style={{ margin: '0 0 8px', fontSize: 11, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'rgba(52,211,153,0.45)' }}>
        Prymeira Talk
      </p>
      <h2 style={{
        margin: '0 0 16px',
        fontSize: 'clamp(28px, 4vw, 44px)',
        fontWeight: 900,
        letterSpacing: '-0.04em',
        lineHeight: 1.1,
        color: TEXT,
        maxWidth: '16em',
      }}>
        Comece a atender{' '}
        <span style={{ color: ACCENT }}>melhor.</span>
      </h2>
      <p style={{ margin: '0 0 36px', fontSize: 16, color: TEXT_MUTED, lineHeight: 1.6, maxWidth: '40ch' }}>
        Conecte seus canais hoje e veja sua equipe atender com muito mais agilidade.
      </p>
      <a href="/" style={{
        display: 'inline-flex', alignItems: 'center',
        padding: '15px 32px',
        background: ACCENT,
        color: '#0f1511',
        borderRadius: 12,
        fontSize: 16,
        fontWeight: 800,
        textDecoration: 'none',
        boxShadow: '0 8px 28px rgba(52,211,153,0.3)',
      }}>
        Criar conta gratuitamente
      </a>
    </section>
  );
}

// ── Footer ────────────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer style={{
      padding: '24px 48px',
      borderTop: `1px solid ${BORDER2}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      fontFamily: FONT,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 22, height: 22, background: ACCENT, borderRadius: 5,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <TalkLogoMark size={12} dark />
        </div>
        <span style={{ fontSize: 13, fontWeight: 700, color: TEXT_SOFT }}>Talk</span>
      </div>
      <span style={{ fontSize: 12, color: TEXT_MUTED }}>© 2025 Prymeira. Todos os direitos reservados.</span>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(52,211,153,0.35)' }}>
        by Prymeira
      </span>
    </footer>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export function TalkLandingPage() {
  const [mounted, setMounted] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 60);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setActiveIdx(i => (i + 1) % FEATURES.length), 4500);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ background: BG, minHeight: '100vh', color: TEXT, fontFamily: FONT }}>
      <Nav mounted={mounted} />
      <Hero mounted={mounted} />
      <Features activeIdx={activeIdx} setActiveIdx={setActiveIdx} />
      <HowItWorks />
      <CTA />
      <Footer />
    </div>
  );
}
