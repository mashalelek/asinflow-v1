import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SettingsDialog } from "@/components/settings-dialog";
import { FileUpload } from "@/components/file-upload";
import { ResultsTable } from "@/components/results-table";
import { ExportButtons } from "@/components/export-buttons";
import { SummaryCards } from "@/components/summary-cards";
import { ColumnManager } from "@/components/column-manager";
import { useTheme } from "@/components/theme-provider";
import { loadSettings } from "@/lib/settings";
import { loadColumnConfig, type ColumnConfig } from "@/lib/columns";
import { Sun, Moon, BarChart3, Zap, AlertTriangle } from "lucide-react";
import {
  type AsinInput,
  type AsinResult,
  type PriceSource,
  type Settings,
  type ProgressUpdate,
} from "@shared/schema";
import { useToast } from "@/hooks/use-toast";

export default function Home() {
  const { theme, toggleTheme } = useTheme();
  const { toast } = useToast();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [columnConfig, setColumnConfig] = useState<ColumnConfig>(loadColumnConfig);
  const [asins, setAsins] = useState<AsinInput[]>([]);
  const [results, setResults] = useState<AsinResult[]>([]);
  const [priceSource, setPriceSource] = useState<PriceSource>("lowestFba");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [credentialsConfigured, setCredentialsConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/credentials-status")
      .then((r) => r.json())
      .then((d) => setCredentialsConfigured(d.configured))
      .catch(() => setCredentialsConfigured(false));
  }, []);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);

  const handleFileProcessed = useCallback((parsed: AsinInput[]) => {
    setAsins(parsed);
    setResults([]);
    const hasPrepOverrides = parsed.some((a) => a.prepOverride != null);
    const hasStorageOverrides = parsed.some((a) => a.storageOverride != null);
    let msg = `Found ${parsed.length} ASINs ready for analysis.`;
    if (hasPrepOverrides || hasStorageOverrides) {
      const parts: string[] = [];
      if (hasPrepOverrides) parts.push("Prep");
      if (hasStorageOverrides) parts.push("Storage");
      msg += ` Per-ASIN ${parts.join(" and ")} overrides detected.`;
    }
    toast({ title: "File parsed", description: msg });
  }, [toast]);

  const handleAnalyze = useCallback(async () => {
    if (asins.length === 0) return;

    setIsAnalyzing(true);
    setResults([]);
    setProgress({ current: 0, total: asins.length, asin: "" });

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asins }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Analysis failed");
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.type === "progress") {
                setProgress(msg.data);
              } else if (msg.type === "result") {
                setResults((prev) => [...prev, msg.data]);
              } else if (msg.type === "complete") {
                setProgress(null);
              }
            } catch {}
          }
        }
      }
    } catch (err: any) {
      toast({
        title: "Analysis failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
      setProgress(null);
    }
  }, [asins, toast]);

  const progressPercent = progress
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4 h-14">
            <div className="flex items-center gap-2.5">
              <BarChart3 className="h-6 w-6 text-primary" />
              <h1 className="text-base font-semibold tracking-tight">FBA Profitability Analyzer</h1>
            </div>
            <div className="flex items-center gap-1">
              <SettingsDialog onSettingsChange={setSettings} />
              <Button
                size="icon"
                variant="ghost"
                onClick={toggleTheme}
                data-testid="button-theme-toggle"
              >
                {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {credentialsConfigured === false && (
          <Alert variant="destructive" data-testid="alert-credentials">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              SP-API credentials are not configured. Add <code className="font-mono text-xs">SP_API_CLIENT_ID</code>, <code className="font-mono text-xs">SP_API_CLIENT_SECRET</code>, and <code className="font-mono text-xs">SP_API_REFRESH_TOKEN</code> to your Replit Secrets for live data. The app will still work but won't fetch real pricing data.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
          <FileUpload onFileProcessed={handleFileProcessed} isAnalyzing={isAnalyzing} />

          <div className="flex flex-col items-center justify-center gap-3">
            <Button
              size="lg"
              onClick={handleAnalyze}
              disabled={asins.length === 0 || isAnalyzing}
              className="min-w-[160px]"
              data-testid="button-analyze"
            >
              <Zap className="h-4 w-4 mr-2" />
              {isAnalyzing ? "Analyzing..." : `Analyze ${asins.length > 0 ? asins.length : ""} ASINs`}
            </Button>
            {asins.length > 0 && !isAnalyzing && (
              <p className="text-xs text-muted-foreground">
                {asins.length} ASIN{asins.length !== 1 ? "s" : ""} ready
              </p>
            )}
          </div>
        </div>

        {isAnalyzing && progress && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Fetching {progress.current} of {progress.total} ASINs...
              </span>
              <span className="font-mono text-xs">{progressPercent}%</span>
            </div>
            <Progress value={progressPercent} className="h-2" data-testid="progress-analysis" />
            {progress.asin && (
              <p className="text-xs text-muted-foreground font-mono">
                Current: {progress.asin}
              </p>
            )}
          </div>
        )}

        {results.length > 0 && (
          <>
            <SummaryCards results={results} priceSource={priceSource} settings={settings} />

            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <Label className="text-sm text-muted-foreground whitespace-nowrap">Price Source:</Label>
                <div className="flex items-center gap-2">
                  <span className={`text-sm ${priceSource === "lowestFba" ? "font-semibold" : "text-muted-foreground"}`}>
                    Lowest FBA
                  </span>
                  <Switch
                    checked={priceSource === "buyBox"}
                    onCheckedChange={(checked) =>
                      setPriceSource(checked ? "buyBox" : "lowestFba")
                    }
                    data-testid="switch-price-source"
                  />
                  <span className={`text-sm ${priceSource === "buyBox" ? "font-semibold" : "text-muted-foreground"}`}>
                    Buy Box
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <ExportButtons results={results} priceSource={priceSource} settings={settings} />
                <ColumnManager config={columnConfig} onChange={setColumnConfig} />
              </div>
            </div>

            <ResultsTable
              results={results}
              priceSource={priceSource}
              settings={settings}
              columnConfig={columnConfig}
            />
          </>
        )}

        {!isAnalyzing && results.length === 0 && asins.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <BarChart3 className="h-16 w-16 text-muted-foreground/30 mb-4" />
            <h2 className="text-lg font-medium text-muted-foreground">
              Upload a file to get started
            </h2>
            <p className="text-sm text-muted-foreground/70 mt-1 max-w-md">
              Upload a CSV or Excel file with ASIN and COGS columns.
              Optionally include Prep and Storage columns for per-ASIN overrides.
              The analyzer will fetch pricing data from Amazon SP-API and calculate profitability for each product.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
