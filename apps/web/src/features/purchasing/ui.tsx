import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import type { Tone } from "./format";

// ── Toasts ───────────────────────────────────────────────────────────────────────────────────────

type Toast = { id: number; text: string; tone: "ok" | "error" };
const ToastContext = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = ++seq.current;
    setToasts((current) => [...current.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), tone === "error" ? 6000 : 3200);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="po-toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`po-toast po-toast-${toast.tone}`} key={toast.id}>
            {toast.tone === "ok" ? <Check size={15} aria-hidden="true" /> : <X size={15} aria-hidden="true" />}
            <span>{toast.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ── Small pieces ─────────────────────────────────────────────────────────────────────────────────

export function Pill({ tone, children, pulse }: { tone: Tone; children: ReactNode; pulse?: boolean }) {
  return <span className={`po-pill po-tone-${tone}`}>{pulse ? <i className="po-pill-dot" aria-hidden="true" /> : null}{children}</span>;
}

export function ProgressDots({ done, total }: { done: number; total: number }) {
  const shown = Math.min(total, 8);
  const filled = total > 8 ? Math.round((done / total) * 8) : done;
  return (
    <span className="po-dots" aria-label={`${done} de ${total} responderam`}>
      {Array.from({ length: shown }, (_, index) => <i className={index < filled ? "is-on" : ""} key={index} style={{ transitionDelay: `${index * 45}ms` }} />)}
    </span>
  );
}

/** Counts up to a new value instead of jumping, so a fresh number reads as news. */
export function AnimatedNumber({ value, format }: { value: number; format: (value: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || from.current === value) { setShown(value); from.current = value; return; }
    const start = performance.now(), origin = from.current, duration = 650;
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setShown(Math.round(origin + (value - origin) * eased));
      if (progress < 1) frame = requestAnimationFrame(tick); else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <span className="po-num">{format(shown)}</span>;
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const parts = name.trim().split(/\s+/);
  const letters = ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts.at(-1)![0] : parts[0]?.[1] ?? "")).toUpperCase();
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return <span className="po-avatar" style={{ width: size, height: size, ["--hue" as string]: hash }} aria-hidden="true">{letters}</span>;
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return <div className="po-skeleton" aria-hidden="true">{Array.from({ length: lines }, (_, index) => <span key={index} />)}</div>;
}

// ── Tabs with a sliding indicator ────────────────────────────────────────────────────────────────

export function Tabs<T extends string>({ value, options, onChange, label }: {
  value: T; options: Array<{ value: T; label: ReactNode; count?: number }>; onChange: (value: T) => void; label: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const element = refs.current.get(value);
    if (element) setIndicator({ left: element.offsetLeft, width: element.offsetWidth });
  }, [value, options.length]);
  return (
    <div className="po-tabs" role="tablist" aria-label={label}>
      {indicator ? <span className="po-tabs-indicator" style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }} aria-hidden="true" /> : null}
      {options.map((option) => (
        <button aria-selected={option.value === value} className={option.value === value ? "is-on" : ""} key={option.value}
          onClick={() => onChange(option.value)} ref={(element) => { if (element) refs.current.set(option.value, element); }} role="tab" type="button">
          {option.label}{option.count ? <span className="po-tab-count">{option.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ── Drawer ───────────────────────────────────────────────────────────────────────────────────────

export function Drawer({ title, subtitle, onClose, children, footer, wide }: {
  title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("input, textarea, select, button:not(.po-drawer-close)")?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previous?.focus?.(); };
  }, [onClose]);
  // Portaled to the page root: an animated ancestor (transform) would otherwise trap a fixed panel inside it.
  return createPortal(
    <div className="po-drawer-layer">
      <button aria-label="Fechar" className="po-drawer-backdrop" onClick={onClose} tabIndex={-1} type="button" />
      <div aria-modal="true" className={`po-drawer${wide ? " is-wide" : ""}`} ref={panel} role="dialog">
        <header className="po-drawer-head">
          <div><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>
          <button aria-label="Fechar" className="po-icon-btn po-drawer-close" onClick={onClose} type="button"><X size={18} /></button>
        </header>
        <div className="po-drawer-body">{children}</div>
        {footer ? <footer className="po-drawer-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.querySelector(".po-page") ?? document.body
  );
}

// ── Inline confirmation: the button turns into "Confirmar?" instead of opening a modal ────────────

export function ConfirmButton({ label, confirmLabel, onConfirm, className = "po-btn", busy, disabled, icon }: {
  label: ReactNode; confirmLabel: ReactNode; onConfirm: () => void; className?: string; busy?: boolean; disabled?: boolean; icon?: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <button className={`${className}${armed ? " is-armed" : ""}`} disabled={disabled || busy} onBlur={() => setArmed(false)}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }} type="button">
      {busy ? <span className="po-spinner" aria-hidden="true" /> : icon}
      <span>{armed ? confirmLabel : label}</span>
    </button>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className={`po-field${error ? " has-error" : ""}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="po-field-error" role="alert">{error}</span> : hint ? <span className="po-field-hint">{hint}</span> : null}
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="po-empty">
      <div className="po-empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
