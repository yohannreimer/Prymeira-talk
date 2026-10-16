import { useEffect, useState } from "react";
import type { SupplierDto } from "@prymeira-talk/shared";
import { Check, Search } from "lucide-react";
import { useTalkAuth } from "../../app/auth";
import { formatPhone } from "./format";
import { purchasingApi } from "./purchasing-api";
import { Avatar, Drawer, Skeleton } from "./ui";

export function SupplierPickerDrawer({ exclude, onClose, onSave, saving }: {
  exclude: Set<string>; onClose: () => void; onSave: (ids: string[]) => Promise<void>; saving: boolean;
}) {
  const { getToken } = useTalkAuth();
  const [suppliers, setSuppliers] = useState<SupplierDto[] | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    purchasingApi.listSuppliers(getToken).then((rows) => { if (alive) setSuppliers(rows); }).catch(() => { if (alive) setSuppliers([]); });
    return () => { alive = false; };
  }, [getToken]);
  const term = search.trim().toLowerCase();
  const visible = (suppliers ?? []).filter((supplier) => !exclude.has(supplier.id) && !supplier.blocked &&
    (!term || [supplier.name, supplier.city ?? "", ...supplier.categories].some((value) => value.toLowerCase().includes(term))));
  const toggle = (id: string) => { const next = new Set(selected); if (next.has(id)) next.delete(id); else next.add(id); setSelected(next); };

  return (
    <Drawer onClose={onClose} title="Adicionar fornecedores" subtitle="Só aparecem os que ainda não estão no pedido."
      footer={<>
        <span className="po-grow" />
        <button className="po-btn po-btn-ghost" onClick={onClose} type="button">Cancelar</button>
        <button className="po-btn po-btn-primary" disabled={!selected.size || saving} onClick={() => void onSave([...selected])} type="button">
          {saving ? <span className="po-spinner" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />} Adicionar {selected.size || ""}
        </button>
      </>}>
      <div className="po-form">
        <div className="po-search"><Search size={15} aria-hidden="true" /><input aria-label="Buscar fornecedor" onChange={(event) => setSearch(event.target.value)} placeholder="Buscar" value={search} /></div>
        {!suppliers ? <Skeleton lines={4} /> : null}
        {suppliers && !visible.length ? <p className="po-muted">Nenhum fornecedor disponível. Cadastre novos na aba Fornecedores.</p> : null}
        <div className="po-pick-list">
          {visible.map((supplier) => (
            <label className={`po-pick${selected.has(supplier.id) ? " is-on" : ""}`} key={supplier.id}>
              <input checked={selected.has(supplier.id)} onChange={() => toggle(supplier.id)} type="checkbox" />
              <span className="po-check" aria-hidden="true"><Check size={12} /></span>
              <Avatar name={supplier.name} size={30} />
              <span className="po-pick-text"><b>{supplier.name}</b><span>{[supplier.city, formatPhone(supplier.phone)].filter(Boolean).join(" · ")}</span></span>
            </label>
          ))}
        </div>
      </div>
    </Drawer>
  );
}
