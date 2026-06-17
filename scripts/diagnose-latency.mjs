const DEFAULT_URL = "http://127.0.0.1:3000/api/status";
const DEFAULT_SECONDS = 10;
const DEFAULT_INTERVAL_MS = 500;

const args = parseArgs(process.argv.slice(2));
const statusUrl = String(args.url ?? DEFAULT_URL);
const durationMs = Math.max(1000, Number(args.seconds ?? DEFAULT_SECONDS) * 1000);
const intervalMs = Math.max(100, Number(args["interval-ms"] ?? DEFAULT_INTERVAL_MS));
const outputJson = Boolean(args.json);

const samples = [];
const startedAt = performance.now();

try {
  while (performance.now() - startedAt < durationMs) {
    const fetchedAt = Date.now();
    const status = await fetchStatus(statusUrl);
    samples.push({ fetchedAt, status });
    await sleep(intervalMs);
  }

  if (samples.length < 2) {
    throw new Error("Need at least two samples to compute deltas.");
  }

  const summary = summarize(samples);
  if (outputJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printSummary(summary);
  }
} catch (error) {
  console.error(`FAIL latency diagnostics: ${error.message}`);
  process.exitCode = 1;
}

async function fetchStatus(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }

  const status = await response.json();
  if (status.ok !== true) {
    throw new Error(`${url} returned ok=false`);
  }

  return status;
}

function summarize(samples) {
  const first = samples[0].status;
  const last = samples[samples.length - 1].status;
  const elapsedSeconds = (samples[samples.length - 1].fetchedAt - samples[0].fetchedAt) / 1000;
  const broadcastStatsFirst = first.broadcastStats ?? {};
  const broadcastStatsLast = last.broadcastStats ?? {};
  const histogramDelta = diffHistogram(first.packetGapHistogram, last.packetGapHistogram);
  const udpPacketsDelta = delta(first.receivedPacketCount, last.receivedPacketCount);
  const broadcastFramesDelta = delta(broadcastStatsFirst.broadcastCount, broadcastStatsLast.broadcastCount);
  const broadcastRequestsDelta = delta(
    broadcastStatsFirst.broadcastRequestCount,
    broadcastStatsLast.broadcastRequestCount
  );
  const coalescedDelta = delta(
    broadcastStatsFirst.coalescedBroadcastRequests,
    broadcastStatsLast.coalescedBroadcastRequests
  );
  const websocketSendDelta = delta(
    broadcastStatsFirst.websocketSendCount,
    broadcastStatsLast.websocketSendCount
  );
  const websocketTimeoutDelta = delta(
    broadcastStatsFirst.websocketSendTimeouts,
    broadcastStatsLast.websocketSendTimeouts
  );
  const websocketErrorDelta = delta(
    broadcastStatsFirst.websocketSendErrors,
    broadcastStatsLast.websocketSendErrors
  );
  const packetGapDelta = delta(first.packetGapCount, last.packetGapCount);

  const summary = {
    statusUrl,
    sampleCount: samples.length,
    elapsedSeconds,
    server: {
      telemetryRunning: last.telemetryRunning === true,
      gameConnected: last.gameConnected === true,
      udpListeningAddress: last.udpListeningAddress ?? null,
      httpListeningAddress: last.httpListeningAddress ?? null,
      websocketClients: numberOrZero(last.websocketClients),
      mockTelemetry: last.mockTelemetry === true
    },
    udp: {
      packetsDelta: udpPacketsDelta,
      measuredHz: rate(udpPacketsDelta, elapsedSeconds),
      estimatedHzLast: nullableNumber(last.estimatedPacketHz),
      lastPacketAgeMs: nullableNumber(last.lastPacketAgeMs),
      maxPacketGapMs: numberOrZero(last.maxPacketGapMs),
      packetGapWarningMs: numberOrZero(last.packetGapWarningMs),
      packetGapDelta,
      packetGapHistogramDelta: histogramDelta,
      recentPacketGaps: Array.isArray(last.recentPacketGaps) ? last.recentPacketGaps.slice(-8) : []
    },
    broadcast: {
      configuredHz: nullableNumber(last.broadcastHz),
      transportMode: typeof last.transportMode === "string" ? last.transportMode : "unknown",
      dashboardRenderHz: nullableNumber(last.dashboardRenderHz),
      estimatedHzLast: nullableNumber(broadcastStatsLast.estimatedBroadcastHz),
      requestsDelta: broadcastRequestsDelta,
      framesDelta: broadcastFramesDelta,
      measuredHz: rate(broadcastFramesDelta, elapsedSeconds),
      coalescedDelta,
      lastSnapshotAgeMsAtBroadcast: nullableNumber(broadcastStatsLast.lastSnapshotAgeMsAtBroadcast),
      maxSnapshotAgeMsAtBroadcast: numberOrZero(broadcastStatsLast.maxSnapshotAgeMsAtBroadcast),
      lastPayloadBytes: numberOrZero(broadcastStatsLast.lastPayloadBytes),
      maxPayloadBytes: numberOrZero(broadcastStatsLast.maxPayloadBytes)
    },
    websocket: {
      sendTimeoutMs: nullableNumber(last.websocketSendTimeoutMs),
      sendDelta: websocketSendDelta,
      sendMeasuredHz: rate(websocketSendDelta, elapsedSeconds),
      timeoutDelta: websocketTimeoutDelta,
      errorDelta: websocketErrorDelta,
      lastSendMs: nullableNumber(broadcastStatsLast.lastWebsocketSendMs),
      maxSendMs: numberOrZero(broadcastStatsLast.maxWebsocketSendMs)
    },
    recommendations: []
  };

  summary.recommendations = buildRecommendations(summary);
  return summary;
}

function printSummary(summary) {
  console.log("Latency diagnostics");
  console.log(`  URL: ${summary.statusUrl}`);
  console.log(`  Samples: ${summary.sampleCount} over ${summary.elapsedSeconds.toFixed(1)}s`);
  console.log("");
  console.log("Server");
  console.log(`  Telemetry running: ${yesNo(summary.server.telemetryRunning)}`);
  console.log(`  Game connected:    ${yesNo(summary.server.gameConnected)}`);
  console.log(`  UDP:               ${summary.server.udpListeningAddress ?? "--"}`);
  console.log(`  HTTP:              ${summary.server.httpListeningAddress ?? "--"}`);
  console.log(`  WebSocket clients: ${summary.server.websocketClients}`);
  console.log("");
  console.log("UDP receive");
  console.log(`  Packets:           ${summary.udp.packetsDelta}`);
  console.log(`  Measured rate:     ${formatNumber(summary.udp.measuredHz, 1)} Hz`);
  console.log(`  EMA rate:          ${formatNumber(summary.udp.estimatedHzLast, 1)} Hz`);
  console.log(`  Last packet age:   ${formatNumber(summary.udp.lastPacketAgeMs, 0)} ms`);
  console.log(`  Max gap:           ${summary.udp.maxPacketGapMs} ms`);
  console.log(`  New warning gaps:  ${summary.udp.packetGapDelta}`);
  console.log(`  Gap histogram:     ${formatHistogram(summary.udp.packetGapHistogramDelta)}`);
  console.log(`  Recent gaps:       ${formatRecentGaps(summary.udp.recentPacketGaps)}`);
  console.log("");
  console.log("Broadcast");
  console.log(`  Configured:        ${formatBroadcastSetting(summary.broadcast.configuredHz)}`);
  console.log(`  Transport:         ${summary.broadcast.transportMode}`);
  console.log(`  Dashboard render:  ${formatNumber(summary.broadcast.dashboardRenderHz, 0)} Hz`);
  console.log(`  Measured rate:     ${formatNumber(summary.broadcast.measuredHz, 1)} Hz`);
  console.log(`  EMA rate:          ${formatNumber(summary.broadcast.estimatedHzLast, 1)} Hz`);
  console.log(`  Requests:          ${summary.broadcast.requestsDelta}`);
  console.log(`  Frames:            ${summary.broadcast.framesDelta}`);
  console.log(`  Coalesced:         ${summary.broadcast.coalescedDelta}`);
  console.log(`  Snapshot age:      ${formatNumber(summary.broadcast.lastSnapshotAgeMsAtBroadcast, 0)} ms`);
  console.log(`  Snapshot age max:  ${summary.broadcast.maxSnapshotAgeMsAtBroadcast} ms`);
  console.log(`  Payload:           ${summary.broadcast.lastPayloadBytes} bytes`);
  console.log("");
  console.log("WebSocket send");
  console.log(`  Timeout setting:   ${formatNumber(summary.websocket.sendTimeoutMs, 0)} ms`);
  console.log(`  Sends:             ${summary.websocket.sendDelta}`);
  console.log(`  Measured rate:     ${formatNumber(summary.websocket.sendMeasuredHz, 1)} Hz`);
  console.log(`  Timeouts:          ${summary.websocket.timeoutDelta}`);
  console.log(`  Errors:            ${summary.websocket.errorDelta}`);
  console.log(`  Last send:         ${formatNumber(summary.websocket.lastSendMs, 3)} ms`);
  console.log(`  Max send:          ${formatNumber(summary.websocket.maxSendMs, 3)} ms`);
  console.log("");
  console.log("Recommendations");
  for (const recommendation of summary.recommendations) {
    console.log(`  - ${recommendation}`);
  }
}

function buildRecommendations(summary) {
  const recommendations = [];

  if (!summary.server.telemetryRunning) {
    recommendations.push("Telemetry runtime is stopped. Start it before measuring latency.");
  }
  if (!summary.server.gameConnected) {
    recommendations.push("No recent UDP packets. Confirm FH6 Data Out target IP/port and UDP listen port.");
  }
  if (summary.udp.packetGapDelta > 0) {
    recommendations.push("Warning-level UDP gaps occurred during this run. Check recent gaps and CPU/GPU load.");
  }
  if (summary.udp.packetGapHistogramDelta.gt250Ms > 0) {
    recommendations.push("UDP gaps above 250ms occurred. This is likely scheduling, sender stall, or network loss.");
  }
  if (summary.broadcast.maxSnapshotAgeMsAtBroadcast > 10) {
    recommendations.push("Snapshot age at broadcast exceeded 10ms. Inspect broadcaster/send path next.");
  }
  if (summary.websocket.timeoutDelta > 0 || summary.websocket.errorDelta > 0) {
    recommendations.push("WebSocket sends timed out or failed. Check tablet Wi-Fi, browser backgrounding, or client count.");
  }
  if (
    summary.server.gameConnected &&
    summary.broadcast.requestsDelta > 0 &&
    summary.broadcast.configuredHz != null &&
    summary.broadcast.measuredHz < summary.broadcast.configuredHz * 0.85
  ) {
    recommendations.push("Broadcast rate is materially below target. Check WebSocket send time and server CPU load.");
  }
  if (summary.broadcast.coalescedDelta > 0 && summary.udp.packetGapDelta === 0) {
    recommendations.push("Coalescing is expected: UDP input is faster than WebSocket broadcast cap, but latest state stays fresh.");
  }
  if (recommendations.length === 0) {
    recommendations.push("No server-side latency or packet loss issue was visible in this sample.");
  }

  return recommendations;
}

function diffHistogram(first = {}, last = {}) {
  return {
    le8Ms: delta(first.le8Ms, last.le8Ms),
    le16Ms: delta(first.le16Ms, last.le16Ms),
    le33Ms: delta(first.le33Ms, last.le33Ms),
    le50Ms: delta(first.le50Ms, last.le50Ms),
    le100Ms: delta(first.le100Ms, last.le100Ms),
    le250Ms: delta(first.le250Ms, last.le250Ms),
    gt250Ms: delta(first.gt250Ms, last.gt250Ms)
  };
}

function formatHistogram(histogram) {
  return [
    `<=8:${histogram.le8Ms}`,
    `<=16:${histogram.le16Ms}`,
    `<=33:${histogram.le33Ms}`,
    `<=50:${histogram.le50Ms}`,
    `<=100:${histogram.le100Ms}`,
    `<=250:${histogram.le250Ms}`,
    `>250:${histogram.gt250Ms}`
  ].join(" ");
}

function formatRecentGaps(gaps) {
  if (!gaps || gaps.length === 0) {
    return "None";
  }
  return gaps.map((gap) => `${gap.gapMs}ms @ ${new Date(gap.at).toLocaleTimeString()}`).join(" | ");
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const next = rawArgs[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function delta(first, last) {
  return Math.max(0, numberOrZero(last) - numberOrZero(first));
}

function rate(count, seconds) {
  return seconds > 0 ? count / seconds : 0;
}

function nullableNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function numberOrZero(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function formatNumber(value, fractionDigits) {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return value.toFixed(fractionDigits);
}

function formatBroadcastSetting(value) {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return value === 0 ? "Uncapped" : `${value.toFixed(1)} Hz`;
}

function yesNo(value) {
  return value ? "Yes" : "No";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
