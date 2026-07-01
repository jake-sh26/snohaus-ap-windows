import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, mkdir, readdir, copyFile } from "node:fs/promises";
import path from "node:path";

// server deps to bundle to reduce openat(2) syscalls
const allowlist = [
  "@google/generative-ai",
  "axios",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "imapflow",
  "jsonwebtoken",
  "mailparser",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "pdf-parse",
  "pdf-lib",
  "heic-convert",
  "libheif-js",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  // PR #237 (P4_Perms) — Copy SQL migration files to dist/migrations/.
  // The bundled cjs runs from `dist/` and the migration runner resolves
  // its dir via `path.resolve(__dirname, "migrations")`. In dev __dirname
  // is <repo>/server so it finds server/migrations/ directly; in prod
  // __dirname is <install>/dist so we need the files sitting beside
  // index.cjs.
  await copyMigrations();
}

async function copyMigrations() {
  const srcDir = "server/migrations";
  const dstDir = "dist/migrations";
  try {
    const files = (await readdir(srcDir)).filter((f) => f.endsWith(".sql"));
    if (files.length === 0) {
      console.log("no migrations to copy");
      return;
    }
    await mkdir(dstDir, { recursive: true });
    for (const f of files) {
      await copyFile(path.join(srcDir, f), path.join(dstDir, f));
    }
    console.log(`copied ${files.length} migration file(s) to ${dstDir}/`);
  } catch (e: any) {
    // Not fatal for build — the runner tolerates a missing dir. But we
    // want to know if this ever fails silently.
    console.warn(`[build] migration copy failed: ${e?.message ?? e}`);
  }
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
