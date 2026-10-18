import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installBuildIdHeader, currentEntryScript } from "@/lib/build-check";

// Stale-page guard (2026-10-18): every /api request carries this page's build
// id, so the server can refuse mutating requests from a tab running an older
// build. Dev serves /src/main.tsx — no build id, no header (the server's guard
// is off in dev too).
installBuildIdHeader(currentEntryScript(document));

createRoot(document.getElementById("root")!).render(<App />);
