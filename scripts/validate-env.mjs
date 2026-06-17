import dgram from "node:dgram";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const envPath = resolve(projectRoot, ".env");
const npmrcPath = resolve(projectRoot, ".npmrc");

const results = [];

function record(name, ok, detail, critical = false) {
  results.push({ name, ok, detail, critical });
}

function parseEnvFile(path) {
  if (!existsSync(path)) {
    return {};
  }

  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }

    values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return values;
}

function parsePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function parseHz(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && (parsed === 0 || (parsed >= 1 && parsed <= 240)) ? parsed : fallback;
}

function parseRenderHz(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 240 ? parsed : fallback;
}

function parseTransportMode(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "json" || normalized === "binary" ? normalized : fallback;
}

function parseSendTimeoutMs(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 10 && parsed <= 1000 ? parsed : fallback;
}

function formatHz(value) {
  return value === 0 ? "uncapped" : `${value}Hz (${(1000 / value).toFixed(2)}ms)`;
}

function findNpmCommand() {
  const candidates = [{ command: process.platform === "win32" ? "npm.cmd" : "npm", argsPrefix: [], label: "npm" }];

  if (process.platform === "win32") {
    const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
    if (existsSync(npmCli)) {
      candidates.push({ command: process.execPath, argsPrefix: [npmCli], label: npmCli });
    }
  }

  const errors = [];
  for (const candidate of candidates) {
    const result = spawnCommand(candidate, ["--version"]);
    if (result.status === 0) {
      return { ...candidate, version: result.stdout.trim() };
    }
    errors.push(`${candidate.label}: ${result.stderr || result.error?.message || "not found"}`);
  }

  return { command: candidates[0].command, argsPrefix: [], label: candidates[0].label, version: null, error: errors.join("; ") };
}

function spawnCommand(tool, args, cwd = projectRoot) {
  const command = typeof tool === "string" ? tool : tool.command;
  const allArgs = [...(typeof tool === "string" ? [] : tool.argsPrefix), ...args];

  if (process.platform === "win32" && command.toLowerCase().endsWith(".exe")) {
    return spawnSync(command, allArgs, {
      cwd,
      encoding: "utf8"
    });
  }

  if (process.platform === "win32") {
    const escapedCommand = command.includes(" ") ? `"${command}"` : command;
    const cmd = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
    return spawnSync(cmd, ["/d", "/s", "/c", [escapedCommand, ...allArgs.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg))].join(" ")], {
      cwd,
      encoding: "utf8"
    });
  }

  return spawnSync(command, allArgs, {
    cwd,
    encoding: "utf8"
  });
}

function getConfiguredCache(npm) {
  const result = spawnCommand(npm, ["config", "get", "cache"]);

  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }

  if (existsSync(npmrcPath)) {
    const match = readFileSync(npmrcPath, "utf8").match(/^cache=(.+)$/m);
    if (match) {
      return resolve(projectRoot, match[1].trim());
    }
  }

  return resolve(projectRoot, ".npm-cache");
}

function checkCacheWritable(cachePath) {
  const testDir = resolve(cachePath, "_codex-env-check");
  const testFile = resolve(testDir, "write-test.txt");
  mkdirSync(testDir, { recursive: true });
  writeFileSync(testFile, "ok", "utf8");
  rmSync(testDir, { recursive: true, force: true });
}

function checkTcpPort(host, port) {
  return new Promise((resolveCheck) => {
    const server = net.createServer();
    server.once("error", (error) => {
      resolveCheck({ ok: false, error: error.code || error.message });
    });
    server.listen(port, host, () => {
      server.close(() => resolveCheck({ ok: true }));
    });
  });
}

function checkUdpPort(host, port) {
  return new Promise((resolveCheck) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", (error) => {
      socket.close();
      resolveCheck({ ok: false, error: error.code || error.message });
    });
    socket.bind(port, host, () => {
      socket.close();
      resolveCheck({ ok: true });
    });
  });
}

function checkRegistry(timeoutMs = 5000) {
  return new Promise((resolveCheck) => {
    const request = https.get("https://registry.npmjs.org/-/ping", { timeout: timeoutMs }, (response) => {
      response.resume();
      resolveCheck({ ok: response.statusCode >= 200 && response.statusCode < 400, status: response.statusCode });
    });

    request.once("timeout", () => {
      request.destroy(new Error("timeout"));
    });

    request.once("error", (error) => {
      resolveCheck({ ok: false, error: error.code || error.message });
    });
  });
}

function getLocalIps() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, addresses]) =>
      (addresses || [])
        .filter((address) => address.family === "IPv4" && !address.internal)
        .map((address) => `${name}: ${address.address}`)
    );
}

const env = { ...parseEnvFile(envPath), ...process.env };
const host = env.HOST?.trim() || "0.0.0.0";
const httpPort = parsePort(env.HTTP_PORT, 3000);
const udpPort = parsePort(env.UDP_PORT, 5400);
const broadcastHz = parseHz(env.TELEMETRY_BROADCAST_HZ, 60);
const renderHz = parseRenderHz(env.DASHBOARD_RENDER_HZ ?? env.VITE_RENDER_HZ, 60);
const transportMode = parseTransportMode(env.TRANSPORT_MODE ?? env.TELEMETRY_TRANSPORT_MODE, "json");
const websocketSendTimeoutMs = parseSendTimeoutMs(env.WEBSOCKET_SEND_TIMEOUT_MS, 50);

const nodeMajor = Number(process.versions.node.split(".")[0]);
record("Node.js", nodeMajor >= 20, `v${process.versions.node}`, true);
record(".env", existsSync(envPath), existsSync(envPath) ? envPath : "missing; copy .env.example .env", false);

const npm = findNpmCommand();
record("npm", Boolean(npm.version), npm.version ? `${npm.version} (${npm.label})` : npm.error, true);

const rustc = spawnCommand("rustc", ["--version"]);
record("Rust compiler", rustc.status === 0, rustc.status === 0 ? rustc.stdout.trim() : rustc.stderr || rustc.error?.message || "rustc not found", true);

const cargo = spawnCommand("cargo", ["--version"]);
record("Cargo", cargo.status === 0, cargo.status === 0 ? cargo.stdout.trim() : cargo.stderr || cargo.error?.message || "cargo not found", true);

if (npm.version) {
  const cachePath = getConfiguredCache(npm);
  try {
    checkCacheWritable(cachePath);
    record("npm cache", true, cachePath, true);
  } catch (error) {
    record("npm cache", false, `${cachePath}: ${error.message}`, true);
  }
}

record("HTTP config", true, `${host}:${httpPort}`, false);
record("UDP config", true, `${host}:${udpPort}`, false);
record("Broadcast Hz", broadcastHz === Number(env.TELEMETRY_BROADCAST_HZ || 60), formatHz(broadcastHz), false);
record("Render Hz", renderHz === Number(env.DASHBOARD_RENDER_HZ ?? env.VITE_RENDER_HZ ?? 60), formatHz(renderHz), false);
record("Transport Mode", transportMode === String(env.TRANSPORT_MODE ?? env.TELEMETRY_TRANSPORT_MODE ?? "json").trim().toLowerCase(), transportMode, false);
record("WebSocket send timeout", websocketSendTimeoutMs === Number(env.WEBSOCKET_SEND_TIMEOUT_MS || 50), `${websocketSendTimeoutMs}ms`, false);

const tcp = await checkTcpPort(host, httpPort);
record("HTTP port bind", tcp.ok, tcp.ok ? `available on ${host}:${httpPort}` : tcp.error, true);

const udp = await checkUdpPort(host, udpPort);
record("UDP port bind", udp.ok, udp.ok ? `available on ${host}:${udpPort}` : udp.error, true);

const ips = getLocalIps();
record("LAN IPv4", ips.length > 0, ips.length > 0 ? ips.join(", ") : "no non-internal IPv4 address found", false);

const registry = await checkRegistry();
record("npm registry", registry.ok, registry.ok ? `reachable (${registry.status})` : registry.error, false);

for (const result of results) {
  const icon = result.ok ? "PASS" : result.critical ? "FAIL" : "WARN";
  console.log(`${icon} ${result.name}: ${result.detail}`);
}

const failedCritical = results.filter((result) => result.critical && !result.ok);
if (failedCritical.length > 0) {
  console.error(`\n${failedCritical.length} critical environment check(s) failed.`);
  process.exit(1);
}

console.log("\nEnvironment checks completed.");
