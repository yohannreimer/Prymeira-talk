import { useOptionalTalkSession } from '../../app/session/TalkSessionProvider';
import { ChannelHealthAlerts } from "../channels/ChannelHealthAlerts";
import { TalkAlerts } from "../alerts/TalkAlerts";
import { Bot } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { availableTalkModules, isTalkModuleKey, type TalkModuleKey } from "./moduleRegistry";

type TalkSuiteShellProps = {
  renderModule: (moduleKey: TalkModuleKey) => ReactNode;
  prefetchModule?: (moduleKey: TalkModuleKey) => void;
};

const defaultModule: TalkModuleKey = "atendimento";
const moduleParamName = "module";

function readModuleFromUrl() {
  if (typeof window === "undefined") return defaultModule;

  const moduleParam = new URLSearchParams(window.location.search).get(moduleParamName);
  return isTalkModuleKey(moduleParam) ? moduleParam : defaultModule;
}

function buildModuleUrl(moduleKey: TalkModuleKey) {
  const url = new URL(window.location.href);
  url.searchParams.set(moduleParamName, moduleKey);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function TalkSuiteShell({ renderModule, prefetchModule }: TalkSuiteShellProps) {
  const context = useOptionalTalkSession();
  const modules = availableTalkModules(context?.currentUser.addons);
  const [requestedModule, setActiveModule] = useState<TalkModuleKey>(readModuleFromUrl);
  // A link to an add-on the workspace does not have falls back to the default module.
  const activeModule = modules.some((module) => module.key === requestedModule) ? requestedModule : defaultModule;

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

  useEffect(() => {
    const currentModuleParam = new URLSearchParams(window.location.search).get(moduleParamName);

    if (!isTalkModuleKey(currentModuleParam)) {
      window.history.replaceState({ module: activeModule }, "", buildModuleUrl(activeModule));
    }

    function handlePopState() {
      setActiveModule(readModuleFromUrl());
    }

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [activeModule]);

  function handleModuleClick(moduleKey: TalkModuleKey) {
    if (moduleKey === 'atendimento' && activeModule !== moduleKey && new URLSearchParams(window.location.search).get('talkPerf') === '1') {
      context?.session.writeUI('performance:returnStart', performance.now(), null);
    }
    window.history.pushState({ module: moduleKey }, "", buildModuleUrl(moduleKey));
    setActiveModule(moduleKey);
  }

  function openConversation(conversationId: string) {
    const url = new URL(window.location.href);
    url.searchParams.set(moduleParamName, "atendimento");
    url.searchParams.set("conversation", conversationId);
    window.history.pushState({ module: "atendimento", conversation: conversationId }, "", `${url.pathname}${url.search}${url.hash}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  return (
    <main className={`talk-suite-shell${sidebarExpanded ? " sidebar-expanded" : ""}`}>
      <aside className="app-rail" aria-label="Navegação principal">
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
          {modules.map(({ key, label, Icon }) => (
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
              onPointerEnter={() => prefetchModule?.(key)}
              onFocus={() => prefetchModule?.(key)}
              title={sidebarExpanded ? undefined : label}
              type="button"
            >
              <Icon size={20} aria-hidden="true" />
              <span className="rail-label">{label}</span>
            </button>
          ))}
        </nav>
        <TalkAlerts activeModule={activeModule} onOpenConversation={openConversation} />
      </aside>

      {renderModule(activeModule)}
      <ChannelHealthAlerts onOpenChannels={() => handleModuleClick("canais")} />
    </main>
  );
}
