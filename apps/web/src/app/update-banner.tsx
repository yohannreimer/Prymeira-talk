import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import "./update-banner.css";

const CHECK_EVERY_MS = 60_000;

/** The entry script index.html loaded ("assets/index-abc.js"), or null outside a production build. */
export function entryScriptUrl() {
  return document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.src ?? "";
}
/** The entry script this page is running ("assets/index-abc.js"), or null outside a production build. */
export function runningBuild(entryUrl: string) {
  const match = /\/(assets\/[^/?#]+\.js)(?:[?#].*)?$/.exec(entryUrl);
  return match ? match[1]! : null;
}

/** True once the server publishes another build than the one on screen. */
export function isNewBuild(running: string | null, published: unknown) {
  const build = published && typeof published === "object" ? (published as { build?: unknown }).build : null;
  return Boolean(running && typeof build === "string" && build && build !== running);
}

/** A script of the old release that no longer exists after a deploy ("Failed to fetch dynamically imported module"). */
export function isStaleChunkError(reason: unknown) {
  const message = reason instanceof Error ? `${reason.name} ${reason.message}` : String(reason ?? "");
  return /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk \S+ failed|error loading dynamically imported/i.test(message);
}

/**
 * After a release the open tabs keep running the old code, and parts of it stop working until the page is reloaded.
 * The page checks every minute (and when the tab comes back) whether a new build is out and then asks for a reload.
 */
export function UpdateBanner({ entryUrl }: { entryUrl?: string }) {
  const [outdated, setOutdated] = useState(false);
  useEffect(() => {
    const running = runningBuild(entryUrl ?? entryScriptUrl());
    if (!running) return;
    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      try {
        const response = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (response.ok && isNewBuild(running, await response.json())) setOutdated(true);
      } catch { /* offline or restarting: the next check will tell */ }
    };
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    const onStale = (event: PromiseRejectionEvent | ErrorEvent) => {
      if (isStaleChunkError("reason" in event ? event.reason : event.error ?? event.message)) setOutdated(true);
    };
    const timer = window.setInterval(() => { void check(); }, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("unhandledrejection", onStale);
    window.addEventListener("error", onStale);
    window.addEventListener("vite:preloadError", () => setOutdated(true));
    return () => {
      stopped = true; window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("unhandledrejection", onStale);
      window.removeEventListener("error", onStale);
    };
  }, [entryUrl]);
  if (!outdated) return null;
  return <div className="update-banner" role="alert">
    <span><strong>Atualização feita.</strong> Recarregue a página para continuar usando o Talk.</span>
    <button type="button" onClick={() => window.location.reload()}><RefreshCw size={15} aria-hidden="true" />Recarregar agora</button>
  </div>;
}
