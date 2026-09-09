// Stands in for gpio_bridge.py in tests, without requiring Python or real
// GPIO hardware to be present. GpioSignalSource.ts only cares that
// *something* is spawned and prints newline-delimited JSON to stdout —
// this fixture exercises exactly that contract, including a couple of
// lines that should be rejected (malformed JSON, an unknown status value)
// so the test can confirm those are dropped rather than crashing anything.
console.log(JSON.stringify({ kind: "machine_status", status: "running" }));
setTimeout(() => console.log(JSON.stringify({ kind: "production_count", result: "good" })), 30);
setTimeout(() => console.log(JSON.stringify({ kind: "production_count", result: "scrap" })), 60);
setTimeout(() => console.log("this is not json"), 80);
setTimeout(() => console.log(JSON.stringify({ kind: "machine_status", status: "bogus_status" })), 100);
setTimeout(() => process.exit(0), 150);
