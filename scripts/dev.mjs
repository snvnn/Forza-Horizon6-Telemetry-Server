import { spawn } from "node:child_process";

const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";

const commands = [
  ["server-rs", ["run", "dev:server"]],
  ["dashboard", ["run", "dev", "-w", "@forza-telemetry/dashboard"]]
];

const children = commands.map(([name, args]) => {
  const child = spawn(npmCommand, npmExecPath ? [npmExecPath, ...args] : args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`[${name}] stopped by ${signal}`);
      return;
    }

    if (code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
      shutdown(code ?? 1);
    }
  });

  return child;
});

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
