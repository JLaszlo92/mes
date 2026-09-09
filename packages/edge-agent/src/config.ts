import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export const config = {
  mqttUrl: process.env.MQTT_URL ?? "mqtt://127.0.0.1:1883",
  machineId: process.env.MACHINE_ID ?? "sim-machine-01",
  bufferFilePath: process.env.BUFFER_FILE_PATH ?? "/tmp/mes-edge-agent-buffer.ndjson",

  // "simulated" (default, no hardware/network needed), "s7" (poll a
  // Siemens S7 PLC or its simulator over the network — no wiring, see
  // docs/pi-test-rig-s7-mode.md — the recommended first pass), or "gpio"
  // (the physical 3-Pi rig — see docs/pi-test-rig.md — or a real discrete
  // machine connection later).
  signalSource: (process.env.SIGNAL_SOURCE ?? "simulated") as "simulated" | "gpio" | "s7",

  gpio: {
    pythonPath: process.env.GPIO_PYTHON_PATH ?? "python3",
    scriptPath: process.env.GPIO_BRIDGE_SCRIPT_PATH ?? path.join(__dirname, "..", "python", "gpio_bridge.py"),
    goodPin: optionalEnv("GPIO_GOOD_PIN"),
    scrapPin: optionalEnv("GPIO_SCRAP_PIN"),
    statusPin: optionalEnv("GPIO_STATUS_PIN"),
  },

  s7: {
    pythonPath: process.env.S7_PYTHON_PATH ?? "python3",
    scriptPath: process.env.S7_BRIDGE_SCRIPT_PATH ?? path.join(__dirname, "..", "python", "s7_bridge.py"),
    plcIp: optionalEnv("PLC_IP"),
    plcRack: optionalEnv("PLC_RACK"),
    plcSlot: optionalEnv("PLC_SLOT"),
    plcPort: optionalEnv("PLC_PORT"),
    pollIntervalMs: optionalEnv("POLL_INTERVAL_MS"),
  },
};
