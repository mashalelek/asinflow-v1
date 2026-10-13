import 'dotenv/config';
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { ensureExtensionTables, query } from "./db";
import { startRefreshCron } from "./refresh-cron";
import { startSourcingSyncCron } from "./sourcing-sync-cron";
import { startAuraSyncCron } from "./aura-sync-cron";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// CORS middleware for Chrome extension requests
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (origin.startsWith("chrome-extension://") || origin === process.env.CORS_ALLOWED_ORIGIN)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(
  express.json({
    // 10mb (2026-09-07): the 100 KB default 413'd a 1,962-row Bulk Calc
    // "Create list" body (~527 KB). Largest realistic upload is a few MB.
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  if (process.env.DATABASE_URL) {
    try {
      await ensureExtensionTables();
      log("Extension database tables initialized");
    } catch (err: any) {
      log(`Extension table init failed: ${err.message}`, "db");
    }
  } else {
    log("DATABASE_URL not set — extension database features disabled", "db");
  }

  // Health check for the hosting platform (SPEC "Deployment"). Unauthenticated.
  // Registered BEFORE the static catch-all: /{*path} serves index.html for any
  // unknown route with a 200, which would mask a dead database. 200 only when
  // a trivial read of the main table succeeds; 503 with a FIXED body otherwise.
  // The pg error goes to the server log only — it can carry the database host,
  // and this route is public.
  app.get("/health", async (_req: Request, res: Response) => {
    try {
      await query("SELECT 1 FROM asins LIMIT 1");
      res.json({ ok: true });
    } catch (err: any) {
      log(`health check failed: ${err?.message ?? err}`, "health");
      res.status(503).json({ ok: false });
    }
  });

  await registerRoutes(httpServer, app);

  // Scheduled crons are OFF by default: the host Mac is asleep at the
  // scheduled times (node-cron fires host-local and silently skips missed
  // ticks), so manual toolbar/API triggers are the operating model. Set
  // ENABLE_CRONS=true at cloud deploy. (SPEC §11 "Scheduled crons")
  if (process.env.DATABASE_URL && process.env.ENABLE_CRONS === "true") {
    startRefreshCron();
    startSourcingSyncCron();
    startAuraSyncCron();
  } else if (process.env.DATABASE_URL) {
    log("Scheduled crons disabled (ENABLE_CRONS != 'true') — manual sync triggers are the operating model", "cron");
  }

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
