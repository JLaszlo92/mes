// Eljátssza "a gépet" OPC-UA-n keresztül — ugyanaz a szerep, mint amit a
// plc_simulator.py tölt be S7-nél. A node-opcua egyszerre érett kliens ÉS
// szerver könyvtár, ezért itt nincs szükség külön nyelvű hídra, mint az
// S7-nél a python-snap7 esetében.
const { OPCUAServer, Variant, DataType } = require("node-opcua");

const PORT = parseInt(process.env.OPCUA_PORT || "4334", 10);
const CYCLE_MS = parseInt(process.env.CYCLE_MS || "2000", 10);
const SCRAP_RATE = parseFloat(process.env.SCRAP_RATE || "0.08");

let goodCount = 0;
let scrapCount = 0;
let status = "running";

async function main() {
  const server = new OPCUAServer({
    port: PORT,
    resourcePath: "/mes-simulator",
    alternateHostname: ["192.168.60.143"],
    buildInfo: { productName: "MES OPC-UA Simulator", buildNumber: "1", buildDate: new Date() },
  });

  await server.initialize();
  const addressSpace = server.engine.addressSpace;
  const namespace = addressSpace.getOwnNamespace();

  const device = namespace.addObject({
    organizedBy: addressSpace.rootFolder.objects,
    browseName: "SimulatedMachine",
  });

  namespace.addVariable({
    componentOf: device,
    browseName: "GoodCount",
    nodeId: "s=GoodCount",
    dataType: "Int32",
    value: { get: () => new Variant({ dataType: DataType.Int32, value: goodCount }) },
  });

  namespace.addVariable({
    componentOf: device,
    browseName: "ScrapCount",
    nodeId: "s=ScrapCount",
    dataType: "Int32",
    value: { get: () => new Variant({ dataType: DataType.Int32, value: scrapCount }) },
  });

  namespace.addVariable({
    componentOf: device,
    browseName: "Status",
    nodeId: "s=Status",
    dataType: "String",
    value: { get: () => new Variant({ dataType: DataType.String, value: status }) },
  });

  await server.start();
  console.log(`OPC-UA simulator listening on opc.tcp://0.0.0.0:${PORT}/mes-simulator`);
  console.log("Node IDs: ns=1;s=GoodCount, ns=1;s=ScrapCount, ns=1;s=Status");

  // Ugyanaz a szimulált ciklus-alak, mint a plc_simulator.py-ban: főleg
  // fut, néha leáll, alkalmanként selejt.
  setInterval(() => {
    if (status === "running") {
      if (Math.random() < SCRAP_RATE) scrapCount += 1;
      else goodCount += 1;
      if (Math.random() < 0.02) status = "down";
    } else if (Math.random() < 0.3) {
      status = "running";
    }
  }, CYCLE_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});