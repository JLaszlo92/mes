# Virtual manufacturing machine (Pi #1)

Runs on the Pi standing in for a real machine in the 3-Pi test rig — see
`../docs/pi-test-rig.md` for the full setup, wiring diagram, and pin
mapping. This folder is just the one script that Pi needs.

## Install

```bash
sudo apt update
sudo apt install -y python3-gpiozero
```

## Run

```bash
python3 virtual_machine.py
```

Leave it running (Ctrl+C to stop cleanly — it turns all pins off before
exiting). To have it start automatically on boot, copy
`virtual-machine.service` to `/etc/systemd/system/`, adjust the `ExecStart`
path and `User` if your username isn't `pi`, then:

```bash
sudo cp virtual-machine.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now virtual-machine
journalctl -u virtual-machine -f   # watch its logs
```
