// The profit Settings for a page (Finances API patch commit 1): the cached
// value at once, the database's value after one GET, and every later save
// (the Settings dialog, any page) pushed to every mounted page.
import { useEffect, useState } from "react";
import type { Settings } from "@shared/schema";
import { fetchSettings, loadSettings, subscribeSettings } from "@/lib/settings";

export function useProfitSettings(): [Settings, (s: Settings) => void] {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  useEffect(() => {
    let alive = true;
    void fetchSettings().then((s) => { if (alive) setSettings(s); });
    const off = subscribeSettings((s) => { if (alive) setSettings(s); });
    return () => { alive = false; off(); };
  }, []);
  return [settings, setSettings];
}
