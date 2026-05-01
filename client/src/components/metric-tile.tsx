import { Card } from "@/components/ui/card";

type Format = "currency" | "percent" | "integer";

function formatValue(value: number | null, format: Format): string {
  if (value == null) return "\u2014";
  switch (format) {
    case "currency":
      return value < 0
        ? `-$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case "percent":
      return `${value.toFixed(1)}%`;
    case "integer":
      return value.toLocaleString();
  }
}

interface SingleTileProps {
  label: string;
  value: number | null;
  format: Format;
}

interface DualTileProps {
  label: string;
  estValue: number | null;
  actValue: number | null;
  format: Format;
}

export function MetricTile({ label, value, format }: SingleTileProps) {
  return (
    <Card className="p-4 overflow-hidden">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold mt-1 text-foreground">
        {formatValue(value, format)}
      </p>
    </Card>
  );
}

export function DualMetricTile({ label, estValue, actValue, format }: DualTileProps) {
  return (
    <Card className="p-4 overflow-hidden">
      <p className="text-xs text-muted-foreground mb-2">{label}</p>
      <div className="flex items-end gap-4">
        <div className="flex-1">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Est</p>
          <p className="text-xl font-bold text-foreground">
            {formatValue(estValue, format)}
          </p>
        </div>
        <div className="w-px h-8 bg-border" />
        <div className="flex-1">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Actual</p>
          <p className="text-xl font-bold text-foreground">
            {formatValue(actValue, format)}
          </p>
        </div>
      </div>
    </Card>
  );
}
