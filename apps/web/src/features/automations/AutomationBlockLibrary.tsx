import { automationBlockCatalog, type AutomationBlockCategory, type AutomationBlockType } from "@prymeira-talk/shared";
import { Plus } from "lucide-react";

interface AutomationBlockLibraryProps {
  onSelect: (type: AutomationBlockType) => void;
}

const categoryLabels: Record<AutomationBlockCategory, string> = {
  trigger: "Gatilhos",
  communication: "Mensagens",
  decision: "Decisoes",
  time: "Tempo",
  crm: "CRM",
  integration: "Integracoes",
  control: "Controle"
};

const categoryOrder: AutomationBlockCategory[] = [
  "trigger",
  "communication",
  "decision",
  "time",
  "crm",
  "integration",
  "control"
];

export function AutomationBlockLibrary({ onSelect }: AutomationBlockLibraryProps) {
  return (
    <aside className="automation-block-library" aria-label="Biblioteca de blocos">
      <div className="automation-panel-heading">
        <h3>Blocos</h3>
        <span>{automationBlockCatalog.length}</span>
      </div>

      <div className="automation-block-library-scroll">
        {categoryOrder.map((category) => {
          const blocks = automationBlockCatalog.filter((block) => block.category === category);

          if (blocks.length === 0) {
            return null;
          }

          return (
            <section className="automation-block-group" key={category}>
              <h4>{categoryLabels[category]}</h4>
              <div className="automation-block-list">
                {blocks.map((block) => (
                  <button
                    className="automation-block-button"
                    disabled={block.support !== "supported"}
                    key={block.type}
                    onClick={() => onSelect(block.type)}
                    title={
                      block.support === "supported"
                        ? `Adicionar ${block.label}`
                        : `${block.label} ainda nao executa em automacoes reais`
                    }
                    type="button"
                  >
                    <span className="automation-block-add" aria-hidden="true">
                      <Plus size={13} />
                    </span>
                    <span className="automation-block-copy">
                      <strong>{block.label}</strong>
                      <small>{block.description}</small>
                    </span>
                    {block.support !== "supported" ? (
                      <span className={`automation-support-pill automation-support-pill--${block.support}`}>
                        {block.support === "coming_soon" ? "Em breve" : "Visual"}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
