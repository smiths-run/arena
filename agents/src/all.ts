/**
 * Cloud entrypoint: the three agent-side processes in one container.
 *
 *   npm run all
 *
 * The receipts API, the two desks and the orchestrator share one sqlite ledger,
 * so they must share one filesystem — one container, four children. If any
 * child dies the whole process exits non-zero and the platform restarts the
 * container; startup reconciliation makes that safe.
 *
 * The mind desk only joins when it has been given an address to be paid at.
 * Starting it without one would take the whole container down on boot, and a
 * missing optional feature is not a reason for the economy to stop.
 */
import { spawn } from "node:child_process";

const CHILDREN = [
  "src/serve.ts",
  "src/analyst.ts",
  ...(process.env.MIND_DESK_ADDRESS ? ["src/mind.ts"] : []),
  "src/orchestrator.ts",
];
if (!process.env.MIND_DESK_ADDRESS) {
  console.log("mind desk not started: MIND_DESK_ADDRESS is not set");
}

let shuttingDown = false;
const procs = CHILDREN.map((script) => {
  const p = spawn(process.execPath, [script], { stdio: "inherit" });
  p.on("exit", (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    // A platform stopping us — a redeploy, a scale-down — sends SIGTERM to the
    // whole group, so a child can be seen dying before our own signal handler
    // runs. Reporting that as a crash is how a normal deploy came to look like
    // one, and mailed a crash alert every time.
    if (signal === "SIGTERM" || signal === "SIGINT") {
      for (const q of procs) q.kill(signal);
      process.exit(0);
    }

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
