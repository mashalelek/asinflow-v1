/**
 * The red "N steps failed in the last pass" (Maria 2026-11-05): shown in the
 * jobs dialog and Settings until a scheduled pass runs clean. Each failed
 * step with its reason; known-persistent ASINs are listed on the job, not here.
 */
import { useEffect, useState } from "react";
import { getLastPass, lastPassText, type LastPass } from "@/lib/jobs-api";

export function LastPassBanner({ onOpenJob }: { onOpenJob?: (jobId: number) => void }) {
  const [pass, setPass] = useState<LastPass | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => getLastPass().then((p) => { if (live) setPass(p); }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const text = lastPassText(pass);
  if (!pass || !text) return null;
  return (
    <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive min-w-0" data-testid="last-pass-failed">
      <p className="font-semibold">
        {text}
        {onOpenJob ? <> · <button type="button" className="underline underline-offset-2" onClick={() => onOpenJob(pass.jobId)}>job #{pass.jobId}</button></> : <> · job #{pass.jobId}</>}
      </p>
      <ul className="mt-1 space-y-0.5">
        {pass.failedSteps.map((s) => (
          <li key={`${s.n}-${s.key}`} className="[overflow-wrap:anywhere]"><span className="font-medium">{s.n ? `${s.n}. ` : ""}{s.name}</span>: {s.reason}</li>
        ))}
      </ul>
    </div>
  );
}
