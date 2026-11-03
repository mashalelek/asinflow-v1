/**
 * Dashboard (SPEC §28, patch docs/claude_spec-patch-analytics-dashboard.md).
 * Commit 1 registers the route in its nav slot; the set selector, the
 * Spend · Sales · Profit grid and the charts land in commits 5–6.
 *
 * Rule (§2.1): this page NEVER reads or writes the global date range — its
 * ranges come from its own set selector and the charts' local picker.
 */
export default function Dashboard() {
  return (
    <div className="p-6 space-y-4" data-testid="page-dashboard">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="text-sm text-muted-foreground">Spend · Sales · Profit — coming with the next commits of this patch.</p>
    </div>
  );
}
