import { useEffect, useMemo, useRef, useState } from "react";
import type { SupplierDto } from "@prymeira-talk/shared";
import { ArrowLeft, ArrowRight, Check, Lock, Plus, Search, Star, Trash2, UserPlus, X } from "lucide-react";
import { useTalkAuth } from "../../app/auth";
import { addDaysIso, formatCep, formatPhone, moneyInputValue, parseMoney, quantity, shortDate, todayIso } from "./format";
import type { PurchasingView } from "./PurchasingPage";
import { purchasingApi } from "./purchasing-api";
import { Avatar, Field, Skeleton, useToast } from "./ui";

type ItemDraft = { key: number; description: string; quantity: string; unit: string; specification: string };
const UNITS = ["un", "cx", "kg", "m", "m²", "L", "pct", "par"];
const PAYMENTS = ["PIX à vista", "Boleto 30 dias", "Cartão", "A combinar"];
const STEPS = ["O que comprar", "Prazos e condições", "Para quem pedir"] as const;

let itemSeq = 0;
const newItem = (): ItemDraft => ({ key: ++itemSeq, description: "", quantity: "", unit: "un", specification: "" });

function parseQuantity(text: string) {
  const value = Number(text.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function NewRequestWizard({ go }: { go: (view: PurchasingView) => void }) {
  const { getToken } = useTalkAuth();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<"fwd" | "back">("fwd");
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);

  const [items, setItems] = useState<ItemDraft[]>(() => [newItem()]);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [responseDeadline, setResponseDeadline] = useState(() => addDaysIso(todayIso(), 3));
  const [deliveryDeadline, setDeliveryDeadline] = useState(() => addDaysIso(todayIso(), 15));
  const [cep, setCep] = useState("");
  const [city, setCity] = useState("");
  const [ceiling, setCeiling] = useState("");
  const [payment, setPayment] = useState("");
  const [invoice, setInvoice] = useState(true);
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const autoTitle = useMemo(() => {
    const first = items.find((item) => item.description.trim());
    if (!first) return "";
    const amount = parseQuantity(first.quantity);
    const head = `${amount ? `${quantity(amount)} ` : ""}${first.description.trim()}`;
    const rest = items.filter((item) => item.description.trim()).length - 1;
    return rest > 0 ? `${head} e mais ${rest}` : head;
  }, [items]);
  const finalTitle = (titleTouched ? title : autoTitle).trim();

  const problems = useMemo(() => {
    const list: string[][] = [[], [], []];
    const filled = items.filter((item) => item.description.trim() || item.quantity.trim());
    if (!filled.length) list[0]!.push("Adicione pelo menos um item.");
    for (const item of filled) {
      if (!item.description.trim()) list[0]!.push("Todo item precisa de uma descrição.");
      else if (!parseQuantity(item.quantity)) list[0]!.push(`Informe a quantidade de "${item.description.trim()}".`);
    }
    if (!finalTitle) list[0]!.push("Dê um nome ao pedido.");
    if (cep.replace(/\D/g, "").length !== 8) list[1]!.push("Informe o CEP de entrega com 8 dígitos.");
    if (responseDeadline < todayIso()) list[1]!.push("O prazo para receber orçamentos já passou.");
    if (responseDeadline > deliveryDeadline) list[1]!.push("O prazo de resposta precisa vir antes da entrega.");
    if (ceiling.trim() && !parseMoney(ceiling)) list[1]!.push("O teto não é um valor válido.");
    if (!selected.size) list[2]!.push("Escolha pelo menos um fornecedor.");
    return list;
  }, [items, finalTitle, cep, responseDeadline, deliveryDeadline, ceiling, selected]);

  function move(next: number) {
    if (next > step && problems[step]!.length) { setTried(true); return; }
    setTried(false);
    setDirection(next > step ? "fwd" : "back");
    setStep(next);
  }

  async function submit() {
    if (problems.some((list) => list.length)) { setTried(true); return; }
    setSaving(true);
    try {
      const request = await purchasingApi.createRequest(getToken, {
        title: finalTitle,
        items: items.filter((item) => item.description.trim()).map((item) => ({
          description: item.description.trim(), quantity: parseQuantity(item.quantity)!, unit: item.unit.trim() || "un",
          specification: item.specification.trim() || null
        })),
        responseDeadline, deliveryDeadline, deliveryCep: cep, deliveryCity: city.trim() || null,
        budgetCeilingCents: ceiling.trim() ? parseMoney(ceiling) : null, paymentPreference: payment || null,
        requiresInvoice: invoice, notes: notes.trim() || null, supplierIds: [...selected]
      });
      toast("Pedido criado");
      go({ kind: "request", id: request.id });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Não foi possível criar o pedido.", "error");
      setSaving(false);
    }
  }

  const preview = buildPreview({ items, responseDeadline, deliveryDeadline, city, cep, invoice });

  return (
    <div className="po-stack po-wizard">
      <header className="po-head">
        <div>
          <button className="po-back" onClick={() => go({ kind: "list" })} type="button"><ArrowLeft size={15} aria-hidden="true" /> Orçamentos</button>
          <h1>Novo pedido de orçamento</h1>
        </div>
      </header>

      <ol className="po-steps" aria-label="Etapas">
        {STEPS.map((label, index) => (
          <li className={index === step ? "is-on" : index < step ? "is-done" : ""} key={label}>
            <button disabled={index > step && problems.slice(step, index).some((list) => list.length)} onClick={() => move(index)} type="button">
              <span className="po-step-dot">{index < step ? <Check size={13} aria-hidden="true" /> : index + 1}</span>
              <span>{label}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className={`po-wizard-grid${step === 2 ? " has-preview" : ""}`}>
        <div className={`po-panel po-step-panel po-slide-${direction}`} key={step}>
          {step === 0 ? (
            <ItemsStep items={items} setItems={setItems} title={titleTouched ? title : autoTitle}
              setTitle={(value) => { setTitle(value); setTitleTouched(true); }} />
          ) : null}
          {step === 1 ? (
            <div className="po-form">
              <div className="po-grid-2">
                <Field label="Receber orçamentos até" hint="Depois disso a IA para de cobrar quem não respondeu." htmlFor="po-response">
                  <input id="po-response" min={todayIso()} onChange={(event) => setResponseDeadline(event.target.value)} type="date" value={responseDeadline} />
                  <QuickDates onPick={setResponseDeadline} value={responseDeadline} options={[[1, "amanhã"], [2, "2 dias"], [3, "3 dias"], [7, "1 semana"]]} />
                </Field>
                <Field label="Entrega até" hint="Propostas que entregam depois disso aparecem com alerta." htmlFor="po-delivery">
                  <input id="po-delivery" min={responseDeadline} onChange={(event) => setDeliveryDeadline(event.target.value)} type="date" value={deliveryDeadline} />
                  <QuickDates onPick={setDeliveryDeadline} value={deliveryDeadline} options={[[7, "1 semana"], [15, "15 dias"], [30, "30 dias"]]} />
                </Field>
              </div>
              <div className="po-grid-2">
                <Field label="CEP de entrega" hint="Para o fornecedor calcular o frete." htmlFor="po-cep">
                  <input autoComplete="postal-code" id="po-cep" inputMode="numeric" onChange={(event) => setCep(formatCep(event.target.value.replace(/\D/g, "").slice(0, 8)))} placeholder="89201-000" value={cep} />
                </Field>
                <Field label="Cidade (opcional)" htmlFor="po-city">
                  <input id="po-city" onChange={(event) => setCity(event.target.value)} placeholder="Blumenau" value={city} />
                </Field>
              </div>
              <Field label={<span className="po-label-row">Teto do pedido (opcional) <span className="po-private"><Lock size={11} aria-hidden="true" /> nunca é dito ao fornecedor</span></span>}
                hint="Usado só para te alertar quando uma proposta passa do valor." htmlFor="po-ceiling">
                <div className="po-money-input"><span>R$</span><input id="po-ceiling" inputMode="decimal" onBlur={() => { const cents = parseMoney(ceiling); if (cents) setCeiling(moneyInputValue(cents)); }}
                  onChange={(event) => setCeiling(event.target.value)} placeholder="18.000" value={ceiling} /></div>
              </Field>
              <Field label="Pagamento que você prefere">
                <div className="po-chips">
                  {PAYMENTS.map((option) => (
                    <button aria-pressed={payment === option} className={`po-chip${payment === option ? " is-on" : ""}`} key={option}
                      onClick={() => setPayment(payment === option ? "" : option)} type="button">{option}</button>
                  ))}
                </div>
              </Field>
              <label className="po-switch">
                <input checked={invoice} onChange={(event) => setInvoice(event.target.checked)} type="checkbox" />
                <span className="po-switch-track" aria-hidden="true"><span /></span>
                <span>Precisa de nota fiscal</span>
              </label>
              <Field label="Observações para o fornecedor (opcional)" htmlFor="po-notes">
                <textarea id="po-notes" onChange={(event) => setNotes(event.target.value)} placeholder="Ex.: entrega só em horário comercial, precisa subir 2 andares." rows={3} value={notes} />
              </Field>
            </div>
          ) : null}
          {step === 2 ? <SuppliersStep selected={selected} setSelected={setSelected} /> : null}

          {tried && problems[step]!.length ? (
            <div className="po-alert po-alert-warn" role="alert">{problems[step]![0]}</div>
          ) : null}
        </div>

        {step === 2 ? (
          <aside className="po-preview" aria-label="Prévia da primeira mensagem">
            <span className="po-eyebrow">Primeira mensagem no WhatsApp</span>
            <div className="po-phone">
              <div className="po-bubble po-bubble-out">{preview.split("\n").map((line, index) => <span key={index}>{line}<br /></span>)}<time>agora</time></div>
            </div>
            <p className="po-muted po-small">O agente comprador escreve a mensagem com o tom configurado em Agentes. Nesta versão o envio ainda não é automático; você registra as propostas no pedido.</p>
          </aside>
        ) : null}
      </div>

      <footer className="po-wizard-foot">
        {step > 0 ? <button className="po-btn po-btn-ghost" onClick={() => move(step - 1)} type="button"><ArrowLeft size={15} aria-hidden="true" /> Voltar</button> : <span />}
        <span className="po-grow" />
        {step < 2 ? (
          <button className="po-btn po-btn-primary" onClick={() => move(step + 1)} type="button">Continuar <ArrowRight size={15} aria-hidden="true" /></button>
        ) : (
          <button className="po-btn po-btn-primary" disabled={saving} onClick={() => void submit()} type="button">
            {saving ? <span className="po-spinner" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
            Criar pedido {selected.size ? `com ${selected.size} ${selected.size === 1 ? "fornecedor" : "fornecedores"}` : ""}
          </button>
        )}
      </footer>
    </div>
  );
}

function QuickDates({ options, onPick, value }: { options: Array<[number, string]>; onPick: (iso: string) => void; value: string }) {
  return (
    <div className="po-chips po-chips-sm">
      {options.map(([days, label]) => {
        const iso = addDaysIso(todayIso(), days);
        return <button aria-pressed={value === iso} className={`po-chip${value === iso ? " is-on" : ""}`} key={days} onClick={() => onPick(iso)} type="button">{label}</button>;
      })}
    </div>
  );
}

function ItemsStep({ items, setItems, title, setTitle }: {
  items: ItemDraft[]; setItems: (update: (items: ItemDraft[]) => ItemDraft[]) => void; title: string; setTitle: (value: string) => void;
}) {
  const lastAdded = useRef<number | null>(null);
  useEffect(() => {
    if (lastAdded.current === null) return;
    document.getElementById(`po-item-${lastAdded.current}`)?.focus();
    lastAdded.current = null;
  }, [items.length]);
  const update = (key: number, patch: Partial<ItemDraft>) => setItems((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));
  const add = () => { const item = newItem(); lastAdded.current = item.key; setItems((current) => [...current, item]); };

  return (
    <div className="po-form">
      <div className="po-items">
        <div className="po-items-head" aria-hidden="true"><span>Item</span><span>Quantidade</span><span>Unidade</span><span /></div>
        {items.map((item, index) => (
          <div className="po-item-row" key={item.key}>
            <div className="po-item-main">
              <input aria-label={`Item ${index + 1}`} id={`po-item-${item.key}`} onChange={(event) => update(item.key, { description: event.target.value })}
                placeholder={index === 0 ? "Ex.: Cadeira giratória com braço" : "Outro item"} value={item.description} />
              <input aria-label={`Especificação do item ${index + 1}`} className="po-item-spec" onChange={(event) => update(item.key, { specification: event.target.value })}
                placeholder="Especificação, marca, cor, medida (opcional)" value={item.specification} />
            </div>
            <input aria-label={`Quantidade do item ${index + 1}`} className="po-num" inputMode="decimal" onChange={(event) => update(item.key, { quantity: event.target.value })}
              onKeyDown={(event) => { if (event.key === "Enter" && index === items.length - 1) { event.preventDefault(); add(); } }} placeholder="20" value={item.quantity} />
            <input aria-label={`Unidade do item ${index + 1}`} list="po-units" onChange={(event) => update(item.key, { unit: event.target.value })} value={item.unit} />
            <button aria-label={`Remover item ${index + 1}`} className="po-icon-btn" disabled={items.length === 1}
              onClick={() => setItems((current) => current.filter((candidate) => candidate.key !== item.key))} type="button"><Trash2 size={15} /></button>
          </div>
        ))}
        <datalist id="po-units">{UNITS.map((unit) => <option key={unit} value={unit} />)}</datalist>
        <button className="po-add-row" onClick={add} type="button"><Plus size={15} aria-hidden="true" /> Adicionar item <kbd>Enter</kbd></button>
      </div>
      <Field label="Nome do pedido" hint="Sugerido a partir dos itens; é como ele aparece na lista." htmlFor="po-title">
        <input id="po-title" onChange={(event) => setTitle(event.target.value)} placeholder="20 cadeiras de escritório" value={title} />
      </Field>
    </div>
  );
}

function SuppliersStep({ selected, setSelected }: { selected: Set<string>; setSelected: (next: Set<string>) => void }) {
  const { getToken } = useTalkAuth();
  const toast = useToast();
  const [suppliers, setSuppliers] = useState<SupplierDto[] | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [quick, setQuick] = useState({ name: "", phone: "" });
  const [savingQuick, setSavingQuick] = useState(false);

  useEffect(() => {
    let alive = true;
    purchasingApi.listSuppliers(getToken).then((rows) => { if (alive) setSuppliers(rows); }).catch(() => { if (alive) setSuppliers([]); });
    return () => { alive = false; };
  }, [getToken]);

  const categories = useMemo(() => [...new Set((suppliers ?? []).flatMap((supplier) => supplier.categories))].sort(), [suppliers]);
  const term = search.trim().toLowerCase();
  const visible = (suppliers ?? []).filter((supplier) => !supplier.blocked && (!category || supplier.categories.includes(category)) &&
    (!term || [supplier.name, supplier.city ?? "", supplier.phone, ...supplier.categories].some((value) => value.toLowerCase().includes(term))));
  const toggle = (id: string) => { const next = new Set(selected); if (next.has(id)) next.delete(id); else next.add(id); setSelected(next); };

  async function addQuick() {
    setSavingQuick(true);
    try {
      const supplier = await purchasingApi.createSupplier(getToken, { name: quick.name, phone: quick.phone, categories: category ? [category] : [] });
      setSuppliers((current) => [supplier, ...(current ?? [])]);
      setSelected(new Set([...selected, supplier.id]));
      setQuick({ name: "", phone: "" });
      setAdding(false);
      toast(`${supplier.name} adicionado e selecionado`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Não foi possível salvar.", "error");
    } finally { setSavingQuick(false); }
  }

  return (
    <div className="po-form">
      <div className="po-toolbar">
        <div className="po-search"><Search size={15} aria-hidden="true" /><input aria-label="Buscar fornecedor" onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nome, cidade ou categoria" value={search} /></div>
        <button className="po-btn po-btn-ghost" onClick={() => setAdding(!adding)} type="button"><UserPlus size={15} aria-hidden="true" /> Novo</button>
      </div>
      {categories.length ? (
        <div className="po-chips po-chips-sm">
          {categories.map((value) => <button aria-pressed={category === value} className={`po-chip${category === value ? " is-on" : ""}`} key={value} onClick={() => setCategory(category === value ? null : value)} type="button">{value}</button>)}
        </div>
      ) : null}
      {adding ? (
        <div className="po-quick-add">
          <input aria-label="Nome do fornecedor" autoFocus onChange={(event) => setQuick({ ...quick, name: event.target.value })} placeholder="Nome da empresa" value={quick.name} />
          <input aria-label="WhatsApp do fornecedor" inputMode="tel" onChange={(event) => setQuick({ ...quick, phone: event.target.value })} placeholder="WhatsApp com DDD" value={quick.phone} />
          <button className="po-btn po-btn-primary" disabled={savingQuick || !quick.name.trim() || quick.phone.replace(/\D/g, "").length < 10} onClick={() => void addQuick()} type="button">
            {savingQuick ? <span className="po-spinner" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />} Salvar
          </button>
          <button aria-label="Cancelar" className="po-icon-btn" onClick={() => setAdding(false)} type="button"><X size={15} /></button>
        </div>
      ) : null}

      {!suppliers ? <Skeleton lines={4} /> : null}
      {suppliers && suppliers.length === 0 && !adding ? (
        <div className="po-alert">Você ainda não tem fornecedores. Use <b>Novo</b> para cadastrar um agora, ou importe uma planilha na aba Fornecedores.</div>
      ) : null}

      <div className="po-pick-list" role="group" aria-label="Fornecedores">
        {visible.map((supplier) => {
          const on = selected.has(supplier.id);
          return (
            <label className={`po-pick${on ? " is-on" : ""}`} key={supplier.id}>
              <input checked={on} onChange={() => toggle(supplier.id)} type="checkbox" />
              <span className="po-check" aria-hidden="true"><Check size={12} /></span>
              <Avatar name={supplier.name} size={30} />
              <span className="po-pick-text">
                <b>{supplier.name}{supplier.preferred ? <Star className="po-star" size={12} aria-label="preferido" /> : null}</b>
                <span>{[supplier.city, formatPhone(supplier.phone)].filter(Boolean).join(" · ")}</span>
              </span>
              {supplier.stats.invited ? <span className="po-pick-stat">respondeu {supplier.stats.answered} de {supplier.stats.invited}</span> : <span className="po-pick-stat">novo</span>}
            </label>
          );
        })}
      </div>
      {selected.size ? <p className="po-selected-count"><Check size={14} aria-hidden="true" /> {selected.size} selecionado{selected.size === 1 ? "" : "s"}</p> : null}
    </div>
  );
}

function buildPreview({ items, responseDeadline, deliveryDeadline, city, cep, invoice }: {
  items: ItemDraft[]; responseDeadline: string; deliveryDeadline: string; city: string; cep: string; invoice: boolean;
}) {
  const lines = items.filter((item) => item.description.trim()).map((item) => {
    const amount = parseQuantity(item.quantity);
    return `• ${amount ? `${quantity(amount)} ${item.unit} de ` : ""}${item.description.trim()}${item.specification.trim() ? ` (${item.specification.trim()})` : ""}`;
  });
  const where = city.trim() || (cep ? `CEP ${cep}` : "nosso endereço");
  return [
    "Olá, tudo bem? Aqui é da [sua empresa].",
    "Estamos cotando:",
    ...(lines.length ? lines : ["• (seus itens)"]),
    `Entrega em ${where} até ${shortDate(deliveryDeadline)}${invoice ? ", com nota fiscal" : ""}.`,
    `Consegue me passar um orçamento até ${shortDate(responseDeadline)}?`
  ].join("\n");
}
