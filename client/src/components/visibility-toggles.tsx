import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

interface VisibilityTogglesProps {
  showGated: boolean;
  onShowGatedChange: (v: boolean) => void;
  showMeltable: boolean;
  onShowMeltableChange: (v: boolean) => void;
  showArchived: boolean;
  onShowArchivedChange: (v: boolean) => void;
}

export function VisibilityToggles({
  showGated, onShowGatedChange,
  showMeltable, onShowMeltableChange,
  showArchived, onShowArchivedChange,
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
      <div className="flex items-center gap-1.5">
        <Switch id="toggle-archived" checked={showArchived} onCheckedChange={onShowArchivedChange} />
        <Label htmlFor="toggle-archived" className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap">Show archived</Label>
      </div>
    </div>
  );
}

const GATED_KEY = "fba-show-gated";
const MELTABLE_KEY = "fba-show-meltable";
const MELTABLE_MANUAL_KEY = "fba-show-meltable-manual"; // set when user manually toggles
const ARCHIVED_KEY = "fba-show-archived";

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

export function loadShowArchived(): boolean {
  try { const v = localStorage.getItem(ARCHIVED_KEY); if (v !== null) return v === "true"; } catch {}
  return false; // default OFF
}

export function saveShowArchived(v: boolean) {
  localStorage.setItem(ARCHIVED_KEY, String(v));
}
