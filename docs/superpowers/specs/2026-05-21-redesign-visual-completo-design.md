# Redesign Visual Completo — Prymeira Talk

**Data:** 2026-05-21
**Escopo:** Redesign visual de toda a interface do Prymeira Talk (11 módulos)
**Stack:** React 19 + Vite + TypeScript + vanilla CSS (styles.css único)

---

## Resumo

Substituição completa do sistema visual do Prymeira Talk, evoluindo do design atual (Aptos/Segoe UI, CSS hardcoded, sem tokens) para um sistema coeso baseado em CSS custom properties, tipografia Inter e linguagem visual "Sage Premium" — light mode profissional com sidebar verde-escura, superfícies off-white e componentes estilo SaaS enterprise.

---

## 1. Fundação Visual

### 1.1 Direção: Sage Premium
- Light mode como modo principal
- Sidebar escura (`#1f2f2a`) contrastando com corpo claro
- Superfícies off-white (`#eef2ed`) como fundo de página
- Cards brancos (`#ffffff`) como superfície de conteúdo
- Estilo referência: Intercom, Linear, Zendesk

### 1.2 Tipografia
- **Fonte:** Inter (substituir Aptos/Segoe UI)
- Importar via Google Fonts ou arquivo local
- Pesos utilizados: 400 (body), 500 (label), 600 (botão/tab), 700 (título de módulo)
- Escala de tamanhos: 11px (micro), 12px (label/caption), 13px (body), 14px (subtitle), 15–18px (título de módulo)

### 1.3 Sistema de Tokens (CSS Custom Properties)
Converter todos os valores hardcoded de `styles.css` para variáveis em `:root`:

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

  /* Status — semântico */
  --color-status-open-bg:   #dcfce7;
  --color-status-open-text: #15803d;
  --color-status-open-dot:  #22c55e;

  --color-status-waiting-bg:   #fef3c7;
  --color-status-waiting-text: #92400e;
  --color-status-waiting-dot:  #f59e0b;

  --color-status-closed-bg:   #f1f5f9;
  --color-status-closed-text: #64748b;
  --color-status-closed-dot:  #94a3b8;

  --color-status-bot-bg:   #ede9fe;
  --color-status-bot-text: #5b21b6;
  --color-status-bot-dot:  #8b5cf6;

  /* Radius */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 10px;
  --radius-xl: 12px;
  --radius-full: 9999px;

  /* Shadow */
  --shadow-card: 0 1px 4px rgba(36, 86, 74, 0.07);
  --shadow-card-hover: 0 2px 8px rgba(36, 86, 74, 0.12);
  --shadow-drawer: -4px 0 20px rgba(36, 86, 74, 0.15);

  /* Motion */
  --transition-fast: 150ms ease;
  --transition-base: 200ms ease;

  /* Typography */
  --font-family: 'Inter', system-ui, sans-serif;
}
```

---

## 2. Shell — Sidebar Colapsável

### Comportamento
- **Estado padrão:** rail de ícones (72px) — apenas ícones, sem labels
- **Estado expandido:** sidebar completa (240px) com ícones + labels de módulo
- **Mecanismo:** botão pin (📌) no topo da sidebar expande/colapsa; estado persistido em `localStorage`
- **Transição:** `width` com `var(--transition-base)` e `overflow: hidden`

### Visual
- Fundo: `var(--color-surface-rail)` (`#1f2f2a`)
- Ícone ativo: fundo `rgba(255,255,255,0.12)`, cor `#ffffff`
- Ícone inativo: cor `var(--color-text-on-dark)` com hover `rgba(255,255,255,0.08)`
- Logo Prymeira no topo, ícone de configurações no rodapé
- Tooltips com nome do módulo aparecem no hover quando colapsada

---

## 3. Padrão de Módulo

### 3.1 Cabeçalho de Módulo (Header integrado com tabs)
Cada módulo abre com um header colado ao conteúdo principal:

```
┌─────────────────────────────────────────────────────┐
│  Atendimento          [Todas] [Minhas] [Bot]  [Filtrar] [+ Nova]  │
├─────────────────────────────────────────────────────┤
│  conteúdo do módulo...                              │
```

- Header dentro do card de conteúdo, separado por `border-bottom`
- Tabs de filtro rápido à esquerda do título (quando aplicável)
- Ações primária e secundária à direita
- Background do header: `var(--color-surface-subtle)`

### 3.2 Empty States
Quando a lista está vazia:
- Ícone contextual (24px Lucide) dentro de card `64×64px` com `border-radius: 16px` e fundo `var(--color-brand-50)`
- Título em 15px/700, cor `var(--color-text-primary)`
- Descrição em 12px, cor `var(--color-text-muted)`, max-width 220px
- Botão CTA primário abaixo orientando o próximo passo
- Ícone varia por módulo (balão=Atendimento, pessoa=Contatos, raio=Automações, etc.)

---

## 4. Módulo Atendimento (Inbox)

Layout de 3 painéis em grid:
```
[Lista de conversas 280–360px] [Thread central flex] [Contexto do contato 260–320px]
```

### 4.1 Lista de Conversas — Cards Flutuantes
- Fundo da lista: `var(--color-surface-page)`
- Cada conversa = card branco com `border-radius: var(--radius-lg)` e `var(--shadow-card)`
- Espaçamento entre cards: 4px (padding no container)
- **Anatomia do card:**
  - Avatar 40px circular com indicador de status online (dot 10px: verde=online, amarelo=ausente)
  - Nome em 13px/600, preview da última mensagem em 12px/muted
  - Tag de departamento colorida (pill) ao lado do nome
  - Timestamp 10px/muted + badge de não lidas (pill teal) no canto superior direito
- **Estado ativo:** `box-shadow: var(--shadow-card-hover)` + fundo ligeiramente destacado
- **Hover:** `var(--transition-fast)` no box-shadow

### 4.2 Thread de Mensagens — SaaS Premium
- Fundo: `var(--color-surface-subtle)`
- **Mensagem do cliente:**
  - Avatar 28px circular com iniciais à esquerda
  - Bolha: fundo branco, `border-radius: 4px 16px 16px 16px`, `var(--shadow-card)`
  - Timestamp 10px/muted abaixo da bolha
- **Mensagem do agente:**
  - Sem avatar
  - Bolha: `background: linear-gradient(135deg, #2a6358, #1f4f44)`, `border-radius: 16px 4px 16px 16px`
  - Texto branco, timestamp 10px em `rgba(255,255,255,0.55)` + checkmarks
- Separadores de data centralizados (linha + texto muted)
- Scroll automático ao receber nova mensagem

### 4.3 Barra de Composição — Toolbar Rica
Posicionada no rodapé do painel central:

```
┌─────────────────────────────────────────────────┐
│ B  I  |  😊  📎  🗂  |        Respostas rápidas │  ← toolbar
├─────────────────────────────────────────────────┤
│ Digite uma mensagem...                    [►]   │  ← input + enviar
└─────────────────────────────────────────────────┘
```

- Toolbar superior: botões de formatação (B, I), emoji picker, anexo, templates; botão "Respostas rápidas" à direita
- Input: `<textarea>` sem borda, resize:none, cresce até 4 linhas com `overflow-y: auto`
- Botão enviar: círculo 34px teal, ícone send branco
- `border-top: 1px solid var(--color-border-subtle)`

### 4.4 Painel de Contexto — Cards por Seção
Scroll vertical com cards empilhados:
1. **Card de identidade:** avatar grande + nome + telefone (sempre visível no topo)
2. **Card Detalhes:** email, empresa, agente atribuído — layout de duas colunas label/valor
3. **Card Tags:** pills coloridas editáveis
4. **Card Histórico:** lista compacta das últimas conversas
5. **Card Notas internas:** textarea para anotações do agente

Cada card: `background: #fff`, `border-radius: var(--radius-lg)`, `var(--shadow-card)`, `padding: 12px`

---

## 5. Módulo Contatos

### 5.1 Vista Padrão: Lista/Tabela
- Toggle lista ↔ kanban no header (segmented control ou dois botões)
- **Tabela:** colunas Avatar+Nome | Empresa | Telefone | Tags | Ações
- Cabeçalho da tabela: fundo `var(--color-surface-subtle)`, labels uppercase 10px/muted
- Linhas alternadas com hover `var(--color-surface-subtle)` + transição `var(--transition-fast)`
- Avatar: 28px circular com iniciais

### 5.2 Vista Kanban
- Colunas com cabeçalho colorido na borda superior (cor por estágio)
- Cards de contato dentro das colunas: nome + empresa, 8px radius
- Drag & drop entre colunas (manter comportamento atual)
- Contador de itens por coluna em pill

### 5.3 Abrir Contato: Drawer deslizante
- Slide da direita com `transform: translateX()` + `var(--transition-base)`
- Largura: 400px (desktop), 100vw (mobile)
- Overlay semitransparente atrás (`rgba(30,42,37,0.3)`)
- Conteúdo: mesma estrutura de cards do painel de contexto do Atendimento
- Fechar: botão ✕ no header do drawer ou clicar no overlay

---

## 6. Sistema de Status

Badges com fundo colorido + dot + label, aplicado consistentemente em toda a app:

| Status | Fundo | Texto | Dot |
|--------|-------|-------|-----|
| Aberto | `#dcfce7` | `#15803d` | `#22c55e` |
| Aguardando | `#fef3c7` | `#92400e` | `#f59e0b` |
| Fechado | `#f1f5f9` | `#64748b` | `#94a3b8` |
| Bot | `#ede9fe` | `#5b21b6` | `#8b5cf6` |

- Anatomia: `dot (6px circular) + label texto`
- Border-radius: `var(--radius-full)`
- Padding: `4px 12px`
- Font: 11px/600

---

## 7. Motion

Apenas transições funcionais, nunca decorativas:

| Elemento | Propriedade | Duração |
|----------|-------------|---------|
| Hover em card | `box-shadow`, `background` | 150ms ease |
| Hover em botão | `background`, `color` | 150ms ease |
| Foco em input | `border-color`, `box-shadow` | 150ms ease |
| Abertura de drawer | `transform: translateX()` | 200ms ease |
| Sidebar expand/collapse | `width` | 200ms ease |
| Fade de nova mensagem | `opacity` 0→1 | 200ms ease |

Sem animações de entrada em listas, sem spring physics, sem delays encadeados.

---

## 8. Módulos Secundários

Os módulos Canais, Automações, Disparos, Relatórios, Equipe, IA, CRM e Ajustes herdam todos os padrões acima:
- Mesmo header integrado com tabs (quando aplicável)
- Mesmos cards brancos com `var(--shadow-card)`
- Mesma tipografia e tokens
- Mesmo sistema de status onde relevante
- Empty states com ícone contextual por módulo

Módulo Relatórios: cards de métricas com número grande (clamp(1.5rem, 4vw, 2.5rem)/700) + label muted abaixo + variação percentual colorida (verde/vermelho). Gráficos de barra mantêm o padrão SVG atual, apenas com as novas cores via tokens.

---

## 9. Estratégia de Implementação

### Abordagem
Substituição incremental do `styles.css` único — não criar novos arquivos CSS por componente (fora do escopo desta fase). Migrar em blocos:

1. **Fase 1:** Adicionar tokens (`:root` com todas as custom properties) + trocar fonte para Inter
2. **Fase 2:** Shell — sidebar colapsável + rail de ícones
3. **Fase 3:** Módulo Atendimento completo (lista, thread, composer, painel)
4. **Fase 4:** Módulo Contatos (tabela, kanban, drawer)
5. **Fase 5:** Sistema de status + empty states + header padrão
6. **Fase 6:** Módulos secundários + polish geral

### Compatibilidade
- Sem mudanças em nenhum arquivo TypeScript/React nesta fase (apenas CSS + pequenas adições de classe)
- Exceções necessárias em React: sidebar state (colapsada/expandida) via `useState` + `localStorage`; drawer de contato via `useState`

---

## 10. Checklist de Aceitação

- [ ] Fonte Inter carregada e aplicada globalmente
- [ ] Todos os tokens definidos em `:root`, zero valores hardcoded fora do `:root`
- [ ] Sidebar colapsa/expande com transição suave, estado persistido
- [ ] Lista de conversas exibe cards flutuantes com avatar, tag, badge
- [ ] Thread exibe bolhas SaaS Premium (avatar cliente, gradiente agente)
- [ ] Composer tem toolbar rica sempre visível
- [ ] Painel de contexto em cards empilhados com scroll
- [ ] Contatos abre em drawer com overlay + slide animation
- [ ] Todos os status usam o sistema semântico (verde/amarelo/cinza/roxo)
- [ ] Empty states com ícone + CTA em todos os módulos
- [ ] Hover e foco com transição 150ms em todos os elementos interativos
- [ ] Drawer abre/fecha com 200ms
- [ ] App sem regressões visuais em Canais, Automações, Disparos, Relatórios, Equipe, Ajustes
