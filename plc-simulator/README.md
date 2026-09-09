# S7 PLC simulator (Pi #1, no-wiring mode)

Runs on the Pi standing in for a real machine in the S7 mode of the 3-Pi
test rig — see `../docs/pi-test-rig-s7-mode.md` for the full setup. This
folder is just the one script that Pi needs; no physical wiring involved.

## Install

```bash
pip install python-snap7 --break-system-packages
```

`python-snap7` 3.x is pure Python — no native library, no apt package, no
build step. The same one line works on any Linux, ARM included.

## Run

```bash
python3 plc_simulator.py
```

Leave it running (Ctrl+C to stop cleanly). To have it start automatically
on boot, copy `plc-simulator.service` to `/etc/systemd/system/`, adjust the
`ExecStart` path and `User` if your username isn't `pi`, then:

```bash
sudo cp plc-simulator.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now plc-simulator
journalctl -u plc-simulator -f   # watch its logs
```

Port 102 (the real S7comm port) needs root to bind on Linux — the unit
file below runs as root for that reason. If you'd rather not, set
`TCP_PORT=1102` in the unit's `Environment=` lines (and match `PLC_PORT` on
Pi #2) and drop back to a normal user.
