import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  // fall through to index.html for non-API routes (SPA client-side routing)
  app.use("/{*path}", (req, res) => {
    // Don't intercept API routes
    if (req.path.startsWith("/api/")) {
      res.status(404).json({ message: "Not found" });
      return;
    }
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
