import { TopNav } from "./top-nav";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <TopNav />
      <main className="min-w-0">{children}</main>
    </div>
  );
}
