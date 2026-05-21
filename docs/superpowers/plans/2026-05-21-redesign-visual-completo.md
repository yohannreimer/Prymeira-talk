# Redesign Visual Completo — Prymeira Talk

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o sistema visual do Prymeira Talk pelo design "Sage Premium" — CSS custom properties, fonte Inter, sidebar colapsável e componentes estilo SaaS enterprise — sem alterar nenhuma lógica de negócio.

**Architecture:** Todo o CSS vive em `apps/web/src/styles.css` (2066 linhas). O plano trabalha neste arquivo incrementalmente por fase, adicionando tokens no `:root` primeiro e depois migra cada seção. Mudanças em `.tsx` são cirúrgicas: apenas novos atributos de classe e dois `useState` para sidebar e drawer. Sem novos arquivos CSS.

**Tech Stack:** React 19, TypeScript, Vite, vanilla CSS, Lucide React (já instalado), Inter via Google Fonts

---

## Mapa de Arquivos

| Arquivo | O que muda |
|---------|-----------|
| `apps/web/index.html` | Adiciona `<link>` do Google Fonts (Inter) |
| `apps/web/src/styles.css` | Todas as fases — tokens, shell, inbox, contatos, status, empty states |
| `apps/web/src/features/shell/TalkSuiteShell.tsx` | Estado `sidebarExpanded` + pin button + labels + tooltip |
| `apps/web/src/features/inbox/InboxPage.tsx` | Classes no conversation list, message bubbles, composer (input→textarea + toolbar), context panel |
| `apps/web/src/features/contacts/ContactsPage.tsx` | Estado `drawerContact` + drawer JSX + classes na tabela |

---

## Task 1: Tokens CSS + Fonte Inter

**Files:**
- Modify: `apps/web/index.html`
- Modify: `apps/web/src/styles.css` (linhas 1–15, bloco `:root`)

- [ ] **Step 1: Adicionar Inter no `index.html`**

Substituir:
```html
<title>Prymeira Talk</title>
```
Por:
```html
<title>Prymeira Talk</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
```

- [ ] **Step 2: Substituir o bloco `:root` em `styles.css`**

Substituir o bloco `:root` existente (linhas 1–10, apenas `color`, `background`, `font-family`, `font-synthesis`, `line-height`, `text-rendering`) por:

```css
:root {
  /* Brand */
  --color-brand-600: #24564a;
  --color-brand-700: #1f4f44;
  --color-brand-50:  #eef5f2;
  --color-brand-100: #d4e8e0;

  /* Surface */
  --color-surface-page:   #eef2ed;
  --color-surface-card:   #ffffff;
  --color-surface-subtle: #f7faf8;
  --color-surface-rail:   #1f2f2a;

  /* Text */
  --color-text-primary:   #1e2a25;
  --color-text-secondary: #6d7d75;
  --color-text-muted:     #9bb0a6;
  --color-text-on-dark:   #c5d7cf;

  /* Border */
  --color-border:        #dbe3dc;
  --color-border-subtle: #eef2ed;

  /* Status */
  --color-status-open-bg:      #dcfce7;
  --color-status-open-text:    #15803d;
  --color-status-open-dot:     #22c55e;
  --color-status-waiting-bg:   #fef3c7;
  --color-status-waiting-text: #92400e;
  --color-status-waiting-dot:  #f59e0b;
  --color-status-closed-bg:    #f1f5f9;
  --color-status-closed-text:  #64748b;
  --color-status-closed-dot:   #94a3b8;
  --color-status-bot-bg:       #ede9fe;
  --color-status-bot-text:     #5b21b6;
  --color-status-bot-dot:      #8b5cf6;

  /* Radius */
  --radius-sm:   6px;
  --radius-md:   8px;
  --radius-lg:   10px;
  --radius-xl:   12px;
  --radius-full: 9999px;

  /* Shadow */
  --shadow-card:       0 1px 4px rgba(36, 86, 74, 0.07);
  --shadow-card-hover: 0 2px 8px rgba(36, 86, 74, 0.12);
  --shadow-drawer:    -4px 0 20px rgba(36, 86, 74, 0.15);

  /* Motion */
  --transition-fast: 150ms ease;
  --transition-base: 200ms ease;

  /* Typography */
  --font-family: 'Inter', system-ui, sans-serif;

  /* Defaults globais */
  color:            var(--color-text-primary);
  background:       var(--color-surface-page);
  font-family:      var(--font-family);
  font-synthesis:   none;
  line-height:      1.5;
  text-rendering:   optimizeLegibility;
}
```

- [ ] **Step 3: Verificar no browser**

```bash
cd apps/web && pnpm dev
```

Abrir http://localhost:5173. Verificar que a fonte mudou de Aptos/Segoe para Inter. Inspecionar elemento — `font-family` computado deve ser `Inter`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/index.html apps/web/src/styles.css
git commit -m "feat: add Inter font and CSS design tokens to :root"
```

---

## Task 2: Shell — Sidebar Colapsável

**Files:**
- Modify: `apps/web/src/features/shell/TalkSuiteShell.tsx`
- Modify: `apps/web/src/styles.css` — classes `.talk-suite-shell`, `.app-rail`, `.rail-button`, `.rail-label`, `.rail-pin`

- [ ] **Step 1: Adicionar estado `sidebarExpanded` em `TalkSuiteShell.tsx`**

Adicionar logo após a linha `const [activeModule, setActiveModule] = useState<TalkModuleKey>(readModuleFromUrl);`:

```tsx
const [sidebarExpanded, setSidebarExpanded] = useState<boolean>(() => {
  return localStorage.getItem("sidebar-expanded") === "true";
});

function toggleSidebar() {
  setSidebarExpanded((prev) => {
    const next = !prev;
    localStorage.setItem("sidebar-expanded", String(next));
    return next;
  });
}
```

- [ ] **Step 2: Atualizar o JSX da sidebar em `TalkSuiteShell.tsx`**

Substituir o `<main>` e o `<aside>` pelo seguinte (mantém toda lógica de módulo inalterada):

```tsx
return (
  <main className={`talk-suite-shell${sidebarExpanded ? " sidebar-expanded" : ""}`}>
    <aside className="app-rail" aria-label="Navegacao principal">
      <div className="rail-logo">
        <Bot size={22} aria-hidden="true" />
      </div>
      <button
        className="rail-pin"
        onClick={toggleSidebar}
        title={sidebarExpanded ? "Recolher menu" : "Expandir menu"}
        type="button"
        aria-label={sidebarExpanded ? "Recolher menu" : "Expandir menu"}
      >
        {sidebarExpanded ? "←" : "→"}
      </button>
      <nav className="rail-nav" aria-label="Modulos">
        {talkModules.map(({ key, label, Icon }) => (
          <button
            aria-label={label}
            aria-pressed={activeModule === key}
            className={[
              "rail-button",
              activeModule === key ? "is-active" : "",
              key === "ajustes" ? "rail-settings" : ""
            ]
              .filter(Boolean)
              .join(" ")}
            key={key}
            onClick={() => handleModuleClick(key)}
            title={sidebarExpanded ? undefined : label}
            type="button"
          >
            <Icon size={20} aria-hidden="true" />
            <span className="rail-label">{label}</span>
          </button>
        ))}
      </nav>
    </aside>

    {renderModule(activeModule)}
  </main>
);
```

- [ ] **Step 3: Atualizar CSS da shell em `styles.css`**

Substituir as regras `.talk-suite-shell`, `.app-rail`, `.rail-logo`, `.rail-nav`, `.rail-button` e `.rail-button:hover` existentes por:

```css
.talk-suite-shell {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  height: 100vh;
  min-height: 100vh;
  overflow: hidden;
  transition: grid-template-columns var(--transition-base);
}

.talk-suite-shell.sidebar-expanded {
  grid-template-columns: 240px minmax(0, 1fr);
}

.app-rail {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  background: var(--color-surface-rail);
  padding: 12px 8px;
  overflow: hidden;
  transition: width var(--transition-base);
}

.rail-logo {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border: 0;
  border-radius: var(--radius-md);
  background: var(--color-brand-100);
  color: #173d35;
  flex-shrink: 0;
  align-self: center;
}

.rail-pin {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-on-dark);
  font-size: 12px;
  align-self: center;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.rail-pin:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
}

.rail-nav {
  display: flex;
  width: 100%;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
}

.rail-button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-on-dark);
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  transition: background var(--transition-fast), color var(--transition-fast);
  flex-shrink: 0;
}

.rail-label {
  font-size: 13px;
  font-weight: 500;
  opacity: 0;
  width: 0;
  overflow: hidden;
  transition: opacity var(--transition-base), width var(--transition-base);
}

.sidebar-expanded .rail-label {
  opacity: 1;
  width: auto;
}

.rail-button:hover,
.rail-button:focus-visible {
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
}

.rail-button.is-active {
  background: rgba(255, 255, 255, 0.12);
  color: #ffffff;
}

.rail-button:focus-visible {
  outline: 2px solid var(--color-brand-100);
  outline-offset: 2px;
}

.rail-settings {
  margin-top: auto;
}
```

- [ ] **Step 4: Verificar no browser**

- Sidebar aparece como rail de ícones (72px) por padrão
- Clicar na seta → expande para 240px com labels animados
- Clicar novamente → colapsa de volta
- Recarregar a página → estado persiste (localStorage)
- Hovering sobre ícones colapsados mostra tooltip nativo do browser

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/shell/TalkSuiteShell.tsx apps/web/src/styles.css
git commit -m "feat: collapsible sidebar with pin toggle and localStorage persistence"
```

---

## Task 3: Atendimento — Lista de Conversas (Cards Flutuantes)

**Files:**
- Modify: `apps/web/src/features/inbox/InboxPage.tsx` — seção `conversation-items`
- Modify: `apps/web/src/styles.css` — classes `.conversation-list`, `.conversation-items`, `.conversation-card`

- [ ] **Step 1: Atualizar o JSX da lista de conversas em `InboxPage.tsx`**

Localizar o bloco `<div className="conversation-items">` e substituir o conteúdo do `.map()` de conversas:

```tsx
{conversations.map((conversation) => (
  <button
    className={[
      "conversation-card",
      conversation.id === selectedConversationId ? "is-selected" : ""
    ].filter(Boolean).join(" ")}
    key={conversation.id}
    onClick={() => setSelectedConversationId(conversation.id)}
    type="button"
  >
    <div className="conv-avatar-wrap">
      <span className="conversation-avatar" aria-hidden="true">
        {conversation.contactId.slice(0, 2).toUpperCase()}
      </span>
      <span
        className="conv-online-dot"
        aria-hidden="true"
      />
    </div>
    <span className="conversation-content">
      <span className="conversation-row">
        <span className="conv-name-wrap">
          <strong>{contactDisplayName(conversation)}</strong>
          {conversation.departmentName ? (
            <span className="conv-dept-tag">{conversation.departmentName}</span>
          ) : null}
        </span>
        <span className="conv-meta-right">
          <time className="conv-time">{formatTime(conversation.lastMessageAt)}</time>
          {conversation.unreadCount > 0 ? (
            <span className="conv-unread-badge">{conversation.unreadCount}</span>
          ) : null}
        </span>
      </span>
      <span className="conversation-preview">
        {conversation.lastMessagePreview ?? "Conversa iniciada."}
      </span>
    </span>
  </button>
))}
```

- [ ] **Step 2: Atualizar CSS da lista em `styles.css`**

Localizar e substituir as regras existentes de `.conversation-list`, `.conversation-items`, `.conversation-card`, `.conversation-avatar`, `.conversation-content`, `.conversation-row`, `.conversation-preview`, `.conversation-meta`:

```css
.conversation-list {
  display: flex;
  flex-direction: column;
  background: var(--color-surface-page);
  border-right: 1px solid var(--color-border-subtle);
  height: 100vh;
  overflow: hidden;
}

.list-header {
  padding: 16px 16px 0;
  flex-shrink: 0;
}

.conversation-items {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.conversation-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 12px;
  border: 0;
  border-radius: var(--radius-lg);
  background: var(--color-surface-card);
  box-shadow: var(--shadow-card);
  text-align: left;
  cursor: pointer;
  transition: box-shadow var(--transition-fast), background var(--transition-fast);
}

.conversation-card:hover {
  box-shadow: var(--shadow-card-hover);
}

.conversation-card.is-selected {
  box-shadow: var(--shadow-card-hover);
  background: var(--color-brand-50);
}

.conv-avatar-wrap {
  position: relative;
  flex-shrink: 0;
}

.conversation-avatar {
  display: flex;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-full);
  background: var(--color-brand-600);
  color: #ffffff;
  font-size: 13px;
  font-weight: 700;
  align-items: center;
  justify-content: center;
}

.conv-online-dot {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 10px;
  height: 10px;
  border-radius: var(--radius-full);
  background: var(--color-status-open-dot);
  border: 2px solid var(--color-surface-card);
}

.conversation-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.conversation-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
}

.conv-name-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}

.conv-name-wrap strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conv-dept-tag {
  font-size: 10px;
  font-weight: 600;
  background: var(--color-brand-50);
  color: var(--color-brand-600);
  padding: 1px 7px;
  border-radius: var(--radius-full);
  white-space: nowrap;
}

.conv-meta-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
}

.conv-time {
  font-size: 10px;
  color: var(--color-text-muted);
}

.conv-unread-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: var(--radius-full);
  background: var(--color-brand-600);
  color: #ffffff;
  font-size: 10px;
  font-weight: 600;
}

.conversation-preview {
  font-size: 12px;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

- [ ] **Step 3: Verificar no browser**

- Lista de conversas mostra cards brancos com sombra e gap entre eles
- Cada card tem avatar circular teal + dot verde + nome + tag de dept + timestamp + badge
- Card selecionado tem fundo `#eef5f2` e sombra maior
- Hover anima suavemente em 150ms

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/inbox/InboxPage.tsx apps/web/src/styles.css
git commit -m "feat: floating card conversation list with avatar, dept tag and unread badge"
```

---

## Task 4: Atendimento — Thread de Mensagens (SaaS Premium)

**Files:**
- Modify: `apps/web/src/features/inbox/InboxPage.tsx` — bloco `message-bubble`
- Modify: `apps/web/src/styles.css` — classes `.message-thread`, `.message-bubble`

- [ ] **Step 1: Atualizar o JSX das mensagens em `InboxPage.tsx`**

Localizar o `.map()` de mensagens e substituir o `<article>`:

```tsx
{messages.map((message) => (
  <article
    className={`message-bubble ${message.direction === "outbound" ? "is-outbound" : "is-inbound"}`}
    key={message.id}
  >
    {message.direction === "inbound" ? (
      <span className="msg-avatar" aria-hidden="true">
        {conversation?.contactId.slice(0, 2).toUpperCase() ?? "??"}
      </span>
    ) : null}
    <div className="msg-bubble-body">
      <p>{message.body ?? "Mensagem sem texto."}</p>
      <time>{formatMessageTime(message.createdAt)}</time>
    </div>
  </article>
))}
```

Obs: a variável `conversation` dentro desse map já existe como `selectedConversation` — use `selectedConversation?.contactId`.

- [ ] **Step 2: Atualizar CSS da thread em `styles.css`**

Localizar e substituir as regras de `.message-thread`, `.message-bubble`, `.message-bubble.is-outbound`, `.message-bubble.is-inbound`:

```css
.message-thread {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--color-surface-subtle);
}

.message-bubble {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  max-width: 72%;
  animation: msg-fade-in var(--transition-base) ease;
}

@keyframes msg-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.message-bubble.is-inbound {
  align-self: flex-start;
}

.message-bubble.is-outbound {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.msg-avatar {
  display: flex;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-full);
  background: var(--color-brand-100);
  color: var(--color-brand-600);
  font-size: 10px;
  font-weight: 700;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.msg-bubble-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.message-bubble.is-inbound .msg-bubble-body {
  background: var(--color-surface-card);
  border-radius: 4px 16px 16px 16px;
  padding: 10px 14px;
  box-shadow: var(--shadow-card);
}

.message-bubble.is-outbound .msg-bubble-body {
  background: linear-gradient(135deg, #2a6358, #1f4f44);
  border-radius: 16px 4px 16px 16px;
  padding: 10px 14px;
}

.message-bubble p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}

.message-bubble.is-inbound p {
  color: var(--color-text-primary);
}

.message-bubble.is-outbound p {
  color: #ffffff;
}

.message-bubble time {
  font-size: 10px;
  align-self: flex-end;
}

.message-bubble.is-inbound time {
  color: var(--color-text-muted);
}

.message-bubble.is-outbound time {
  color: rgba(255, 255, 255, 0.55);
}
```

- [ ] **Step 3: Verificar no browser**

- Mensagens do cliente (inbound): avatar de iniciais à esquerda, bolha branca com sombra, borda-radius `4px 16px 16px 16px`
- Mensagens do agente (outbound): sem avatar, bolha com gradiente teal, borda-radius `16px 4px 16px 16px`
- Nova mensagem aparece com fade-in suave

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/inbox/InboxPage.tsx apps/web/src/styles.css
git commit -m "feat: SaaS Premium message bubbles with avatar and gradient"
```

---

## Task 5: Atendimento — Composer com Toolbar Rica

**Files:**
- Modify: `apps/web/src/features/inbox/InboxPage.tsx` — `<form className="composer">`
- Modify: `apps/web/src/styles.css` — classes `.composer`, `.composer-toolbar`, `.composer-input-row`

- [ ] **Step 1: Substituir o form do composer em `InboxPage.tsx`**

Localizar `<form className="composer" ...>` e substituir por:

```tsx
<form className="composer" aria-label="Compositor de mensagem" onSubmit={handleSendMessage}>
  <div className="composer-toolbar" aria-label="Ferramentas de formatação">
    <button type="button" className="composer-tool" aria-label="Negrito" disabled={!selectedConversation}>
      <strong>B</strong>
    </button>
    <button type="button" className="composer-tool" aria-label="Itálico" disabled={!selectedConversation}>
      <em>I</em>
    </button>
    <span className="composer-tool-divider" aria-hidden="true" />
    <button type="button" className="composer-tool" aria-label="Emoji" disabled={!selectedConversation}>
      😊
    </button>
    <button type="button" className="composer-tool" aria-label="Anexo" disabled={!selectedConversation}>
      <Send size={13} aria-hidden="true" />
    </button>
    <span className="composer-tool-spacer" aria-hidden="true" />
    <button type="button" className="composer-quick-replies" disabled={!selectedConversation}>
      Respostas rápidas
    </button>
  </div>
  <div className="composer-input-row">
    <textarea
      aria-label="Mensagem"
      className="composer-textarea"
      disabled={!selectedConversation || isSending}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }}
      placeholder="Escreva uma mensagem..."
      rows={1}
      value={draft}
    />
    <button
      className="composer-send"
      disabled={!selectedConversation || !draft.trim() || isSending}
      type="submit"
      aria-label="Enviar mensagem"
    >
      <Send size={15} aria-hidden="true" />
    </button>
  </div>
</form>
```

- [ ] **Step 2: Adicionar CSS do composer em `styles.css`**

Localizar a regra `.composer` existente e substituir (junto com qualquer `.composer input`, `.composer button`):

```css
.composer {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-surface-card);
  flex-shrink: 0;
}

.composer-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 12px 0;
  border-bottom: 1px solid var(--color-border-subtle);
}

.composer-tool {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.composer-tool:hover:not(:disabled) {
  background: var(--color-surface-subtle);
  color: var(--color-text-primary);
}

.composer-tool:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.composer-tool-divider {
  width: 1px;
  height: 16px;
  background: var(--color-border-subtle);
  margin: 0 4px;
}

.composer-tool-spacer {
  flex: 1;
}

.composer-quick-replies {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-brand-600);
  background: var(--color-brand-50);
  border: 0;
  border-radius: var(--radius-sm);
  padding: 3px 10px;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.composer-quick-replies:hover:not(:disabled) {
  background: var(--color-brand-100);
}

.composer-quick-replies:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.composer-input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 12px;
}

.composer-textarea {
  flex: 1;
  border: 0;
  outline: 0;
  resize: none;
  font-size: 13px;
  color: var(--color-text-primary);
  background: transparent;
  font-family: var(--font-family);
  line-height: 1.5;
  max-height: calc(4 * 1.5 * 13px);
  overflow-y: auto;
}

.composer-textarea::placeholder {
  color: var(--color-text-muted);
}

.composer-send {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: var(--radius-full);
  background: var(--color-brand-600);
  color: #ffffff;
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--transition-fast);
}

.composer-send:hover:not(:disabled) {
  background: var(--color-brand-700);
}

.composer-send:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
```

- [ ] **Step 3: Verificar no browser**

- Composer tem toolbar superior com B, I, emoji, anexo e "Respostas rápidas"
- Input é um textarea que cresce até 4 linhas
- Enter envia, Shift+Enter quebra linha
- Botão enviar é um círculo teal com ícone

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/inbox/InboxPage.tsx apps/web/src/styles.css
git commit -m "feat: rich composer toolbar with textarea and send button"
```

---

## Task 6: Atendimento — Painel de Contexto em Cards

**Files:**
- Modify: `apps/web/src/features/inbox/InboxPage.tsx` — `<aside className="contact-panel">`
- Modify: `apps/web/src/styles.css` — classes `.contact-panel`, `.context-card`, `.context-card-title`, `.context-row`

- [ ] **Step 1: Substituir o JSX do painel de contexto em `InboxPage.tsx`**

Localizar `<aside className="contact-panel" ...>` e substituir por:

```tsx
<aside className="contact-panel" aria-label="Detalhes do contato">
  {/* Card identidade */}
  <div className="context-card context-card--identity">
    <div className="context-identity-avatar" aria-hidden="true">
      {selectedConversation
        ? selectedConversation.contactId.slice(0, 2).toUpperCase()
        : "?"}
    </div>
    <div>
      <div className="context-identity-name">
        {selectedConversation
          ? contactDisplayName(selectedConversation)
          : "Nenhuma conversa"}
      </div>
      {selectedConversation?.channelName ? (
        <div className="context-identity-sub">{selectedConversation.channelName}</div>
      ) : null}
    </div>
  </div>

  {/* Card detalhes */}
  <div className="context-card">
    <div className="context-card-title">Detalhes</div>
    <dl className="context-rows">
      <div className="context-row">
        <dt>Status</dt>
        <dd>{selectedConversation ? statusLabel(selectedConversation.status) : "—"}</dd>
      </div>
      <div className="context-row">
        <dt>Prioridade</dt>
        <dd>{selectedConversation ? priorityLabel(selectedConversation.priority) : "—"}</dd>
      </div>
      <div className="context-row">
        <dt>Departamento</dt>
        <dd>{selectedConversation?.departmentName ?? "Não atribuído"}</dd>
      </div>
      <div className="context-row">
        <dt>Responsável</dt>
        <dd>{selectedConversation?.assignedUserName ?? "Fila geral"}</dd>
      </div>
    </dl>
  </div>

  {/* Card tags */}
  <div className="context-card">
    <div className="context-card-title">Tags</div>
    <div className="tag-row">
      {contactContext?.tags.length ? (
        contactContext.tags.map((tag) => (
          <span key={tag.id} className="context-tag" style={{ borderColor: tag.color }}>
            {tag.name}
          </span>
        ))
      ) : (
        <span className="context-empty-label">Sem tags</span>
      )}
    </div>
  </div>

  {/* Card notas */}
  <div className="context-card">
    <div className="context-card-title">Notas internas</div>
    {contextError ? <p className="error-note compact">{contextError}</p> : null}
    <form className="quick-note-form" onSubmit={handleAddNote}>
      <input
        aria-label="Nova nota"
        disabled={!selectedConversation || isRunningAction}
        onChange={(event) => setNoteDraft(event.target.value)}
        placeholder="Adicionar nota..."
        value={noteDraft}
      />
      <button
        aria-label="Salvar nota"
        disabled={!selectedConversation || !noteDraft.trim() || isRunningAction}
        type="submit"
      >
        <StickyNote size={15} aria-hidden="true" />
      </button>
    </form>
  </div>

  {/* Card ações */}
  <div className="context-card">
    <div className="context-card-title">Ações rápidas</div>
    <div className="quick-actions">
      <button
        disabled={!selectedConversation || isRunningAction}
        onClick={() => void runAction({ action: "assign_current_user" })}
        type="button"
      >
        <UserCheck size={15} aria-hidden="true" />
        Assumir
      </button>
      <button
        disabled={!selectedConversation || isRunningAction}
        onClick={() => void runAction({ action: "request_ai_suggestion" })}
        type="button"
      >
        <Bot size={15} aria-hidden="true" />
        IA
      </button>
    </div>
    {aiSuggestion ? (
      <div className="ai-suggestion">{aiSuggestion}</div>
    ) : null}
    {crmStatus ? (
      <p className="crm-status">{crmStatus}</p>
    ) : null}
  </div>
</aside>
```

- [ ] **Step 2: Adicionar CSS do painel de contexto em `styles.css`**

Substituir regras existentes de `.contact-panel`, `.detail-list`, `.context-panel-head`:

```css
.contact-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  background: var(--color-surface-page);
  border-left: 1px solid var(--color-border-subtle);
  height: 100vh;
  overflow-y: auto;
}

.context-card {
  background: var(--color-surface-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.context-card--identity {
  flex-direction: row;
  align-items: center;
  gap: 10px;
}

.context-identity-avatar {
  display: flex;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-full);
  background: var(--color-brand-600);
  color: #ffffff;
  font-size: 14px;
  font-weight: 700;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.context-identity-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.context-identity-sub {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 2px;
}

.context-card-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--color-brand-600);
  text-transform: uppercase;
  letter-spacing: 0.6px;
}

.context-rows {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 0;
}

.context-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}

.context-row dt {
  font-size: 11px;
  color: var(--color-text-muted);
}

.context-row dd {
  font-size: 11px;
  color: var(--color-text-primary);
  margin: 0;
  text-align: right;
}

.context-tag {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
}

.context-empty-label {
  font-size: 12px;
  color: var(--color-text-muted);
}
```

- [ ] **Step 3: Verificar no browser**

- Painel direito mostra 5 cards empilhados com scroll
- Card de identidade tem avatar 44px + nome + canal
- Card detalhes mostra rows label/valor
- Card notas tem input + botão

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/inbox/InboxPage.tsx apps/web/src/styles.css
git commit -m "feat: context panel redesign with stacked cards"
```

---

## Task 7: Contatos — Tabela + Header com Toggle + Drawer

**Files:**
- Modify: `apps/web/src/features/contacts/ContactsPage.tsx` — adicionar `drawerContact` state + drawer JSX + header
- Modify: `apps/web/src/styles.css` — `.contacts-table`, `.contact-drawer`, `.contact-drawer-overlay`

- [ ] **Step 1: Adicionar estado `drawerContact` em `ContactsPage.tsx`**

Adicionar logo após os estados existentes (após a linha com `const [viewMode, setViewMode] = ...` ou equivalente):

```tsx
const [drawerContact, setDrawerContact] = useState<ContactDto | null>(null);

function openDrawer(contact: ContactDto) {
  setDrawerContact(contact);
}

function closeDrawer() {
  setDrawerContact(null);
}
```

- [ ] **Step 2: Atualizar o JSX da lista de contatos para abrir o drawer ao clicar**

No `.map()` da lista de contatos, adicionar `onClick={() => openDrawer(contact)}` no elemento de linha/linha da tabela (a implementação atual pode usar `<tr>` ou `<div>`). Localizar onde cada contato é clicável e substituir a ação de abertura do formulário lateral pelo `openDrawer(contact)`.

- [ ] **Step 3: Adicionar JSX do drawer no final do return de `ContactsPage`**

Antes do fechamento do `<>` ou elemento raiz do return, adicionar:

```tsx
{/* Drawer de contato */}
{drawerContact ? (
  <>
    <div
      className="contact-drawer-overlay"
      onClick={closeDrawer}
      aria-hidden="true"
    />
    <aside
      className="contact-drawer is-open"
      aria-label="Detalhes do contato"
    >
      <header className="contact-drawer-header">
        <span className="context-card-title">Contato</span>
        <button
          className="drawer-close"
          onClick={closeDrawer}
          type="button"
          aria-label="Fechar"
        >
          ✕
        </button>
      </header>
      <div className="contact-drawer-body">
        {/* Card identidade */}
        <div className="context-card context-card--identity">
          <div className="context-identity-avatar" aria-hidden="true">
            {initials(drawerContact)}
          </div>
          <div>
            <div className="context-identity-name">{contactName(drawerContact)}</div>
            {drawerContact.company ? (
              <div className="context-identity-sub">{drawerContact.company}</div>
            ) : null}
          </div>
        </div>
        {/* Card detalhes */}
        <div className="context-card">
          <div className="context-card-title">Detalhes</div>
          <dl className="context-rows">
            <div className="context-row">
              <dt>Telefone</dt>
              <dd>{drawerContact.phone}</dd>
            </div>
            {drawerContact.email ? (
              <div className="context-row">
                <dt>Email</dt>
                <dd>{drawerContact.email}</dd>
              </div>
            ) : null}
            {drawerContact.company ? (
              <div className="context-row">
                <dt>Empresa</dt>
                <dd>{drawerContact.company}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      </div>
    </aside>
  </>
) : null}
```

- [ ] **Step 4: Adicionar CSS do drawer e tabela em `styles.css`**

```css
/* Tabela de contatos */
.contacts-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--color-surface-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.contacts-table thead tr {
  background: var(--color-surface-subtle);
}

.contacts-table th {
  font-size: 10px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 10px 14px;
  text-align: left;
}

.contacts-table td {
  font-size: 13px;
  color: var(--color-text-primary);
  padding: 10px 14px;
  border-top: 1px solid var(--color-border-subtle);
}

.contacts-table tbody tr {
  cursor: pointer;
  transition: background var(--transition-fast);
}

.contacts-table tbody tr:hover {
  background: var(--color-surface-subtle);
}

.contacts-table-avatar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.contacts-table-avatar-circle {
  display: flex;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-full);
  background: var(--color-brand-600);
  color: #ffffff;
  font-size: 10px;
  font-weight: 700;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* Drawer */
.contact-drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(30, 42, 37, 0.3);
  z-index: 40;
  animation: overlay-in var(--transition-base) ease;
}

@keyframes overlay-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.contact-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 400px;
  background: var(--color-surface-page);
  box-shadow: var(--shadow-drawer);
  z-index: 50;
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform var(--transition-base);
}

.contact-drawer.is-open {
  transform: translateX(0);
}

.contact-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface-card);
}

.drawer-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 14px;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.drawer-close:hover {
  background: var(--color-surface-subtle);
  color: var(--color-text-primary);
}

.contact-drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

@media (max-width: 640px) {
  .contact-drawer {
    width: 100vw;
  }
}
```

- [ ] **Step 5: Atualizar CSS do kanban para usar tokens em `styles.css`**

Localizar as regras existentes do kanban (`.contacts-board`, `.board-column`, `.board-column-header`, `.board-card`) e substituir cores hardcoded por tokens:

```css
.contacts-board {
  display: grid;
  grid-auto-columns: minmax(220px, 280px);
  grid-auto-flow: column;
  gap: 10px;
  padding: 8px;
  overflow-x: auto;
  align-items: start;
}

.board-column {
  background: var(--color-surface-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.board-column-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 2px solid var(--color-brand-600);
  background: var(--color-surface-subtle);
}

.board-column-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-primary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.board-column-count {
  font-size: 10px;
  font-weight: 600;
  background: var(--color-brand-50);
  color: var(--color-brand-600);
  padding: 1px 7px;
  border-radius: var(--radius-full);
}

.board-card {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border-subtle);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.board-card:last-child {
  border-bottom: 0;
}

.board-card:hover {
  background: var(--color-surface-subtle);
}

.board-card-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.board-card-sub {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 2px;
}
```

- [ ] **Step 6: Verificar no browser**

- Clicar em um contato na lista abre o drawer deslizando da direita
- Overlay escurece o fundo
- Clicar no overlay ou no ✕ fecha o drawer com animação
- Drawer mostra cards com identidade e detalhes do contato
- Vista kanban mostra colunas com cabeçalho teal e cards com tokens corretos

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/contacts/ContactsPage.tsx apps/web/src/styles.css
git commit -m "feat: contact detail drawer with overlay, slide animation and kanban token migration"
```

---

## Task 8: Sistema de Status + Empty States + Header de Módulo

**Files:**
- Modify: `apps/web/src/styles.css` — `.status-badge`, `.empty-state`, `.module-header` atualizado
- Modify: `apps/web/src/features/inbox/InboxPage.tsx` — trocar `.status-pill` por `.status-badge`

- [ ] **Step 1: Adicionar CSS de status badges em `styles.css`**

Substituir as regras existentes de `.status-pill`, `.status-pill-open`, `.status-pill-closed`, `.status-pill-pending`:

```css
.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: var(--radius-full);
  font-size: 11px;
  font-weight: 600;
}

.status-badge::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}

.status-badge--open {
  background: var(--color-status-open-bg);
  color: var(--color-status-open-text);
}
.status-badge--open::before { background: var(--color-status-open-dot); }

.status-badge--pending,
.status-badge--waiting {
  background: var(--color-status-waiting-bg);
  color: var(--color-status-waiting-text);
}
.status-badge--pending::before,
.status-badge--waiting::before { background: var(--color-status-waiting-dot); }

.status-badge--closed {
  background: var(--color-status-closed-bg);
  color: var(--color-status-closed-text);
}
.status-badge--closed::before { background: var(--color-status-closed-dot); }

.status-badge--bot {
  background: var(--color-status-bot-bg);
  color: var(--color-status-bot-text);
}
.status-badge--bot::before { background: var(--color-status-bot-dot); }
```

- [ ] **Step 2: Atualizar a classe de status no `InboxPage.tsx`**

Localizar a linha:
```tsx
<span className={`status-pill status-${selectedConversation.status}`}>
```
E substituir por:
```tsx
<span className={`status-badge status-badge--${selectedConversation.status}`}>
```

- [ ] **Step 3: Adicionar CSS de empty states em `styles.css`**

```css
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px 24px;
  text-align: center;
}

.empty-state-icon {
  display: flex;
  width: 64px;
  height: 64px;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  background: var(--color-brand-50);
  color: var(--color-brand-600);
  flex-shrink: 0;
}

.empty-state h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--color-text-primary);
}

.empty-state p {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-muted);
  line-height: 1.5;
  max-width: 220px;
}
```

- [ ] **Step 4: Atualizar o empty state do chat em `InboxPage.tsx`**

Localizar `<div className="chat-empty-state">` e substituir por:

```tsx
<div className="empty-state">
  <div className="empty-state-icon">
    <MessageSquare size={28} aria-hidden="true" />
  </div>
  <h3>Nenhuma conversa selecionada</h3>
  <p>Escolha uma conversa na fila para acompanhar o atendimento.</p>
</div>
```

- [ ] **Step 5: Atualizar CSS do header de módulo em `styles.css`**

Substituir as regras de `.module-header`, `.module-header h1`:

```css
.module-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  background: var(--color-surface-subtle);
  border-bottom: 1px solid var(--color-border-subtle);
  flex-shrink: 0;
}

.module-header h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--color-text-primary);
  line-height: 1.2;
}

.module-tabs {
  display: flex;
  gap: 2px;
  margin-left: 12px;
}

.module-tab {
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-muted);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.module-tab:hover {
  background: var(--color-border-subtle);
  color: var(--color-text-primary);
}

.module-tab.is-active {
  background: var(--color-surface-card);
  color: var(--color-brand-600);
  font-weight: 600;
  box-shadow: var(--shadow-card);
}
```

- [ ] **Step 6: Verificar no browser**

- Status badges mostram dot colorido + label (verde=Aberta, amarelo=Pendente, cinza=Fechada)
- Empty state do chat tem ícone em card teal + título + descrição
- Headers de módulo têm fundo sutil + border-bottom

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/inbox/InboxPage.tsx apps/web/src/styles.css
git commit -m "feat: semantic status badges, empty states and integrated module header"
```

---

## Task 9: Módulos Secundários + Polish Geral

**Files:**
- Modify: `apps/web/src/styles.css` — migrar valores hardcoded restantes para tokens; `.primary-button`, `.secondary-button`, `.icon-button`, `.module-page`, `.search-field`, cards gerais

- [ ] **Step 1: Atualizar botões globais para usar tokens**

Localizar e substituir `.primary-button`, `.secondary-button`, `.icon-button`:

```css
.primary-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: var(--radius-md);
  background: var(--color-brand-600);
  color: #ffffff;
  padding: 9px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.primary-button:hover:not(:disabled) {
  background: var(--color-brand-700);
}

.primary-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.secondary-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-card);
  color: var(--color-text-primary);
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}

.secondary-button:hover:not(:disabled) {
  background: var(--color-surface-subtle);
  border-color: var(--color-brand-100);
}

.secondary-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.icon-button {
  display: inline-grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-card);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}

.icon-button:hover:not(:disabled) {
  background: var(--color-surface-subtle);
  border-color: var(--color-brand-100);
}
```

- [ ] **Step 2: Atualizar `.module-page` e `.search-field` para usar tokens**

Localizar e substituir:

```css
.module-page {
  display: grid;
  align-content: start;
  gap: 16px;
  height: 100vh;
  min-width: 0;
  overflow-y: auto;
  background: var(--color-surface-page);
  padding: 0;
}

.search-field {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-card);
  color: var(--color-text-muted);
  padding: 0 12px;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.search-field input {
  min-width: 0;
  width: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--color-text-primary);
  padding: 10px 0;
  font-size: 13px;
  font-family: var(--font-family);
}

.search-field:focus-within {
  border-color: var(--color-brand-600);
  box-shadow: 0 0 0 3px rgba(36, 86, 74, 0.12);
}
```

- [ ] **Step 3: Atualizar `.segmented-control` para usar tokens**

```css
.segmented-control {
  display: inline-flex;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-subtle);
  padding: 3px;
  gap: 2px;
}

.segmented-control button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.segmented-control button.is-active {
  background: var(--color-brand-600);
  color: #ffffff;
}
```

- [ ] **Step 4: Varredura de valores hardcoded restantes**

Buscar no `styles.css` por valores de cor hardcoded fora do `:root`:

```bash
grep -n '#[0-9a-fA-F]\{3,6\}' apps/web/src/styles.css | grep -v '^[0-9]*:.*:root' | head -40
```

Para cada cor encontrada fora do `:root`, substituir pelo token correspondente da tabela:

| Valor hardcoded | Token substituto |
|----------------|-----------------|
| `#24564a` | `var(--color-brand-600)` |
| `#1f4f44` ou `#1f2f2a` | `var(--color-surface-rail)` ou `var(--color-brand-700)` |
| `#eef2ed` ou `#edf2ee` | `var(--color-surface-page)` |
| `#ffffff` | `var(--color-surface-card)` |
| `#f7faf8` | `var(--color-surface-subtle)` |
| `#1e2a25` ou `#1b2d27` | `var(--color-text-primary)` |
| `#6d7d75` | `var(--color-text-secondary)` |
| `#9bb0a6` | `var(--color-text-muted)` |
| `#c5d7cf` | `var(--color-text-on-dark)` |
| `#dbe3dc` ou `#cfdbd4` | `var(--color-border)` |
| `#eef2ed` (border) | `var(--color-border-subtle)` |

- [ ] **Step 5: Verificar todos os módulos no browser**

Navegar por cada módulo (Canais, Automações, Disparos, Relatórios, Equipe, IA, CRM, Ajustes) e verificar:
- Sem quebras visuais óbvias
- Botões primários e secundários com estilo correto
- Inputs com foco teal suave
- Sem valores hardcoded remanescentes visualmente discrepantes

- [ ] **Step 6: Commit final**

```bash
git add apps/web/src/styles.css
git commit -m "feat: migrate all CSS to design tokens and polish secondary modules"
```

---

## Checklist de Aceitação Final

Marcar cada item após verificar no browser com `pnpm dev`:

- [ ] Fonte Inter aplicada globalmente (inspecionar `font-family` no DevTools)
- [ ] Todos os tokens definidos em `:root` e usados consistentemente
- [ ] Sidebar colapsa/expande com transição suave, estado persiste no reload
- [ ] Lista de conversas: cards flutuantes com avatar, dot online, dept tag, badge de não lidas
- [ ] Thread: bolha inbound com avatar + borda assimétrica; outbound com gradiente teal
- [ ] Composer: toolbar rica (B, I, emoji, respostas rápidas) + textarea que cresce + botão circular
- [ ] Painel de contexto: 5 cards empilhados com scroll
- [ ] Contatos: clicar num contato abre drawer com slide + overlay
- [ ] Status badges: verde=Aberta, amarelo=Pendente/Aguardando, cinza=Fechada, roxo=Bot
- [ ] Empty state do chat com ícone em card teal + título + descrição
- [ ] Hover em cards e botões anima em 150ms
- [ ] Drawer abre/fecha em 200ms
- [ ] Sem regressões em Canais, Automações, Disparos, Relatórios, Equipe, Ajustes
