/**
 * Cloud entrypoint: the three agent-side processes in one container.
 *
 *   npm run all
 *
 * The receipts API, the analyst desk and the orchestrator share one sqlite
 * ledger, so they must share one filesystem — one container, three children.
 * If any child dies the whole process exits non-zero and the platform
 * restarts the container; startup reconciliation makes that safe.
 */
import { spawn } from "node:child_process";

const CHILDREN = ["src/serve.ts", "src/analyst.ts", "src/orchestrator.ts"];

let shuttingDown = false;
const procs = CHILDREN.map((script) => {
  const p = spawn(process.execPath, [script], { stdio: "inherit" });
  p.on("exit", (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`${script} exited with ${code}; restarting the container`);
    for (const q of procs) q.kill("SIGTERM");
    process.exit(code ?? 1);
  });
  return p;
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shuttingDown = true;
    for (const p of procs) p.kill(signal);
    process.exit(0);
  });
}
