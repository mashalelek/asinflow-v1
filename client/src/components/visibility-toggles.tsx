import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

interface VisibilityTogglesProps {
  showGated: boolean;
  onShowGatedChange: (v: boolean) => void;
  showMeltable: boolean;
  onShowMeltableChange: (v: boolean) => void;
  showParked: boolean;
  onShowParkedChange: (v: boolean) => void;
  showDead: boolean;
  onShowDeadChange: (v: boolean) => void;
}

export function VisibilityToggles({
  showGated, onShowGatedChange,
  showMeltable, onShowMeltableChange,
  showParked, onShowParkedChange,
  showDead, onShowDeadChange,
}: VisibilityTogglesProps) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-1.5">
        <Switch id="toggle-gated" checked={showGated} onCheckedChange={onShowGatedChange} />
        <Label htmlFor="toggle-gated" className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap">Show gated</Label>
      </div>
      <div className="flex items-center gap-1.5">
        <Switch id="toggle-meltable" checked={showMeltable} onCheckedChange={onShowMeltableChange} />
        <Label htmlFor="toggle-meltable" className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap">Show meltable</Label>
      </div>
      {/* §14 parked/dead (2026-09-07): Show parked replaced Show archived
          (same localStorage key — persistence carries over); Show dead is new,
          default off. Both are view scope, never filters (§5). */}
      <div className="flex items-center gap-1.5">
        <Switch id="toggle-parked" checked={showParked} onCheckedChange={onShowParkedChange} />
        <Label htmlFor="toggle-parked" className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap">Show parked</Label>
      </div>
      <div className="flex items-center gap-1.5">
        <Switch id="toggle-dead" checked={showDead} onCheckedChange={onShowDeadChange} />
        <Label htmlFor="toggle-dead" className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap">Show dead</Label>
      </div>
    </div>
  );
}

const GATED_KEY = "fba-show-gated";
const MELTABLE_KEY = "fba-show-meltable";
const MELTABLE_MANUAL_KEY = "fba-show-meltable-manual"; // set when user manually toggles
const PARKED_KEY = "fba-show-archived"; // key kept — Show parked inherits Show archived persistence
const DEAD_KEY = "fba-show-dead";

function isMeltableSeason(): boolean {
  const now = new Date();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return (m > 4 || (m === 4 && d >= 15)) && (m < 9 || (m === 9 && d <= 15));
}

export function loadShowGated(): boolean {
  try { const v = localStorage.getItem(GATED_KEY); if (v !== null) return v === "true"; } catch {}
  return false; // default OFF
}

export function saveShowGated(v: boolean) {
  localStorage.setItem(GATED_KEY, String(v));
}

export function loadShowMeltable(): boolean {
  // If user manually set it this session, respect that
  try {
    const manual = localStorage.getItem(MELTABLE_MANUAL_KEY);
    if (manual !== null) {
      const v = localStorage.getItem(MELTABLE_KEY);
      if (v !== null) return v === "true";
    }
  } catch {}
  // Otherwise use seasonal default
  return !isMeltableSeason();
}

export function saveShowMeltable(v: boolean) {
  localStorage.setItem(MELTABLE_KEY, String(v));
  localStorage.setItem(MELTABLE_MANUAL_KEY, "true");
}

export function loadShowParked(): boolean {
  try { const v = localStorage.getItem(PARKED_KEY); if (v !== null) return v === "true"; } catch {}
  return false; // default OFF
}

export function saveShowParked(v: boolean) {
  localStorage.setItem(PARKED_KEY, String(v));
}

export function loadShowDead(): boolean {
  try { const v = localStorage.getItem(DEAD_KEY); if (v !== null) return v === "true"; } catch {}
  return false; // default OFF
}

export function saveShowDead(v: boolean) {
  localStorage.setItem(DEAD_KEY, String(v));
}
