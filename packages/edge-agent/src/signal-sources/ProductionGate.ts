import type { SignalReading, SignalSource } from "./SignalSource.js";

/**
 * Burkoló bármelyik SignalSource köré: "status_bit" módban dönti el,
 * hogy egy production_count jel átengedésre kerüljön-e, ha a gép éppen
 * "down" státuszban van (a dedikált státusz-bit szerint). Ha
 * acceptProductionWhileDown === false, a "down" állapot alatt érkező
 * darabszám-jelek eldobódnak.
 */
export class ProductionGate implements SignalSource {
  readonly name: string;
  private currentStatus = "running";

  constructor(
    private readonly inner: SignalSource,
    private readonly acceptProductionWhileDown: boolean,
  ) {
    this.name = inner.name;
  }

  start(onReading: (reading: SignalReading) => void): void {
    this.inner.start((reading) => {
      if (reading.kind === "machine_status") {
        this.currentStatus = reading.status;
        onReading(reading);
        return;
      }
      if (this.currentStatus === "down" && !this.acceptProductionWhileDown) {
        return;
      }
      onReading(reading);
    });
  }

  stop(): void {
    this.inner.stop();
  }
}