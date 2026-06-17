import dgram from "node:dgram";
import { ForzaPacketParser } from "../parser/forzaPacketParser.js";
import { TelemetryStore } from "../telemetry/telemetryStore.js";

export type ForzaUdpReceiverOptions = {
  host: string;
  port: number;
  parser: ForzaPacketParser;
  store: TelemetryStore;
};

export function startForzaUdpReceiver(options: ForzaUdpReceiverOptions): dgram.Socket {
  const socket = dgram.createSocket("udp4");

  // UDP receive is intentionally immediate: every packet is parsed as it arrives
  // and only the latest in-memory telemetry snapshot is replaced.
  socket.on("message", (packet, remote) => {
    try {
      const snapshot = options.parser.parse(packet);
      options.store.update(snapshot, options.parser.getLastDiagnostics());
    } catch (error) {
      options.store.setLastPacketInfo({
        length: packet.length,
        format: "parse-error",
        profile: "parse-error",
        dashShift: null,
        accepted: false,
        errors: [error instanceof Error ? error.message : String(error)]
      });
      console.error("[udp] Failed to parse Forza telemetry packet", {
        remote: `${remote.address}:${remote.port}`,
        length: packet.length,
        error
      });
    }
  });

  socket.on("error", (error) => {
    console.error("[udp] Socket error", error);
  });

  socket.bind(options.port, options.host, () => {
    const address = socket.address();
    console.log(`[udp] Listening for Forza Data Out on ${address.address}:${address.port}`);
  });

  return socket;
}
