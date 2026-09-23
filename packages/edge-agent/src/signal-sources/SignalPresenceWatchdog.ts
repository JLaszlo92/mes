import type { SignalReading, SignalSource } from "./SignalSource.js";

/**
 * Burkoló bármelyik SignalSource köré: "signal_presence" módban a gép
 * státuszát kizárólag a production_count jelek jelenléte/hiánya alapján
 * határozza meg, a belső jelforrás saját státusz-jelentését figyelmen
 * kívül hagyva. Ha X másodpercig (noSignalTimeoutMs) nem érkezik
 * darabszám-jel, "down"-ra vált; az első újra érkező jelnél "running"-ra.
 *
 * Fontos architekturális döntés: ez a döntés teljesen HELYBEN, hálózat-
 * függetlenül történik — ugyanúgy, ahogy a Modbus/OPC-UA/S7 jelforrások
 * is helyben döntik el, hogy elvesztették-e a gép-kapcsolatot. A keletkező
 * esemény utána ugyanazon a már bizonyítottan megbízható, pufferelt/
 * újrapróbálkozós MQTT-csatornán megy tovább, mint minden más — egy
 * hálózati akadozás emiatt sosem okozhat hamis "down" jelzést.
 */
export class SignalPresenceWatchdog implements SignalSource {
  readonly name: string;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentlyDown = false;

  constructor(
    private readonly inner: SignalSource,
    private readonly noSignalTimeoutMs: number,
  ) {
    this.name = inner.name;
  }

    start(onReading: (reading: SignalReading) => void): void {
    const armTimer = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (!this.currentlyDown) {
          this.currentlyDown = true;
          onReading({ kind: "machine_status", status: "down" });
        }
      }, this.noSignalTimeoutMs);
    };

    this.inner.start((reading) => {
      if (reading.kind !== "production_count") return;

      if (this.currentlyDown) {
        this.currentlyDown = false;
        onReading({ kind: "machine_status", status: "running" });
      }
      onReading(reading);
      armTimer();
    });

    this.currentlyDown = true;
    onReading({ kind: "machine_status", status: "down" });
    armTimer();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.inner.stop();
  }
}