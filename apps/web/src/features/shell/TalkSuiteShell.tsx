import { Bot } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { talkModules, type TalkModuleKey } from "./moduleRegistry";

type TalkSuiteShellProps = {
  renderModule: (moduleKey: TalkModuleKey) => ReactNode;
};

export function TalkSuiteShell({ renderModule }: TalkSuiteShellProps) {
  const [activeModule, setActiveModule] = useState<TalkModuleKey>("atendimento");

  return (
    <main className="talk-suite-shell">
      <aside className="app-rail" aria-label="Navegacao principal">
        <div className="rail-logo">
          <Bot size={22} aria-hidden="true" />
        </div>
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
              onClick={() => setActiveModule(key)}
              title={label}
              type="button"
            >
              <Icon size={20} aria-hidden="true" />
            </button>
          ))}
        </nav>
      </aside>

      {renderModule(activeModule)}
    </main>
  );
}
