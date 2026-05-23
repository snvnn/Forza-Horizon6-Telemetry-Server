import crypto from "node:crypto";
import dgram from "node:dgram";
import http from "node:http";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const env = { ...readEnv(resolve(projectRoot, ".env")), ...process.env };

const config = {
  udpPort: parsePort(env.UDP_PORT, 5300),
  httpPort: parsePort(env.HTTP_PORT, 3000),
  host: env.HOST?.trim() || "0.0.0.0",
  broadcastHz: parseHz(env.TELEMETRY_BROADCAST_HZ, 60),
  renderHz: parseHz(env.VITE_RENDER_HZ, 60),
  mockTelemetry: parseBoolean(env.MOCK_TELEMETRY, true),
  debugPacket: parseBoolean(env.DEBUG_PACKET, false),
  connectionTimeoutMs: parsePositiveInteger(env.CONNECTION_TIMEOUT_MS, 2000)
};
config.broadcastIntervalMs = 1000 / config.broadcastHz;

let latest = null;
let lastPacketAt = 0;
let lastPacketInfo = null;
const clients = new Set();

function readEnv(path) {
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
    if (index !== -1) {
      values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
    }
  }
  return values;
}

function parsePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function parseHz(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 120 ? parsed : fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value == null || value.trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isConnected(now = Date.now()) {
  return lastPacketAt > 0 && now - lastPacketAt <= config.connectionTimeoutMs;
}

function getSnapshot() {
  if (!latest) {
    return null;
  }
  return { ...latest, connected: isConnected() };
}

function updateSnapshot(snapshot) {
  lastPacketAt = Date.now();
  latest = { ...snapshot, timestamp: snapshot.timestamp || lastPacketAt, connected: true };
}

function parseForzaPacket(packet) {
  const sled = {
    engineMaxRpm: 8,
    currentRpm: 16,
    accelX: 20,
    accelY: 24,
    accelZ: 28,
    velocityX: 32,
    velocityY: 36,
    velocityZ: 40
  };

  function dashOffsets(name, shift) {
    return {
      name,
      engineMaxRpm: 8,
      currentRpm: 16,
      accelX: 20,
      accelY: 24,
      accelZ: 28,
      speedMs: 244 + shift,
      powerW: 248 + shift,
      torqueNm: 252 + shift,
      tireTempFrontLeft: 256 + shift,
      tireTempFrontRight: 260 + shift,
      tireTempRearLeft: 264 + shift,
      tireTempRearRight: 268 + shift,
      boost: 272 + shift,
      throttle: 303 + shift,
      brake: 304 + shift,
      clutch: 305 + shift,
      handbrake: 306 + shift,
      gear: 307 + shift,
      steer: 308 + shift
    };
  }

  const candidates = [
    dashOffsets("forza-horizon-dash", 12),
    dashOffsets("forza-dash", 0)
  ];

  const offsets = candidates
    .map((candidate) => ({ candidate, score: scoreOffsets(packet, candidate) }))
    .sort((left, right) => right.score - left.score)[0];

  if (!offsets || offsets.score < 0) {
    const velocityX = f32(packet, sled.velocityX);
    const velocityY = f32(packet, sled.velocityY);
    const velocityZ = f32(packet, sled.velocityZ);
    const speedMs = Math.hypot(velocityX, velocityY, velocityZ);

    lastPacketInfo = { length: packet.length, format: "forza-sled", dashShift: null };

    return {
      timestamp: Date.now(),
      connected: true,
      vehicle: {
        speedKmh: Math.max(0, speedMs * 3.6),
        rpm: Math.max(0, f32(packet, sled.currentRpm)),
        maxRpm: Math.max(0, f32(packet, sled.engineMaxRpm)),
        gear: 0
      },
      input: {
        throttle: 0,
        brake: 0,
        steer: 0
      },
      motion: {
        accelX: f32(packet, sled.accelX),
        accelY: f32(packet, sled.accelY),
        accelZ: f32(packet, sled.accelZ)
      }
    };
  }

  const o = offsets.candidate;
  lastPacketInfo = {
    length: packet.length,
    format: o.name,
    dashShift: o.speedMs - 244
  };

  const snapshot = {
    timestamp: Date.now(),
    connected: true,
    vehicle: {
      speedKmh: Math.max(0, f32(packet, o.speedMs) * 3.6),
      rpm: Math.max(0, f32(packet, o.currentRpm)),
      maxRpm: Math.max(0, f32(packet, o.engineMaxRpm)),
      gear: normalizeGear(u8(packet, o.gear)),
      powerKw: f32(packet, o.powerW) / 1000,
      torqueNm: clampNonNegative(f32(packet, o.torqueNm)),
      boost: clampNonNegative(f32(packet, o.boost))
    },
    input: {
      throttle: ratio(u8(packet, o.throttle)),
      brake: ratio(u8(packet, o.brake)),
      clutch: ratio(u8(packet, o.clutch)),
      steer: Math.max(-1, Math.min(1, i8(packet, o.steer) / 127)),
      handbrake: ratio(u8(packet, o.handbrake))
    },
    tires: {
      frontLeftTemp: f32(packet, o.tireTempFrontLeft),
      frontRightTemp: f32(packet, o.tireTempFrontRight),
      rearLeftTemp: f32(packet, o.tireTempRearLeft),
      rearRightTemp: f32(packet, o.tireTempRearRight)
    },
    motion: {
      accelX: f32(packet, o.accelX),
      accelY: f32(packet, o.accelY),
      accelZ: f32(packet, o.accelZ)
    }
  };

  if (config.debugPacket) {
    console.log("[packet]", {
      length: packet.length,
      format: o.name,
      dashShift: o.speedMs - 244,
      speedKmh: snapshot.vehicle.speedKmh,
      rpm: snapshot.vehicle.rpm,
      gear: snapshot.vehicle.gear
    });
  }

  return snapshot;
}

function scoreOffsets(packet, offsets) {
  try {
    const speedKmh = f32(packet, offsets.speedMs) * 3.6;
    const powerKw = f32(packet, offsets.powerW) / 1000;
    const torqueNm = f32(packet, offsets.torqueNm);
    const tireTemps = [
      f32(packet, offsets.tireTempFrontLeft),
      f32(packet, offsets.tireTempFrontRight),
      f32(packet, offsets.tireTempRearLeft),
      f32(packet, offsets.tireTempRearRight)
    ];
    const boost = f32(packet, offsets.boost);
    const gearRaw = u8(packet, offsets.gear);

    let score = 0;
    if (isReasonable(speedKmh, 0, 650)) score += 3;
    if (isReasonable(powerKw, -1500, 2500)) score += 2;
    if (isReasonable(torqueNm, -2000, 3000)) score += 2;
    score += tireTemps.filter((value) => isReasonable(value, -50, 350)).length;
    if (isReasonable(boost, -5, 20)) score += 1;
    if (gearRaw >= 0 && gearRaw <= 12) score += 2;
    return score;
  } catch {
    return -1;
  }
}

function isReasonable(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function f32(packet, offset) {
  requireLength(packet, offset, 4);
  return packet.readFloatLE(offset);
}

function u8(packet, offset) {
  requireLength(packet, offset, 1);
  return packet.readUInt8(offset);
}

function i8(packet, offset) {
  requireLength(packet, offset, 1);
  return packet.readInt8(offset);
}

function requireLength(packet, offset, bytes) {
  if (packet.length < offset + bytes) {
    throw new Error(`Packet length ${packet.length} is too short for offset ${offset}`);
  }
}

function ratio(value) {
  return Math.max(0, Math.min(1, value / 255));
}

function clampNonNegative(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeGear(raw) {
  if (raw === 0) return -1;
  if (raw === 1) return 0;
  return raw - 1;
}

function createMockTelemetrySnapshot(now = Date.now()) {
  const seconds = now / 1000;
  const throttle = Math.max(0, Math.min(1, 0.55 + Math.sin(seconds * 1.8) * 0.42));
  const brake = Math.max(0, Math.min(1, Math.sin(seconds * 0.85 + 2.4) * 0.5 - 0.2));
  const speed = 90 + Math.sin(seconds * 0.9) * 45 + Math.max(0, Math.sin(seconds * 0.18)) * 70;
  const rpm = 2800 + Math.sin(seconds * 2.4) * 1800 + Math.sin(seconds * 0.7) * 600;

  return {
    timestamp: now,
    connected: true,
    vehicle: {
      speedKmh: Math.max(0, speed),
      rpm: Math.max(900, rpm),
      maxRpm: 7500,
      gear: Math.max(1, Math.min(6, Math.floor(speed / 45) + 1)),
      powerKw: 210 + throttle * 180,
      torqueNm: 320 + throttle * 220,
      boost: Math.max(0, throttle * 1.2 - brake * 0.4)
    },
    input: {
      throttle,
      brake,
      clutch: 0,
      steer: Math.sin(seconds * 1.2) * 0.85,
      handbrake: 0
    },
    tires: {
      frontLeftTemp: 78 + Math.sin(seconds * 0.8) * 6,
      frontRightTemp: 80 + Math.cos(seconds * 0.7) * 5,
      rearLeftTemp: 84 + Math.sin(seconds * 0.95) * 7,
      rearRightTemp: 83 + Math.cos(seconds * 0.9) * 7
    }
  };
}

const udpSocket = dgram.createSocket("udp4");
udpSocket.on("message", (packet, remote) => {
  try {
    updateSnapshot(parseForzaPacket(packet));
  } catch (error) {
    console.error("[udp] Failed to parse packet", {
      remote: `${remote.address}:${remote.port}`,
      length: packet.length,
      error: error.message
    });
  }
});
udpSocket.on("error", (error) => {
  console.error("[udp] Socket error", error.message);
});
udpSocket.bind(config.udpPort, config.host, () => {
  const address = udpSocket.address();
  console.log(`[udp] Listening on ${address.address}:${address.port}`);
});

if (config.mockTelemetry) {
  setInterval(() => updateSnapshot(createMockTelemetrySnapshot()), 1000 / 60);
  console.log("[mock] Mock telemetry enabled");
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/api/status") {
    sendJson(response, {
      ok: true,
      connected: isConnected(),
      hasTelemetry: latest !== null,
      lastPacketAt: lastPacketAt || null,
      websocketClients: clients.size,
      udpPort: config.udpPort,
      httpPort: config.httpPort,
      host: config.host,
      broadcastHz: config.broadcastHz,
      broadcastIntervalMs: config.broadcastIntervalMs,
      mockTelemetry: config.mockTelemetry,
      connectionTimeoutMs: config.connectionTimeoutMs,
      lastPacket: lastPacketInfo
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/telemetry") {
    sendJson(response, { snapshot: getSnapshot() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(createDashboardHtml(config.renderHz));
    return;
  }

  response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "Not found" }));
});

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== "/ws/telemetry") {
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n"
    ].join("\r\n")
  );

  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));

  const snapshot = getSnapshot();
  if (snapshot) {
    sendWebSocketText(socket, JSON.stringify({ type: "telemetry", snapshot }));
  }
});

setInterval(() => {
  const snapshot = getSnapshot();
  if (!snapshot) {
    return;
  }

  const payload = JSON.stringify({ type: "telemetry", snapshot });
  for (const client of clients) {
    sendWebSocketText(client, payload);
  }
}, config.broadcastIntervalMs);

server.listen(config.httpPort, config.host, () => {
  console.log(`[http] Server listening on http://${config.host}:${config.httpPort}`);
  console.log(`[http] Local URL: http://localhost:${config.httpPort}`);
  for (const ip of getLocalIps()) {
    console.log(`[http] Tablet URL: http://${ip}:${config.httpPort}`);
  }
  console.log("[info] Press Ctrl+C to stop");
});

function sendJson(response, body) {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendWebSocketText(socket, text) {
  if (socket.destroyed) {
    clients.delete(socket);
    return;
  }

  const payload = Buffer.from(text);
  let header;

  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  socket.write(Buffer.concat([header, payload]), (error) => {
    if (error) {
      clients.delete(socket);
      socket.destroy();
    }
  });
}

function getLocalIps() {
  return Object.values(os.networkInterfaces())
    .flatMap((addresses) => addresses || [])
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map((address) => address.address);
}

function createDashboardHtml(renderHz) {
  const renderInterval = 1000 / renderHz;

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Forza Telemetry Standalone</title>
    <style>
      :root { color-scheme: dark; font-family: Segoe UI, system-ui, sans-serif; background: #0b0d10; color: #f4f7fb; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: linear-gradient(180deg, rgba(255,255,255,.05), transparent 360px), #0b0d10; }
      main { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 24px 0 32px; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
      h1 { margin: 0; font-size: clamp(1.8rem, 3vw, 3rem); line-height: 1; }
      .eyebrow { margin: 0 0 4px; color: #7dd3fc; font-size: .78rem; font-weight: 800; text-transform: uppercase; }
      .status { display: flex; align-items: center; gap: 12px; min-width: 230px; padding: 12px 14px; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; background: rgba(255,255,255,.06); }
      .dot { width: 12px; height: 12px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 18px rgba(239,68,68,.65); }
      .dot.live { background: #22c55e; box-shadow: 0 0 18px rgba(34,197,94,.85); }
      .meta { margin-top: 2px; color: #a8b3c4; font-size: .82rem; }
      .waiting, .card { border: 1px solid rgba(255,255,255,.12); border-radius: 8px; background: rgba(18,22,28,.92); box-shadow: 0 16px 50px rgba(0,0,0,.3); }
      .waiting { display: grid; min-height: 320px; place-items: center; color: #a8b3c4; font-size: 1.35rem; font-weight: 800; }
      .grid { display: grid; grid-template-columns: 1.25fr .75fr 1.4fr; gap: 14px; }
      .card { min-height: 160px; padding: 18px; }
      .label { color: #a8b3c4; font-size: .82rem; font-weight: 800; text-transform: uppercase; }
      .speed { grid-row: span 2; display: flex; flex-direction: column; justify-content: center; min-height: 260px; }
      .speed-value { margin: 10px 0; font-size: clamp(5rem, 14vw, 10rem); font-weight: 950; line-height: .9; }
      .gear { display: grid; place-items: center; text-align: center; }
      .gear-value { color: #facc15; font-size: clamp(4rem, 10vw, 7rem); font-weight: 950; line-height: 1; }
      .row { display: grid; grid-template-columns: 82px minmax(90px, 1fr) 62px; align-items: center; gap: 10px; margin-top: 14px; color: #dbe4ef; }
      .row span { color: #a8b3c4; font-size: .9rem; font-weight: 700; }
      .row strong { text-align: right; }
      .track { overflow: hidden; height: 18px; border-radius: 999px; background: rgba(255,255,255,.09); }
      .fill { height: 100%; border-radius: inherit; transition: width 80ms linear; }
      .rpm-track { height: 28px; margin: 30px 0 16px; }
      .rpm-fill { background: linear-gradient(90deg, #22c55e, #facc15 68%, #ef4444); }
      .throttle { background: #22c55e; }
      .brake { background: #ef4444; }
      .steer-track { position: relative; height: 22px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.09); }
      .steer-center { position: absolute; left: 50%; top: 0; width: 2px; height: 100%; background: rgba(255,255,255,.35); }
      .steer-marker { position: absolute; left: calc(50% - 8px); top: 3px; width: 16px; height: 16px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 16px rgba(56,189,248,.75); transition: transform 80ms linear; }
      .stat-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 0; border-bottom: 1px solid rgba(255,255,255,.09); }
      .stat-row:last-child { border-bottom: 0; }
      .stat-row span { color: #a8b3c4; font-weight: 700; }
      .stat-row strong { font-size: 1.35rem; }
      .tires { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
      .tire { display: grid; grid-template-columns: auto 1fr auto; align-items: baseline; gap: 8px; min-height: 58px; padding: 12px; border-radius: 8px; background: rgba(255,255,255,.07); }
      .tire strong { text-align: right; font-size: 1.45rem; }
      .tire span, .tire small { color: #a8b3c4; font-weight: 800; }
      @media (max-width: 860px) { header { flex-direction: column; align-items: stretch; } .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .speed { grid-column: span 2; min-height: 210px; } }
      @media (max-width: 560px) { main { width: min(100vw - 20px, 760px); padding-top: 14px; } .grid { grid-template-columns: 1fr; } .speed { grid-column: auto; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <p class="eyebrow">Forza Data Out</p>
          <h1>Telemetry Monitor</h1>
        </div>
        <section class="status">
          <div id="dot" class="dot"></div>
          <div>
            <strong id="status-label">connecting</strong>
            <div id="status-meta" class="meta">Render ${renderHz}Hz</div>
          </div>
        </section>
      </header>
      <section id="waiting" class="waiting">Waiting for telemetry...</section>
      <section id="grid" class="grid" hidden>
        <section class="card speed"><div class="label">Speed</div><div id="speed" class="speed-value">0</div><div class="meta">km/h</div></section>
        <section class="card gear"><div class="label">Gear</div><div id="gear" class="gear-value">N</div></section>
        <section class="card"><div class="label">RPM</div><div id="rpm-readout" style="font-size:2rem;font-weight:900;text-align:right">0</div><div class="track rpm-track"><div id="rpm-fill" class="fill rpm-fill"></div></div><div id="rpm-max" class="meta">Max 0</div></section>
        <section class="card"><div class="label">Inputs</div><div class="row"><span>Throttle</span><div class="track"><div id="throttle" class="fill throttle"></div></div><strong id="throttle-text">0%</strong></div><div class="row"><span>Brake</span><div class="track"><div id="brake" class="fill brake"></div></div><strong id="brake-text">0%</strong></div><div class="row"><span>Steer</span><div class="steer-track"><div class="steer-center"></div><div id="steer" class="steer-marker"></div></div><strong id="steer-text">0%</strong></div></section>
        <section class="card"><div class="label">Powertrain</div><div class="stat-row"><span>Power</span><strong id="power">-- kW</strong></div><div class="stat-row"><span>Torque</span><strong id="torque">-- Nm</strong></div><div class="stat-row"><span>Boost</span><strong id="boost">--</strong></div></section>
        <section class="card"><div class="label">Tire Temps</div><div class="tires"><div class="tire"><span>FL</span><strong id="tfl">--</strong><small>deg</small></div><div class="tire"><span>FR</span><strong id="tfr">--</strong><small>deg</small></div><div class="tire"><span>RL</span><strong id="trl">--</strong><small>deg</small></div><div class="tire"><span>RR</span><strong id="trr">--</strong><small>deg</small></div></div></section>
      </section>
    </main>
    <script>
      let latest = null;
      let status = "connecting";
      const renderInterval = ${renderInterval};
      const $ = (id) => document.getElementById(id);
      function wsUrl() {
        return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/telemetry";
      }
      function connect() {
        status = latest ? "reconnecting" : "connecting";
        const ws = new WebSocket(wsUrl());
        ws.addEventListener("open", () => status = "connected");
        ws.addEventListener("message", (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === "telemetry") latest = message.snapshot;
          } catch (error) {
            console.error(error);
          }
        });
        ws.addEventListener("close", () => {
          status = "reconnecting";
          setTimeout(connect, 1000);
        });
        ws.addEventListener("error", () => ws.close());
      }
      function pct(value) { return Math.round(Math.max(0, Math.min(1, value || 0)) * 100); }
      function gear(value) { return value < 0 ? "R" : value === 0 ? "N" : String(value); }
      function num(value, digits = 0) { return Number.isFinite(value) ? value.toFixed(digits) : "--"; }
      function render() {
        const live = status === "connected" && latest && latest.connected;
        $("dot").className = "dot" + (live ? " live" : "");
        $("status-label").textContent = live ? "Live" : latest && !latest.connected ? "stale" : status;
        $("status-meta").textContent = "Render ${renderHz}Hz" + (latest ? " · Last " + new Date(latest.timestamp).toLocaleTimeString() : "");
        $("waiting").hidden = !!latest;
        $("grid").hidden = !latest;
        if (!latest) return;
        const v = latest.vehicle, i = latest.input, t = latest.tires || {};
        $("speed").textContent = Math.round(v.speedKmh || 0);
        $("gear").textContent = gear(v.gear || 0);
        $("rpm-readout").textContent = Math.round(v.rpm || 0).toLocaleString();
        $("rpm-fill").style.width = Math.max(0, Math.min(1, (v.rpm || 0) / (v.maxRpm || 8000))) * 100 + "%";
        $("rpm-max").textContent = "Max " + Math.round(v.maxRpm || 8000).toLocaleString();
        $("throttle").style.width = pct(i.throttle) + "%";
        $("brake").style.width = pct(i.brake) + "%";
        $("throttle-text").textContent = pct(i.throttle) + "%";
        $("brake-text").textContent = pct(i.brake) + "%";
        $("steer").style.transform = "translateX(" + Math.max(-50, Math.min(50, (i.steer || 0) * 50)) + "%)";
        $("steer-text").textContent = Math.round((i.steer || 0) * 100) + "%";
        $("power").textContent = num(v.powerKw) + " kW";
        $("torque").textContent = num(v.torqueNm) + " Nm";
        $("boost").textContent = num(v.boost, 2);
        $("tfl").textContent = num(t.frontLeftTemp);
        $("tfr").textContent = num(t.frontRightTemp);
        $("trl").textContent = num(t.rearLeftTemp);
        $("trr").textContent = num(t.rearRightTemp);
      }
      connect();
      setInterval(render, renderInterval);
    </script>
  </body>
</html>`;
}

process.on("SIGINT", () => {
  console.log("\n[server] Shutting down");
  udpSocket.close();
  for (const client of clients) client.destroy();
  server.close(() => process.exit(0));
});
