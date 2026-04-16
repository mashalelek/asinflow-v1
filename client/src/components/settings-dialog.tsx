import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Settings as SettingsIcon, Save } from "lucide-react";
import { type Settings } from "@shared/schema";
import { loadSettings, saveSettings } from "@/lib/settings";
import { useToast } from "@/hooks/use-toast";

interface SettingsDialogProps {
  onSettingsChange: (settings: Settings) => void;
}

export function SettingsDialog({ onSettingsChange }: SettingsDialogProps) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const { toast } = useToast();

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
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" data-testid="button-settings">
          <SettingsIcon className="h-5 w-5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 pt-2">
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">Cost Parameters</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="inbound" className="text-sm whitespace-nowrap">Inbound Shipping ($/lb)</Label>
                <Input
                  id="inbound"
                  type="number"
                  step="0.01"
                  min="0"
                  value={settings.inboundShippingCost}
                  onChange={(e) => updateField("inboundShippingCost", e.target.value)}
                  className="w-28 text-right"
                  data-testid="input-inbound-shipping"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="prep" className="text-sm whitespace-nowrap">Prep Cost ($/unit)</Label>
                <Input
                  id="prep"
                  type="number"
                  step="0.01"
                  min="0"
                  value={settings.prepCost}
                  onChange={(e) => updateField("prepCost", e.target.value)}
                  className="w-28 text-right"
                  data-testid="input-prep-cost"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="storage" className="text-sm whitespace-nowrap">Additional Fees ($/unit)</Label>
                <Input
                  id="storage"
                  type="number"
                  step="0.01"
                  min="0"
                  value={settings.storageFee}
                  onChange={(e) => updateField("storageFee", e.target.value)}
                  className="w-28 text-right"
                  data-testid="input-storage-fee"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="lowInv" className="text-sm whitespace-nowrap">Low-Inventory Surcharge ($/unit)</Label>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Amazon flat fee not included in SP-API</p>
                </div>
                <Input
                  id="lowInv"
                  type="number"
                  step="0.01"
                  min="0"
                  value={settings.lowInventorySurcharge}
                  onChange={(e) => updateField("lowInventorySurcharge", e.target.value)}
                  className="w-28 text-right"
                  data-testid="input-low-inventory-surcharge"
                />
              </div>
            </div>
          </div>

          <Separator />

          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">Hazmat Surcharges</h3>
            <p className="text-xs text-muted-foreground mb-3">Per-unit surcharges added to hazmat products on top of standard costs</p>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="hazmatShip" className="text-sm whitespace-nowrap">Hazmat Shipping ($)</Label>
                <Input
                  id="hazmatShip"
                  type="number"
                  step="0.01"
                  min="0"
                  value={settings.hazmatShipSurcharge ?? 0}
                  onChange={(e) => updateField("hazmatShipSurcharge", e.target.value)}
                  className="w-28 text-right"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="hazmatPrep" className="text-sm whitespace-nowrap">Hazmat Prep ($)</Label>
                <Input
                  id="hazmatPrep"
                  type="number"
                  step="0.01"
                  min="0"
                  value={settings.hazmatPrepSurcharge ?? 0}
                  onChange={(e) => updateField("hazmatPrepSurcharge", e.target.value)}
                  className="w-28 text-right"
                />
              </div>
            </div>
          </div>

          <Separator />

          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">Profitability Thresholds</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="roi" className="text-sm whitespace-nowrap">Minimum ROI (%)</Label>
                <Input
                  id="roi"
                  type="number"
                  step="1"
                  min="0"
                  value={settings.minRoiThreshold}
                  onChange={(e) => updateField("minRoiThreshold", e.target.value)}
                  className="w-28 text-right"
                  data-testid="input-min-roi"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="margin" className="text-sm whitespace-nowrap">Minimum Margin (%)</Label>
                <Input
                  id="margin"
                  type="number"
                  step="1"
                  min="0"
                  value={settings.minMarginThreshold}
                  onChange={(e) => updateField("minMarginThreshold", e.target.value)}
                  className="w-28 text-right"
                  data-testid="input-min-margin"
                />
              </div>
            </div>
          </div>

          <Separator />

          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">SP-API Credentials</h3>
            <p className="text-xs text-muted-foreground mb-3">
              Store these in your Replit Secrets tab. The app reads them from environment variables on the server.
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

          <Button onClick={handleSave} className="w-full" data-testid="button-save-settings">
            <Save className="h-4 w-4 mr-2" />
            Save Settings
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
