import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Settings as SettingsIcon, Save, Users } from "lucide-react";
import { type Settings, type PriceSource } from "@shared/schema";
import { loadSettings, saveSettings } from "@/lib/settings";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/auth-context";
import { UsersAdminDialog } from "@/components/users-admin-dialog";

/**
 * Display-side state owned by the host page (home / analytics) and surfaced
 * inside the modal so users have a single place to find these knobs. Pass
 * undefined and the Display Options section is omitted; only Cost Parameters,
 * Profitability Thresholds, and SP-API Credentials render.
 *
 * `includeInboundShipping` is conceptually a display option but lives under
 * Cost Parameters per the B1 spec because it gates which costs are included
 * in profitability math.
 */
export interface MovedToggles {
  includeInboundShipping: boolean;
  onIncludeInboundShippingChange: (v: boolean) => void;
  priceSource: PriceSource;
  onPriceSourceChange: (v: PriceSource) => void;
  showGated: boolean;
  onShowGatedChange: (v: boolean) => void;
  showMeltable: boolean;
  onShowMeltableChange: (v: boolean) => void;
  showParked: boolean;
  onShowParkedChange: (v: boolean) => void;
  showDead: boolean;
  onShowDeadChange: (v: boolean) => void;
  // Reset-Est-COGS-to-PO action — moved here from the toolbar (2026-06-29).
  // Sits directly under the "Include Inbound Shipping" row.
  onResetCogs: () => void;
  isResettingCogs: boolean;
  // §21 settings-drift fix (2026-09-09): a host page that cannot honor a
  // control renders it DISABLED with this one-line reason — never hidden.
  // Hidden fields are how the two pages drifted apart.
  // Narrowed 2026-09-09: gated/meltable/price-source now APPLY on Bulk Calc,
  // so only these three can be disabled anywhere — widening this type back
  // is how a page would quietly stop honoring a control. Don't.
  disabledReasons?: Partial<Record<"showParked" | "showDead" | "resetCogs", string>>;
}

interface SettingsDialogProps {
  onSettingsChange: (settings: Settings) => void;
  /** Pass to render the Display Options section + Include Inbound Shipping row. */
  movedToggles?: MovedToggles;
  /** If provided, dialog open state is controlled by the parent. */
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  /** Hide the built-in trigger button (used when opening from the top-nav settings icon). */
  hideTrigger?: boolean;
}

export function SettingsDialog({
  onSettingsChange, movedToggles,
  open: openProp, onOpenChange, hideTrigger,
}: SettingsDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp !== undefined ? openProp : internalOpen;
  const setOpen = (v: boolean) => {
    if (onOpenChange) onOpenChange(v);
    if (openProp === undefined) setInternalOpen(v);
  };
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const { toast } = useToast();
  // SPEC §25: the Users section is admin-only. The server is the real gate
  // (403 for a member); hiding it here just keeps the dialog honest.
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [usersOpen, setUsersOpen] = useState(false);
  // No scheduler surface here (2026-10-16): the jobs dialog on the ASINs
  // toolbar clock is the only one.

  useEffect(() => {
    setSettings(loadSettings());
  }, [open]);

  const handleSave = () => {
    saveSettings(settings);
    onSettingsChange(settings);
    toast({ title: "Settings saved", description: "Your settings have been updated." });
    setOpen(false);
  };

  const updateField = (field: keyof Settings, value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num) && num >= 0) {
      setSettings((s) => ({ ...s, [field]: num }));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button size="sm" variant="outline" className="h-8 text-xs" data-testid="button-settings">
            <SettingsIcon className="h-3.5 w-3.5 mr-1.5" />
            Settings
          </Button>
        </DialogTrigger>
      )}
      <DialogContent dialogId="settings" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 pt-2">
          {/* ─── Cost Parameters ─── */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">Cost Parameters</h3>
            <div className="space-y-3">
              <NumField id="prep"     label="Prep Cost ($/unit)"           value={settings.prepCost}              onChange={(v) => updateField("prepCost", v)} />
              <NumField id="addl"     label="Additional Fees ($/unit)"     value={settings.storageFee}            onChange={(v) => updateField("storageFee", v)} />
              <NumField id="lowInv"   label="Low-Inventory Surcharge ($/unit)" value={settings.lowInventorySurcharge} onChange={(v) => updateField("lowInventorySurcharge", v)}
                        hint="Amazon flat fee not included in SP-API" />
              <NumField id="hzShip"   label="DG/Hazmat Shipping Surcharge ($/unit)" value={settings.hazmatShipSurcharge ?? 0} onChange={(v) => updateField("hazmatShipSurcharge", v)} />
              <NumField id="hzPrep"   label="DG/Hazmat Prep Surcharge ($/unit)"     value={settings.hazmatPrepSurcharge ?? 0} onChange={(v) => updateField("hazmatPrepSurcharge", v)} />
              <NumField id="inbound"  label="Inbound Shipping Rate ($/lb)" value={settings.inboundShippingCost}   onChange={(v) => updateField("inboundShippingCost", v)} />

              {movedToggles && (
                <>
                  <ToggleRow
                    id="incInbound"
                    label="Include Inbound Shipping in profit"
                    checked={movedToggles.includeInboundShipping}
                    onChange={movedToggles.onIncludeInboundShippingChange}
                    hint="Adds weight × rate to total cost when computing profit."
                  />
                  <div className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="text-sm">Reset Est. COGS to PO</div>
                      <div className="text-[11px] text-muted-foreground">
                        Re-pull all estimated COGS values from the PO tracker sheet.
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={movedToggles.onResetCogs}
                      disabled={movedToggles.isResettingCogs || !!movedToggles.disabledReasons?.resetCogs}
                      title={movedToggles.disabledReasons?.resetCogs}
                      className="h-8 text-xs shrink-0"
                      data-testid="button-reset-cogs"
                    >
                      {movedToggles.isResettingCogs ? "Syncing..." : "Run sync"}
                    </Button>
                  </div>
                </>
              )}

              <div className="pt-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Max COGS thresholds</Label>
                <p className="text-[10px] text-muted-foreground mb-2">Criteria for the Max COGS column — the maximum cost at which all three are met.</p>
                <div className="space-y-3">
                  {/* Same order as Profitability Thresholds: Margin, ROI, Profit/Unit (2026-10-16). */}
                  <NumField id="mcMargin" label="Min Profit Margin (%)"   value={settings.maxCogsMinMarginPct}  onChange={(v) => updateField("maxCogsMinMarginPct", v)} />
                  <NumField id="mcRoi"    label="Min ROI (%)"             value={settings.maxCogsMinRoiPct}     onChange={(v) => updateField("maxCogsMinRoiPct", v)} />
                  <NumField id="mcProfit" label="Min Profit per Unit ($)" value={settings.maxCogsMinProfitUnit} onChange={(v) => updateField("maxCogsMinProfitUnit", v)} />
                </div>
              </div>
            </div>
          </div>

          {/* ─── Display Options (only when host page provides toggles) ─── */}
          {movedToggles && (
            <>
              <Separator />
              <div>
                <h3 className="text-sm font-medium text-muted-foreground mb-3">Display Options</h3>
                <div className="space-y-4">
                  <div>
                    <Label className="text-sm">Price source</Label>
                    <RadioGroup
                      value={movedToggles.priceSource}
                      onValueChange={(v) => movedToggles.onPriceSourceChange(v as PriceSource)}
                      className="flex gap-6 mt-2"
                    >
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <RadioGroupItem value="lowestFba" />
                        Lowest FBA
                      </label>
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <RadioGroupItem value="buyBox" />
                        Buy Box
                      </label>
                    </RadioGroup>
                    <p className="text-[10px] text-muted-foreground mt-1">Drives Estimated Profit/ROI/Margin via the column's selected price.</p>
                  </div>

                  <ToggleRow id="dsGated"     label="Show gated"     checked={movedToggles.showGated}     onChange={movedToggles.onShowGatedChange} />
                  <ToggleRow id="dsMeltable"  label="Show meltable"  checked={movedToggles.showMeltable}  onChange={movedToggles.onShowMeltableChange}
                             hint="Seasonal default: auto-ON Apr 15 – Sep 15 unless manually toggled." />
                  <ToggleRow id="dsParked"    label="Show parked"    checked={movedToggles.showParked}    onChange={movedToggles.onShowParkedChange} disabledReason={movedToggles.disabledReasons?.showParked} />
                  <ToggleRow id="dsDead"      label="Show dead"      checked={movedToggles.showDead}      onChange={movedToggles.onShowDeadChange} disabledReason={movedToggles.disabledReasons?.showDead} />
                </div>
              </div>
            </>
          )}

          <Separator />

          {/* ─── Profitability Thresholds ─── */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">Profitability Thresholds</h3>
            <p className="text-xs text-muted-foreground mb-3">Row-level gates used by the Profitable scorecard tile and the Replens tile.</p>
            <div className="space-y-3">
              {/* Same order as Max COGS thresholds: Margin, ROI, Profit/Unit (2026-10-16). */}
              <NumField id="margin"       label="Minimum Margin (%)"        value={settings.minMarginThreshold}     onChange={(v) => updateField("minMarginThreshold", v)} />
              <NumField id="roi"          label="Minimum ROI (%)"           value={settings.minRoiThreshold}        onChange={(v) => updateField("minRoiThreshold", v)} />
              <NumField id="minProfitUnit" label="Minimum Profit/Unit ($)"  value={settings.minProfitUnitThreshold} onChange={(v) => updateField("minProfitUnitThreshold", v)} step="0.01" />
            </div>
          </div>

          <Separator />

          {/* ─── SP-API Credentials (unchanged) ─── */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">SP-API Credentials</h3>
            <p className="text-xs text-muted-foreground mb-3">
              Set as environment variables on the server (Render → Environment; locally in .env).
            </p>
            <div className="space-y-2">
              {[
                { key: "SP_API_CLIENT_ID", label: "Client ID" },
                { key: "SP_API_CLIENT_SECRET", label: "Client Secret" },
                { key: "SP_API_REFRESH_TOKEN", label: "Refresh Token" },
                { key: "SP_API_SELLER_ID", label: "Seller ID" },
              ].map(({ key, label }) => (
                <div key={key} className="flex items-center justify-between gap-4">
                  <Label className="text-sm whitespace-nowrap">{label}</Label>
                  <code className="text-xs bg-muted px-2 py-1 rounded-md font-mono text-muted-foreground">{key}</code>
                </div>
              ))}
            </div>
          </div>

          {/* ─── Users (SPEC §25, admin only) ─── */}
          {isAdmin && (
            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-3">Users</h3>
              <div className="flex items-center justify-between gap-4">
                <p className="text-xs text-muted-foreground">Accounts that can sign in. Add, rename, change role, deactivate, reset password.</p>
                <Button variant="outline" size="sm" onClick={() => setUsersOpen(true)} data-testid="button-manage-users">
                  <Users className="h-4 w-4 mr-1.5" /> Manage users
                </Button>
              </div>
              <UsersAdminDialog open={usersOpen} onOpenChange={setUsersOpen} />
            </div>
          )}

          <Button onClick={handleSave} className="w-full" data-testid="button-save-settings">
            <Save className="h-4 w-4 mr-2" />
            Save Settings
          </Button>
          <p className="text-[10px] text-muted-foreground text-center -mt-2">
            Display Options auto-save on toggle. Save commits Cost Parameters + Profitability Thresholds.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Small row helpers ───────────────────────────────────────────────────────

function NumField({ id, label, value, onChange, hint, step = "0.01" }: {
  id: string; label: string; value: number | string; onChange: (v: string) => void; hint?: string; step?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1">
        <Label htmlFor={id} className="text-sm whitespace-nowrap">{label}</Label>
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      <Input
        id={id}
        type="number"
        step={step}
        min="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-28 text-right"
      />
    </div>
  );
}

function ToggleRow({ id, label, checked, onChange, hint, disabledReason }: {
  id: string; label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; disabledReason?: string;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 ${disabledReason ? "opacity-60" : ""}`}>
      <div className="flex-1">
        <Label htmlFor={id} className={`text-sm ${disabledReason ? "" : "cursor-pointer"}`}>{label}</Label>
        {(disabledReason ?? hint) && <p className="text-[10px] text-muted-foreground mt-0.5">{disabledReason ?? hint}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={!!disabledReason} />
    </div>
  );
}
