import { useState, useCallback, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingsDialog } from "@/components/settings-dialog";
import { FileUpload } from "@/components/file-upload";
import { ResultsTable } from "@/components/results-table";
import { ExportButtons } from "@/components/export-buttons";
import { SummaryCards, type FilterMode } from "@/components/summary-cards";
import { ColumnManager } from "@/components/column-manager";
import { useTheme } from "@/components/theme-provider";
import { loadSettings } from "@/lib/settings";
import { loadColumnConfig, type ColumnConfig } from "@/lib/columns";
import { Sun, Moon, BarChart3, Zap, AlertTriangle, X, Search } from "lucide-react";
import {
  type AsinInput,
  type AsinResult,
  type PriceSource,
  type Settings,
  type ProgressUpdate,
  type ColumnId,
  getSelectedPrice,
  calculateProfit,
  getEffectivePrep,
  getEffectiveStorage,
} from "@shared/schema";
import { useToast } from "@/hooks/use-toast";

const BUY_LIST_KEY = "fba-buy-list";

function loadBuyList(): Set<string> {
  try {
    const stored = localStorage.getItem(BUY_LIST_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch {}
  return new Set();
}

function saveBuyList(set: Set<string>) {
  localStorage.setItem(BUY_LIST_KEY, JSON.stringify(Array.from(set)));
}

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
  const [activeFilter, setActiveFilter] = useState<FilterMode>("all");
  const [buySet, setBuySet] = useState<Set<string>>(loadBuyList);
  const [sortCol, setSortCol] = useState<ColumnId | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterEligible, setFilterEligible] = useState("all");
  const [filterMinMargin, setFilterMinMargin] = useState("0");
  const [filterMinRoi, setFilterMinRoi] = useState("0");

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
      if (hasPrepOverrides) parts.push("Prep Cost");
      if (hasStorageOverrides) parts.push("Additional Fees");
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
                const resultData = msg.data;
                if (resultData._update) {
                  delete resultData._update;
                  setResults((prev) =>
                    prev.map((r) => (r.asin === resultData.asin ? resultData : r))
                  );
                } else {
                  setResults((prev) => [...prev, resultData]);
                }
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

  const handleToggleBuy = useCallback((asin: string) => {
    setBuySet((prev) => {
      const next = new Set(prev);
      if (next.has(asin)) next.delete(asin);
      else next.add(asin);
      saveBuyList(next);
      return next;
    });
  }, []);

  const handleClearBuyList = useCallback(() => {
    setBuySet(new Set());
    saveBuyList(new Set());
    if (activeFilter === "buyList") setActiveFilter("all");
  }, [activeFilter]);

  const handleSort = useCallback((colId: ColumnId) => {
    setSortCol((prev) => {
      if (prev === colId) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return colId;
      }
      setSortDir("asc");
      return colId;
    });
  }, []);

  const buyListCount = useMemo(() => {
    return results.filter((r) => buySet.has(r.asin)).length;
  }, [results, buySet]);

  const queryFilteredResults = useMemo(() => {
    let out = results;
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      out = out.filter((r) =>
        r.asin.toLowerCase().includes(q) ||
        (r.catalogData.title ?? "").toLowerCase().includes(q) ||
        (r.catalogData.brand ?? "").toLowerCase().includes(q)
      );
    }
    if (filterEligible !== "all") {
      out = out.filter((r) => (r.eligibilityData?.status ?? "check") === filterEligible);
    }
    const minMargin = parseFloat(filterMinMargin);
    const minRoi = parseFloat(filterMinRoi);
    if (minMargin > 0 || minRoi > 0) {
      out = out.filter((r) => {
        const { price } = getSelectedPrice(r, priceSource);
        if (!price) return false;
        const prep = getEffectivePrep(r, settings);
        const storage = getEffectiveStorage(r, settings);
        const p = calculateProfit(
          price, r.cogs,
          r.feesData.fbaFulfillmentFee ?? 0,
          r.feesData.referralFee ?? 0,
          r.feesData.feesEstimatePrice,
          r.catalogData.weightLbs,
          prep.value, storage.value, settings
        );
        if (minMargin > 0 && p.margin < minMargin) return false;
        if (minRoi > 0 && p.roi < minRoi) return false;
        return true;
      });
    }
    return out;
  }, [results, searchQuery, filterEligible, filterMinMargin, filterMinRoi, priceSource, settings]);

  const activeFilterCount = [
    searchQuery.trim() !== "" ? 1 : 0,
    filterEligible !== "all" ? 1 : 0,
    parseFloat(filterMinMargin) > 0 ? 1 : 0,
    parseFloat(filterMinRoi) > 0 ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  function clearSearchFilters() {
    setSearchQuery("");
    setFilterEligible("all");
    setFilterMinMargin("0");
    setFilterMinRoi("0");
  }

  const progressPercent = progress
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="px-4">
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

      <main className="py-6 space-y-6">
        <div className="px-4">
          {credentialsConfigured === false && (
            <Alert variant="destructive" data-testid="alert-credentials" className="mb-6">
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
            <div className="space-y-2 mt-6">
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
        </div>

        {results.length > 0 && (
          <>
            <div className="px-4">
              <SummaryCards
                results={results}
                priceSource={priceSource}
                settings={settings}
                activeFilter={activeFilter}
                onFilterChange={setActiveFilter}
                buyListCount={buyListCount}
              />
            </div>

            <div className="flex items-center justify-between gap-4 flex-wrap px-4">
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
                {buySet.size > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClearBuyList}
                    className="text-xs text-muted-foreground"
                    data-testid="button-clear-buy-list"
                  >
                    <X className="h-3 w-3 mr-1" />
                    Clear Buy List
                  </Button>
                )}
                <ExportButtons results={results} priceSource={priceSource} settings={settings} />
                <ColumnManager config={columnConfig} onChange={setColumnConfig} />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 px-4">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="Search ASIN, name, or brand..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 h-9"
                  data-testid="input-search"
                />
              </div>
              <Select value={filterEligible} onValueChange={setFilterEligible}>
                <SelectTrigger className="w-[148px] h-9" data-testid="select-filter-eligible">
                  <SelectValue placeholder="Eligibility" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Eligibility</SelectItem>
                  <SelectItem value="yes">Yes (Ungated)</SelectItem>
                  <SelectItem value="no">No (Gated)</SelectItem>
                  <SelectItem value="check">Check</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filterMinMargin} onValueChange={setFilterMinMargin}>
                <SelectTrigger className="w-[148px] h-9" data-testid="select-filter-margin">
                  <SelectValue placeholder="Min Margin" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Any Margin</SelectItem>
                  <SelectItem value="10">≥ 10% Margin</SelectItem>
                  <SelectItem value="15">≥ 15% Margin</SelectItem>
                  <SelectItem value="20">≥ 20% Margin</SelectItem>
                  <SelectItem value="25">≥ 25% Margin</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filterMinRoi} onValueChange={setFilterMinRoi}>
                <SelectTrigger className="w-[148px] h-9" data-testid="select-filter-roi">
                  <SelectValue placeholder="Min ROI" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Any ROI</SelectItem>
                  <SelectItem value="10">≥ 10% ROI</SelectItem>
                  <SelectItem value="20">≥ 20% ROI</SelectItem>
                  <SelectItem value="30">≥ 30% ROI</SelectItem>
                  <SelectItem value="50">≥ 50% ROI</SelectItem>
                </SelectContent>
              </Select>
              {activeFilterCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearSearchFilters}
                  className="h-9 text-muted-foreground"
                  data-testid="button-clear-filters"
                >
                  <X className="h-3 w-3 mr-1" />
                  Clear ({activeFilterCount})
                </Button>
              )}
              {queryFilteredResults.length !== results.length && (
                <span className="text-xs text-muted-foreground ml-1">
                  {queryFilteredResults.length} of {results.length} shown
                </span>
              )}
            </div>

            <ResultsTable
              results={queryFilteredResults}
              priceSource={priceSource}
              settings={settings}
              columnConfig={columnConfig}
              activeFilter={activeFilter}
              buySet={buySet}
              onToggleBuy={handleToggleBuy}
              sortCol={sortCol}
              sortDir={sortDir}
              onSort={handleSort}
            />
          </>
        )}

        {!isAnalyzing && results.length === 0 && asins.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <BarChart3 className="h-16 w-16 text-muted-foreground/30 mb-4" />
            <h2 className="text-lg font-medium text-muted-foreground">
              Upload a file to get started
            </h2>
            <p className="text-sm text-muted-foreground/70 mt-1 max-w-md">
              Upload a CSV or Excel file with ASIN and COGS columns.
              Optionally include Prep Cost, Additional Fees, and Buy Link columns for per-ASIN overrides.
              The analyzer will fetch pricing data from Amazon SP-API and calculate profitability for each product.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
