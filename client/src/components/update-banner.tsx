import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { currentEntryScript, entryScriptFromHtml, isStaleBuild } from "@/lib/build-check";

// Shows a banner when a newer build has been deployed than the one this tab
// runs (see lib/build-check.ts). Checked on load, every 5 minutes, and when
// the tab regains focus. Production builds only (dev serves /src/main.tsx).
const CHECK_MS = 5 * 60 * 1000;

export function UpdateBanner() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const mine = currentEntryScript(document);
    if (!mine) return;
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch("/", { cache: "no-store", credentials: "same-origin" });
        if (!res.ok || stopped) return;
        if (isStaleBuild(mine, entryScriptFromHtml(await res.text()))) setStale(true);
      } catch { /* offline / transient — try again later */ }
    };
    void check();
    const t = window.setInterval(check, CHECK_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => { stopped = true; window.clearInterval(t); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, []);
  if (!stale) return null;
  return (
    <div role="alert" className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-black shadow">
      AsinFlow has been updated. This tab is running the previous version — reload before you upload or refresh.
      <Button size="sm" variant="secondary" onClick={() => window.location.reload()} data-testid="button-reload-new-version">
        <RefreshCw className="mr-1 h-3.5 w-3.5" /> Reload
      </Button>
    </div>
  );
}
