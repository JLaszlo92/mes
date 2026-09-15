// Eljátssza "a gépet" Modbus TCP-n keresztül — ugyanaz a szerep, mint a
// plc_simulator.py (S7) és az opcua_simulator.js. A modbus-serial
// egyszerre érett kliens ÉS szerver ("slave") könyvtár, ezért itt sincs
// szükség külön nyelvű hídra.
const ModbusRTU = require("modbus-serial");

const PORT = parseInt(process.env.MODBUS_PORT || "5020", 10);
const CYCLE_MS = parseInt(process.env.CYCLE_MS || "2000", 10);
const SCRAP_RATE = parseFloat(process.env.SCRAP_RATE || "0.08");

// Holding regiszter térkép (mind uint16):
//   0: GoodCount
//   1: ScrapCount
//   2: Status kód — 0=idle, 1=running, 2=down, 3=changeover
const STATUS_CODES = { idle: 0, running: 1, down: 2, changeover: 3 };

let goodCount = 0;
let scrapCount = 0;
let status = "running";

const holdingRegisters = new Uint16Array(3);

function syncRegisters() {
  holdingRegisters[0] = goodCount & 0xffff;
  holdingRegisters[1] = scrapCount & 0xffff;
  holdingRegisters[2] = STATUS_CODES[status];
}
syncRegisters();

const vector = {
  getHoldingRegister: (addr) => holdingRegisters[addr] ?? 0,
  setRegister: () => {
    // Csak olvasható szimulátor — az írásokat szándékosan figyelmen kívül
    // hagyjuk, ahogy egy valódi PLC sem engedné az MES-nek felülírni a
    // saját számlálóit.
  },
};

const serverTCP = new ModbusRTU.ServerTCP(vector, { host: "0.0.0.0", port: PORT });

serverTCP.on("initialized", () => {
  console.log(`Modbus TCP simulator listening on port ${PORT}`);
  console.log("Holding registers: 0=GoodCount, 1=ScrapCount, 2=Status (0=idle,1=running,2=down,3=changeover)");
});

serverTCP.on("error", (err) => console.error("Modbus server error", err));

setInterval(() => {
  if (status === "running") {
    if (Math.random() < SCRAP_RATE) scrapCount += 1;
    else goodCount += 1;
    if (Math.random() < 0.02) status = "down";
  } else if (Math.random() < 0.3) {
    status = "running";
  }
  syncRegisters();
}, CYCLE_MS);