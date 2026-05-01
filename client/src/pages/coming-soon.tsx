import type { LucideIcon } from "lucide-react";

interface ComingSoonProps {
  title: string;
  icon: LucideIcon;
}

export default function ComingSoon({ title, icon: Icon }: ComingSoonProps) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-center space-y-4">
        <Icon className="h-16 w-16 text-muted-foreground/30 mx-auto" />
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        <p className="text-muted-foreground">Coming soon</p>
      </div>
    </div>
  );
}
