import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const serverPath = fileURLToPath(new URL("standalone-server.mjs", import.meta.url));
const nodePath = process.execPath;

const env = {
  ...process.env,
  MOCK_TELEMETRY: "true",
  HOST: "127.0.0.1",
  HTTP_PORT: "13000",
  UDP_PORT: "15300"
};

const server = spawn(nodePath, [serverPath], {
  cwd: projectRoot,
  env,
  stdio: ["ignore", "pipe", "pipe"]
});

const logs = [];
server.stdout.on("data", (chunk) => logs.push(chunk.toString()));
server.stderr.on("data", (chunk) => logs.push(chunk.toString()));

try {
  await waitForHttp("http://127.0.0.1:13000/api/status", 7000);
  const status = await fetchJson("http://127.0.0.1:13000/api/status");
  const telemetry = await fetchJson("http://127.0.0.1:13000/api/telemetry");

  assert(status.ok === true, "status.ok should be true");
  assert(status.broadcastHz === 60, "status.broadcastHz should be 60");
  assert(typeof status.broadcastIntervalMs === "number", "status.broadcastIntervalMs should be numeric");
  assert(status.mockTelemetry === true, "status.mockTelemetry should be true");
  assert(telemetry.snapshot?.vehicle?.speedKmh > 0, "mock telemetry speed should be present");

  console.log("PASS standalone server smoke test");
  console.log(`PASS /api/status broadcastHz=${status.broadcastHz}, intervalMs=${status.broadcastIntervalMs}`);
  console.log(`PASS /api/telemetry speedKmh=${telemetry.snapshot.vehicle.speedKmh.toFixed(1)}`);
} catch (error) {
  console.error("FAIL standalone server smoke test");
  console.error(error.message);
  if (logs.length > 0) {
    console.error("\nServer output:");
    console.error(logs.join(""));
  }
  process.exitCode = 1;
} finally {
  server.kill();
}

async function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetchJson(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
