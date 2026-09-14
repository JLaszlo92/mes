#!/usr/bin/env python3
"""
Simulates a Siemens S7 PLC's outputs using python-snap7's server role, so
Pi #2's edge agent (via edge-agent/python/s7_bridge.py) can exercise the S7
protocol path over a real S7comm network connection with zero physical
wiring. See docs/pi-test-rig-s7-mode.md — this is meant as the easy first
pass; the GPIO rig in docs/pi-test-rig.md is the physical-wiring follow-up
once this path works end to end.

python-snap7 3.x is pure Python (no libsnap7 C library / apt package
needed) — `pip install python-snap7` is the whole install, on any platform
including a Raspberry Pi's ARM Linux. That's a meaningfully simpler
dependency than the old ctypes-wrapping snap7 bindings, and is why this
mode was worth adding as the "no wiring" first pass: it's genuinely less
setup than the GPIO rig, not just less physical work.

Data layout (DB1) — must match edge-agent/python/s7_bridge.py:
  byte 0, bit 0 : Running     (BOOL)  1 = running, 0 = down
  bytes 4-7     : GoodCount   (DINT)  cumulative good parts
  bytes 8-11    : ScrapCount  (DINT)  cumulative scrap parts
The counters only ever increase, mirroring how a real PLC's production
counters behave — s7_bridge.py is the piece that turns "counter went up by
N" into N discrete production_count events, the same way a real OPC-UA or
Modbus adapter will have to.

Web control panel (added for deep pipeline testing, does NOT change the S7
wire format above — s7_bridge.py needs zero changes):
  http://<node-sim>:8080/  (WEB_PORT env var to change the port)
Lets you tune the simulation live — average time between parts, good/scrap
ratio, how often/how long the machine "stops" — reset the counters, force
a fault, fire a burst of parts to stress-test throughput, and simulate a
dropped S7 connection to exercise s7_bridge.py's reconnect logic
independently of the MQTT-outage drill (see DEVELOPMENT_STATUS.md).
Everything set through the panel is in-memory only: a restart of this
service goes back to the environment-variable defaults below.
"""
import collections
import os
import random
import threading
import time

from flask import Flask, jsonify, request

AVG_CYCLE_SECONDS = float(os.environ.get("AVG_CYCLE_SECONDS", 3.0))
SCRAP_RATE = float(os.environ.get("SCRAP_RATE", 0.08))
AVG_UPTIME_SECONDS = float(os.environ.get("AVG_UPTIME_SECONDS", 60.0))
DOWNTIME_SECONDS = float(os.environ.get("DOWNTIME_SECONDS", 10.0))
DB_NUMBER = int(os.environ.get("DB_NUMBER", 1))
DB_SIZE = int(os.environ.get("DB_SIZE", 16))
TCP_PORT = int(os.environ.get("TCP_PORT", 102))
WEB_PORT = int(os.environ.get("WEB_PORT", 8080))

TICK_SECONDS = 0.2          # how often the background loops re-check config/overrides
MIN_CYCLE_SECONDS = 0.02    # floor for avg_cycle_seconds / burst cycle, protects the CPU/network
MAX_EVENT_LOG = 50


def encode_state(buffer: bytearray, running: bool, good: int, scrap: int) -> None:
    """Pure, testable: writes the three values into the DB buffer at their
    documented offsets. No snap7 server/network dependency — this is what
    tests/test_plc_simulator.py exercises directly with a plain bytearray."""
    from snap7.util import set_bool, set_dint

    set_bool(buffer, 0, 0, running)
    set_dint(buffer, 4, good)
    set_dint(buffer, 8, scrap)


class SimulatorState:
    """Everything the web panel can read or change, guarded by one lock.
    Kept deliberately simple (a lock + plain attributes) rather than pulling
    in a bigger framework — this is a test tool, not production code."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.good = 0
        self.scrap = 0
        self.running = True

        # Live-tunable generation parameters (web panel writes these).
        self.avg_cycle_seconds = AVG_CYCLE_SECONDS
        self.scrap_rate = SCRAP_RATE
        self.avg_uptime_seconds = AVG_UPTIME_SECONDS
        self.downtime_seconds = DOWNTIME_SECONDS

        # Manual fault override — while True, the automatic uptime/downtime
        # cycle backs off and lets the manual state stand.
        self.manual_fault = False

        # Burst mode: for a short window, use burst_cycle_seconds instead of
        # avg_cycle_seconds. burst_until is a time.monotonic() deadline.
        self.burst_until = 0.0
        self.burst_cycle_seconds = AVG_CYCLE_SECONDS

        # Simulated S7 link state, toggled by the "simulate disconnect" action.
        self.plc_connected = True

        # Rolling human-readable event log, newest first.
        self.events: collections.deque = collections.deque(maxlen=MAX_EVENT_LOG)

    def log(self, message: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self.events.appendleft(f"{stamp}  {message}")

    def burst_active(self) -> bool:
        return time.monotonic() < self.burst_until

    def current_cycle_seconds(self) -> float:
        if self.burst_active():
            return self.burst_cycle_seconds
        return self.avg_cycle_seconds

    def snapshot(self) -> dict:
        with self.lock:
            burst_remaining = max(0.0, self.burst_until - time.monotonic())
            return {
                "good": self.good,
                "scrap": self.scrap,
                "running": self.running,
                "plc_connected": self.plc_connected,
                "manual_fault": self.manual_fault,
                "avg_cycle_seconds": self.avg_cycle_seconds,
                "scrap_rate": self.scrap_rate,
                "avg_uptime_seconds": self.avg_uptime_seconds,
                "downtime_seconds": self.downtime_seconds,
                "burst_active": burst_remaining > 0,
                "burst_remaining_seconds": round(burst_remaining, 1),
                "burst_cycle_seconds": self.burst_cycle_seconds,
                "events": list(self.events),
            }


def sample_interval(seconds: float) -> float:
    seconds = max(MIN_CYCLE_SECONDS, seconds)
    return max(MIN_CYCLE_SECONDS, random.expovariate(1 / seconds))


def part_cycle_loop(buffer: bytearray, state: SimulatorState, stop: threading.Event) -> None:
    """Mirrors virtual_machine.py's timing model (jittered inter-arrival
    time, a scrap rate) so behavior is comparable whether you're running
    the GPIO rig or this S7 rig — only the wire format downstream differs.
    Re-reads state.avg_cycle_seconds / scrap_rate / burst status every tick
    so changes made through the web panel take effect on the next part,
    not just after a restart."""
    next_part_at = time.monotonic() + sample_interval(state.current_cycle_seconds())
    while not stop.is_set():
        time.sleep(TICK_SECONDS)
        if stop.is_set():
            return
        now = time.monotonic()
        if now < next_part_at:
            continue
        with state.lock:
            cycle_seconds = state.current_cycle_seconds()
        next_part_at = now + sample_interval(cycle_seconds)

        with state.lock:
            if not state.running:
                continue
            if random.random() < state.scrap_rate:
                state.scrap += 1
                kind = "scrap"
            else:
                state.good += 1
                kind = "good"
            good, scrap, running = state.good, state.scrap, state.running
            state.log(f"part produced: {kind}  (good={good}, scrap={scrap})")
        encode_state(buffer, running, good, scrap)


def downtime_cycle_loop(buffer: bytearray, state: SimulatorState, stop: threading.Event) -> None:
    """Automatic unplanned-stop cycle. Backs off entirely while a manual
    fault (triggered from the web panel) is active, and resumes a fresh
    uptime countdown once the manual fault clears — so the two controls
    don't fight each other."""
    next_stop_at = time.monotonic() + sample_interval(AVG_UPTIME_SECONDS)
    while not stop.is_set():
        time.sleep(TICK_SECONDS)
        if stop.is_set():
            return

        with state.lock:
            manual = state.manual_fault
            uptime_seconds = state.avg_uptime_seconds
        if manual:
            # Manual override owns `running` right now; keep resetting the
            # schedule so automatic stop doesn't fire the instant it clears.
            next_stop_at = time.monotonic() + sample_interval(uptime_seconds)
            continue

        if time.monotonic() < next_stop_at:
            continue

        with state.lock:
            state.running = False
            good, scrap = state.good, state.scrap
            state.log("automatic stop begins")
        encode_state(buffer, False, good, scrap)

        with state.lock:
            downtime_seconds = state.downtime_seconds
        waited = 0.0
        while waited < downtime_seconds and not stop.is_set():
            with state.lock:
                if state.manual_fault:
                    break  # manual control took over mid-stop; let it own things
            time.sleep(TICK_SECONDS)
            waited += TICK_SECONDS

        with state.lock:
            if not state.manual_fault:
                state.running = True
                good, scrap = state.good, state.scrap
                state.log("automatic stop ends, resuming")
                encode_state(buffer, True, good, scrap)
            next_stop_at = time.monotonic() + sample_interval(state.avg_uptime_seconds)


def simulate_plc_disconnect(server, state: SimulatorState, duration_seconds: float) -> None:
    """Stops the S7 server's listener for `duration_seconds`, then starts it
    again — a deliberately different fault mode from the Mosquitto-outage
    drill: this breaks the PLC-facing link, so it exercises s7_bridge.py's
    own reconnect logic rather than the MQTT layer. Runs in a background
    thread so the HTTP request that triggers it returns immediately."""
    with state.lock:
        state.plc_connected = False
        state.log(f"simulated PLC disconnect: stopping S7 server for {duration_seconds:.0f}s")
    try:
        server.stop()
    except Exception as exc:  # pragma: no cover - defensive, surfaced in the UI log
        state.log(f"error stopping S7 server: {exc}")

    time.sleep(duration_seconds)

    try:
        server.start(tcp_port=TCP_PORT)
        with state.lock:
            state.plc_connected = True
            state.log("S7 server listening again")
    except Exception as exc:  # pragma: no cover
        with state.lock:
            state.log(f"error restarting S7 server: {exc}")


def build_app(buffer: bytearray, state: SimulatorState, server) -> Flask:
    app = Flask(__name__)

    @app.get("/")
    def index():
        return INDEX_HTML

    @app.get("/api/state")
    def get_state():
        return jsonify(state.snapshot())

    @app.post("/api/config")
    def post_config():
        body = request.get_json(silent=True) or {}
        errors = []

        def parse(name, lo, hi):
            if name not in body:
                return None
            try:
                value = float(body[name])
            except (TypeError, ValueError):
                errors.append(f"{name} must be a number")
                return None
            if not (lo <= value <= hi):
                errors.append(f"{name} must be between {lo} and {hi}")
                return None
            return value

        avg_cycle = parse("avg_cycle_seconds", MIN_CYCLE_SECONDS, 3600)
        scrap_rate = parse("scrap_rate", 0.0, 1.0)
        avg_uptime = parse("avg_uptime_seconds", 1.0, 24 * 3600)
        downtime = parse("downtime_seconds", 0.0, 3600)

        if errors:
            return jsonify({"ok": False, "errors": errors}), 400

        with state.lock:
            changed = []
            if avg_cycle is not None:
                state.avg_cycle_seconds = avg_cycle
                changed.append(f"avg_cycle_seconds={avg_cycle:g}s")
            if scrap_rate is not None:
                state.scrap_rate = scrap_rate
                changed.append(f"scrap_rate={scrap_rate:.0%}")
            if avg_uptime is not None:
                state.avg_uptime_seconds = avg_uptime
                changed.append(f"avg_uptime_seconds={avg_uptime:g}s")
            if downtime is not None:
                state.downtime_seconds = downtime
                changed.append(f"downtime_seconds={downtime:g}s")
            if changed:
                state.log("config updated via web panel: " + ", ".join(changed))
        return jsonify({"ok": True, "state": state.snapshot()})

    @app.post("/api/reset")
    def post_reset():
        with state.lock:
            state.good = 0
            state.scrap = 0
            running = state.running
            state.log("counters reset via web panel")
        encode_state(buffer, running, 0, 0)
        return jsonify({"ok": True, "state": state.snapshot()})

    @app.post("/api/fault")
    def post_fault():
        body = request.get_json(silent=True) or {}
        action = body.get("action")
        if action not in ("trigger", "clear"):
            return jsonify({"ok": False, "errors": ["action must be 'trigger' or 'clear'"]}), 400

        if action == "trigger":
            with state.lock:
                state.manual_fault = True
                state.running = False
                good, scrap = state.good, state.scrap
                state.log("manual fault triggered via web panel")
            encode_state(buffer, False, good, scrap)
        else:
            with state.lock:
                state.manual_fault = False
                state.running = True
                good, scrap = state.good, state.scrap
                state.log("manual fault cleared via web panel")
            encode_state(buffer, True, good, scrap)
        return jsonify({"ok": True, "state": state.snapshot()})

    @app.post("/api/burst")
    def post_burst():
        body = request.get_json(silent=True) or {}
        try:
            duration_seconds = float(body.get("duration_seconds", 30))
            cycle_seconds = float(body.get("cycle_seconds", 0.2))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "errors": ["duration_seconds and cycle_seconds must be numbers"]}), 400

        if not (1 <= duration_seconds <= 3600):
            return jsonify({"ok": False, "errors": ["duration_seconds must be between 1 and 3600"]}), 400
        if not (MIN_CYCLE_SECONDS <= cycle_seconds <= 60):
            return jsonify({"ok": False, "errors": [f"cycle_seconds must be between {MIN_CYCLE_SECONDS} and 60"]}), 400

        with state.lock:
            state.burst_until = time.monotonic() + duration_seconds
            state.burst_cycle_seconds = cycle_seconds
            state.log(f"burst mode: ~{cycle_seconds:g}s/part for {duration_seconds:g}s")
        return jsonify({"ok": True, "state": state.snapshot()})

    @app.post("/api/plc-disconnect")
    def post_plc_disconnect():
        body = request.get_json(silent=True) or {}
        try:
            duration_seconds = float(body.get("duration_seconds", 20))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "errors": ["duration_seconds must be a number"]}), 400
        if not (1 <= duration_seconds <= 600):
            return jsonify({"ok": False, "errors": ["duration_seconds must be between 1 and 600"]}), 400

        with state.lock:
            already_down = not state.plc_connected
        if already_down:
            return jsonify({"ok": False, "errors": ["a simulated disconnect is already in progress"]}), 409

        threading.Thread(
            target=simulate_plc_disconnect, args=(server, state, duration_seconds), daemon=True
        ).start()
        return jsonify({"ok": True, "state": state.snapshot()})

    return app


INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>node-sim — S7 PLC simulator control panel</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --border: #262b36;
    --text: #e6e8ec; --muted: #8a90a0;
    --good: #35c46a; --bad: #e5484d; --accent: #4c8dff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 24px;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 18px;
  }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 14px; }
  .stat-row { display: flex; gap: 24px; margin-bottom: 8px; }
  .stat { flex: 1; }
  .stat .value { font-size: 28px; font-weight: 600; }
  .stat .label { color: var(--muted); font-size: 12px; }
  .status-pill {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
    border-radius: 999px; font-size: 12px; font-weight: 600;
  }
  .status-pill.running { background: rgba(53,196,106,.15); color: var(--good); }
  .status-pill.down { background: rgba(229,72,77,.15); color: var(--bad); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  label { display: block; margin: 12px 0 4px; color: var(--muted); font-size: 12px; }
  input[type=number] {
    width: 100%; background: #0c0e12; border: 1px solid var(--border); color: var(--text);
    border-radius: 6px; padding: 8px 10px; font-size: 14px;
  }
  button {
    background: var(--accent); color: #fff; border: none; border-radius: 6px;
    padding: 9px 14px; font-size: 13px; font-weight: 600; cursor: pointer; margin-top: 12px;
  }
  button.secondary { background: #2a2f3a; }
  button.danger { background: var(--bad); }
  button:hover { filter: brightness(1.1); }
  button:disabled { opacity: .5; cursor: default; }
  .row { display: flex; gap: 10px; }
  .row > * { flex: 1; }
  .hint { color: var(--muted); font-size: 12px; margin-top: 6px; }
  .log {
    height: 260px; overflow-y: auto; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #0c0e12; border: 1px solid var(--border); border-radius: 6px; padding: 10px;
  }
  .log div { color: var(--muted); }
  .msg { min-height: 18px; font-size: 12px; margin-top: 8px; }
  .msg.error { color: var(--bad); }
  .msg.ok { color: var(--good); }
</style>
</head>
<body>
  <h1>node-sim — S7 PLC simulator control panel</h1>
  <div class="sub">Live-tunes the simulated machine that s7_bridge.py polls. Changes here don't touch the S7 register layout — the edge agent needs no changes.</div>

  <div class="grid">
    <div class="card">
      <h2>Machine state</h2>
      <div class="stat-row">
        <div class="stat"><div class="value" id="good">–</div><div class="label">Good parts</div></div>
        <div class="stat"><div class="value" id="scrap">–</div><div class="label">Scrap parts</div></div>
        <div class="stat"><div class="value" id="yield">–</div><div class="label">Yield</div></div>
      </div>
      <div id="status-pill" class="status-pill running"><span class="dot"></span><span id="status-text">…</span></div>
      <div>
        <button class="secondary" onclick="resetCounters()">Reset counters</button>
      </div>
    </div>

    <div class="card">
      <h2>Generation parameters</h2>
      <label>Average seconds between parts (<span id="rate-hint"></span>)</label>
      <input type="number" id="avg_cycle_seconds" min="0.02" step="0.1">
      <label>Scrap rate (%)</label>
      <input type="number" id="scrap_rate_pct" min="0" max="100" step="1">
      <label>Average uptime between stops (s)</label>
      <input type="number" id="avg_uptime_seconds" min="1" step="1">
      <label>Stop duration (s)</label>
      <input type="number" id="downtime_seconds" min="0" step="1">
      <button onclick="saveConfig()">Apply</button>
      <div class="msg" id="config-msg"></div>
    </div>

    <div class="card">
      <h2>Fault injection</h2>
      <div class="hint">Forces the machine down/up immediately, independent of the automatic stop cycle above.</div>
      <div class="row">
        <button class="danger" onclick="setFault('trigger')" id="fault-trigger">Trigger fault now</button>
        <button class="secondary" onclick="setFault('clear')" id="fault-clear">Clear fault</button>
      </div>
    </div>

    <div class="card">
      <h2>Burst mode</h2>
      <div class="hint">Temporarily floods parts at a fixed cycle time to stress-test the pipeline's throughput.</div>
      <label>Duration (s)</label>
      <input type="number" id="burst_duration" value="30" min="1" max="3600">
      <label>Cycle time during burst (s/part)</label>
      <input type="number" id="burst_cycle" value="0.1" min="0.02" max="60" step="0.05">
      <button onclick="startBurst()">Start burst</button>
      <div class="hint" id="burst-status"></div>
    </div>

    <div class="card">
      <h2>Simulated PLC disconnect</h2>
      <div class="hint">Stops the S7 TCP listener itself (separate from the Mosquitto-outage drill) — tests s7_bridge.py's own reconnect logic.</div>
      <label>Duration (s)</label>
      <input type="number" id="disconnect_duration" value="20" min="1" max="600">
      <button class="danger" onclick="disconnectPlc()" id="disconnect-btn">Disconnect S7 server</button>
      <div class="msg" id="disconnect-msg"></div>
    </div>

    <div class="card">
      <h2>Event log</h2>
      <div class="log" id="log"></div>
    </div>
  </div>

<script>
let editingConfig = false;

async function refresh() {
  try {
    const res = await fetch('/api/state');
    const s = await res.json();
    document.getElementById('good').textContent = s.good;
    document.getElementById('scrap').textContent = s.scrap;
    const total = s.good + s.scrap;
    document.getElementById('yield').textContent = total ? ((s.good / total) * 100).toFixed(1) + '%' : '–';

    const pill = document.getElementById('status-pill');
    const text = document.getElementById('status-text');
    if (s.running) {
      pill.className = 'status-pill running';
      text.textContent = s.plc_connected ? 'Running' : 'Running (S7 link down)';
    } else {
      pill.className = 'status-pill down';
      text.textContent = s.manual_fault ? 'Down (manual fault)' : 'Down';
    }

    document.getElementById('fault-trigger').disabled = s.manual_fault;
    document.getElementById('fault-clear').disabled = !s.manual_fault;
    document.getElementById('disconnect-btn').disabled = !s.plc_connected;

    document.getElementById('burst-status').textContent = s.burst_active
      ? `Burst active — ${s.burst_remaining_seconds}s remaining at ~${s.burst_cycle_seconds}s/part`
      : '';

    if (!editingConfig) {
      document.getElementById('avg_cycle_seconds').value = s.avg_cycle_seconds;
      document.getElementById('scrap_rate_pct').value = Math.round(s.scrap_rate * 100);
      document.getElementById('avg_uptime_seconds').value = s.avg_uptime_seconds;
      document.getElementById('downtime_seconds').value = s.downtime_seconds;
    }
    document.getElementById('rate-hint').textContent =
      (60 / Math.max(s.avg_cycle_seconds, 0.02)).toFixed(1) + ' parts/min avg';

    const log = document.getElementById('log');
    log.innerHTML = s.events.map(e => `<div>${e}</div>`).join('');
  } catch (e) {
    // transient network hiccup while polling — ignore, next tick will retry
  }
}

async function saveConfig() {
  const msg = document.getElementById('config-msg');
  const body = {
    avg_cycle_seconds: parseFloat(document.getElementById('avg_cycle_seconds').value),
    scrap_rate: parseFloat(document.getElementById('scrap_rate_pct').value) / 100,
    avg_uptime_seconds: parseFloat(document.getElementById('avg_uptime_seconds').value),
    downtime_seconds: parseFloat(document.getElementById('downtime_seconds').value),
  };
  const res = await fetch('/api/config', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const data = await res.json();
  msg.className = 'msg ' + (data.ok ? 'ok' : 'error');
  msg.textContent = data.ok ? 'Applied.' : data.errors.join(', ');
  editingConfig = false;
}

async function resetCounters() {
  await fetch('/api/reset', {method: 'POST'});
}

async function setFault(action) {
  await fetch('/api/fault', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action})});
}

async function startBurst() {
  const body = {
    duration_seconds: parseFloat(document.getElementById('burst_duration').value),
    cycle_seconds: parseFloat(document.getElementById('burst_cycle').value),
  };
  await fetch('/api/burst', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
}

async function disconnectPlc() {
  const msg = document.getElementById('disconnect-msg');
  const body = {duration_seconds: parseFloat(document.getElementById('disconnect_duration').value)};
  const res = await fetch('/api/plc-disconnect', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const data = await res.json();
  msg.className = 'msg ' + (data.ok ? 'ok' : 'error');
  msg.textContent = data.ok ? 'Disconnect scheduled.' : data.errors.join(', ');
}

for (const id of ['avg_cycle_seconds', 'scrap_rate_pct', 'avg_uptime_seconds', 'downtime_seconds']) {
  document.getElementById(id).addEventListener('focus', () => editingConfig = true);
}

refresh();
setInterval(refresh, 1000);
</script>
</body>
</html>
"""


def main() -> None:
    import snap7

    buffer = bytearray(DB_SIZE)
    state = SimulatorState()
    encode_state(buffer, True, 0, 0)

    server = snap7.Server()
    server.register_area(snap7.SrvArea.DB, DB_NUMBER, buffer)
    server.start(tcp_port=TCP_PORT)
    print(f"S7 PLC simulator listening on :{TCP_PORT}, DB{DB_NUMBER} ({DB_SIZE} bytes)", flush=True)

    stop = threading.Event()
    threading.Thread(target=part_cycle_loop, args=(buffer, state, stop), daemon=True).start()
    threading.Thread(target=downtime_cycle_loop, args=(buffer, state, stop), daemon=True).start()

    app = build_app(buffer, state, server)
    threading.Thread(
        target=lambda: app.run(host="0.0.0.0", port=WEB_PORT, debug=False, use_reloader=False),
        daemon=True,
    ).start()
    print(f"Control panel listening on :{WEB_PORT}", flush=True)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.stop()
        server.destroy()


if __name__ == "__main__":
    main()
