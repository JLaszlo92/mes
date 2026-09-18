// Eljátssza "a gépet" Modbus TCP-n keresztül — mostantól egy valós idejű
// vezérlő webfelülettel is, hogy tesztelés közben ne kelljen a véletlenre
// bízni, mikor áll le vagy indul újra a szimulált gép.
const ModbusRTU = require("modbus-serial");
const http = require("node:http");

const MODBUS_PORT = parseInt(process.env.MODBUS_PORT || "5020", 10);
const CONTROL_PORT = parseInt(process.env.CONTROL_PORT || "5021", 10);

// Holding regiszter térkép (mind uint16):
//   0: GoodCount
//   1: ScrapCount
//   2: Status kód — 0=idle, 1=running, 2=down, 3=changeover
const STATUS_CODES = { idle: 0, running: 1, down: 2, changeover: 3 };

// Ezek most már futásidőben, a vezérlő UI-n keresztül állíthatók — az
// env változók csak a kezdeti alapértéket adják.
const state = {
  cycleMs: parseInt(process.env.CYCLE_MS || "2000", 10),
  scrapRate: parseFloat(process.env.SCRAP_RATE || "0.08"),
  avgSecondsBetweenStops: parseFloat(process.env.AVG_SECONDS_BETWEEN_STOPS || "180"),
  avgStopDurationSeconds: parseFloat(process.env.AVG_STOP_DURATION_SECONDS || "10"),
  goodCount: 0,
  scrapCount: 0,
  status: "running",
};

const holdingRegisters = new Uint16Array(3);

function syncRegisters() {
  holdingRegisters[0] = state.goodCount & 0xffff;
  holdingRegisters[1] = state.scrapCount & 0xffff;
  holdingRegisters[2] = STATUS_CODES[state.status];
}
syncRegisters();

const vector = {
  getHoldingRegister: (addr) => holdingRegisters[addr] ?? 0,
  setRegister: () => {
    // Csak olvasható szimulátor.
  },
};

const modbusServer = new ModbusRTU.ServerTCP(vector, { host: "0.0.0.0", port: MODBUS_PORT });
modbusServer.on("initialized", () => {
  console.log(`Modbus TCP simulator listening on port ${MODBUS_PORT}`);
});
modbusServer.on("error", (err) => console.error("Modbus server error", err));

let cycleTimer = null;
function scheduleCycle() {
  if (cycleTimer) clearInterval(cycleTimer);
  cycleTimer = setInterval(runCycle, state.cycleMs);
}

function runCycle() {
  // A leállás/visszaállás ciklusonkénti valószínűsége az átlagos
  // időtartamokból van levezetve: p = ciklusidő / átlagos_időtartam
  // (geometriai eloszlás közelítése — annál pontosabb, minél rövidebb a
  // ciklusidő az átlagos időtartamhoz képest).
  if (state.status === "running") {
    if (Math.random() < state.scrapRate) state.scrapCount += 1;
    else state.goodCount += 1;

    const downProbability = state.cycleMs / (state.avgSecondsBetweenStops * 1000);
    if (Math.random() < downProbability) state.status = "down";
  } else if (state.status === "down") {
    const recoveryProbability = state.cycleMs / (state.avgStopDurationSeconds * 1000);
    if (Math.random() < recoveryProbability) state.status = "running";
  }
  syncRegisters();
}

scheduleCycle();

// --- Vezérlő webfelület ---

const CONTROL_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Modbus simulator control</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; }
  label { display: block; margin-top: 12px; font-size: 13px; color: #555; }
  input { width: 100%; padding: 6px; box-sizing: border-box; margin-top: 2px; }
  button { margin-top: 16px; margin-right: 8px; padding: 8px 14px; cursor: pointer; }
  #status { font-weight: 600; font-size: 18px; margin-top: 16px; }
  .running { color: #0ca30c; }
  .down { color: #d03b3b; }
</style></head>
<body>
  <h1>Modbus simulator control</h1>
  <div id="status">—</div>
  <div>Good: <span id="good">—</span> · Scrap: <span id="scrap">—</span></div>

  <label>Cycle time (ms)<input id="cycleMs" type="number"></label>
  <label>Scrap rate (0–1)<input id="scrapRate" type="number" step="0.01"></label>
  <label>Avg. seconds between stops<input id="avgSecondsBetweenStops" type="number"></label>
  <label>Avg. stop duration (seconds)<input id="avgStopDurationSeconds" type="number"></label>
  <button onclick="saveConfig()">Save</button>

  <div>
    <button onclick="control('force_down')">Force down now</button>
    <button onclick="control('force_running')">Force running now</button>
    <button onclick="control('reset_counters')">Reset counters</button>
  </div>

<script>
async function refresh() {
  const res = await fetch('/api/state');
  const s = await res.json();
  document.getElementById('status').textContent = s.status;
  document.getElementById('status').className = s.status;
  document.getElementById('good').textContent = s.goodCount;
  document.getElementById('scrap').textContent = s.scrapCount;
  document.getElementById('cycleMs').value = s.cycleMs;
  document.getElementById('scrapRate').value = s.scrapRate;
  document.getElementById('avgSecondsBetweenStops').value = s.avgSecondsBetweenStops;
  document.getElementById('avgStopDurationSeconds').value = s.avgStopDurationSeconds;
}
async function saveConfig() {
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cycleMs: Number(document.getElementById('cycleMs').value),
      scrapRate: Number(document.getElementById('scrapRate').value),
      avgSecondsBetweenStops: Number(document.getElementById('avgSecondsBetweenStops').value),
      avgStopDurationSeconds: Number(document.getElementById('avgStopDurationSeconds').value),
    }),
  });
  refresh();
}
async function control(action) {
  await fetch('/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  refresh();
}
setInterval(refresh, 2000);
refresh();
</script>
</body></html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });
}

const controlServer = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(CONTROL_PAGE);
    return;
  }

  if (req.method === "GET" && req.url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
    return;
  }

  if (req.method === "POST" && req.url === "/api/config") {
    const body = await readBody(req);
    if (typeof body.cycleMs === "number") {
      state.cycleMs = body.cycleMs;
      scheduleCycle();
    }
    if (typeof body.scrapRate === "number") state.scrapRate = body.scrapRate;
    if (typeof body.avgSecondsBetweenStops === "number") state.avgSecondsBetweenStops = body.avgSecondsBetweenStops;
    if (typeof body.avgStopDurationSeconds === "number") state.avgStopDurationSeconds = body.avgStopDurationSeconds;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
    return;
  }

  if (req.method === "POST" && req.url === "/api/control") {
    const body = await readBody(req);
    if (body.action === "force_down") state.status = "down";
    else if (body.action === "force_running") state.status = "running";
    else if (body.action === "reset_counters") {
      state.goodCount = 0;
      state.scrapCount = 0;
    }
    syncRegisters();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
    return;
  }

  res.writeHead(404);
  res.end();
});

controlServer.listen(CONTROL_PORT, "0.0.0.0", () => {
  console.log(`Control UI listening on http://0.0.0.0:${CONTROL_PORT}`);
});