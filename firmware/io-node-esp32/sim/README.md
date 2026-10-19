# The I/O node on Linux (end-to-end tests)

`io-node-sim` is the firmware's own `main/agent.c` and `components/mes_core`, built for Linux with
`plat_linux.c` (threads instead of FreeRTOS) and `board_sim.c` (inputs from a FIFO, RTC in a file, libcurl to the
backend, libmosquitto with the device certificate). Only the board drivers differ from the device.

```bash
sudo apt install libcurl4-openssl-dev libmosquitto-dev libssl-dev
make IDF_PATH=~/esp-idf            # cJSON comes from the ESP-IDF checkout
```

Run it from an empty directory (it keeps `data/` = the flash, `rtc`, `di.fifo` there) with the provisioning in the
environment:

```bash
SIM_NODE_NAME=io-node-test SIM_TOKEN=<edge node token> \
SIM_BACKEND_URL=http://127.0.0.1:3001 SIM_MQTT_URL=mqtts://localhost:8884 \
SIM_CA=server-ca.crt SIM_CERT=io-node-test.crt SIM_KEY=io-node-test.key \
SIM_DI_LEVELS=4 ./io-node-sim       # bit mask of the inputs active at boot (4 = DI3)
```

A "reboot" exits with code 75 (a hang of 15 s with 75 too): run it in a loop that starts it again after 2 s, like
systemd does for node-gate. Inputs:

```bash
echo "set 3 0" > di.fifo              # DI3 inactive
echo "pulse 1 50" > di.fifo           # one 50 ms pulse on DI1
echo "pulses 1 20 50 100" > di.fifo   # 20 pulses, 50 ms on, 100 ms off
```

Other switches: `SIM_RTC_EMPTY=1` (the RTC has no valid time), `SIM_CLOCK_OFFSET_MS=-3600000` (the device clock is an
hour behind), `SIM_NO_IP=1` (no network), `SIM_DEBUG=1` (debug lines, e.g. every part).

The broker needs a listener with `require_certificate true` and `use_identity_as_username true` and an ACL block for
the node's name (`ops/mosquitto/`); the backend can run against a plain PostgreSQL if `create_hypertable` and
`drop_chunks` exist as no-op functions and `MES_RAW_EVENT_RETENTION_DAYS=0`.
