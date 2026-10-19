/*
 * The I/O node firmware on Linux: the real agent.c and mes_core, with board_sim.c instead of the board.
 * Provisioning comes from the environment instead of the NVS partition:
 *   SIM_NODE_NAME, SIM_TOKEN, SIM_BACKEND_URL, SIM_MQTT_URL, SIM_CA, SIM_CERT, SIM_KEY (paths of PEM files)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "agent.h"
#include "esp_log.h"
#include "hw.h"
#include "net.h"

static char *slurp(const char *path)
{
    FILE *f = path ? fopen(path, "r") : NULL;
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *b = malloc((size_t)n + 1);
    size_t got = fread(b, 1, (size_t)n, f);
    b[got] = 0;
    fclose(f);
    return b;
}

static void env(char *out, size_t cap, const char *name)
{
    const char *v = getenv(name);
    snprintf(out, cap, "%s", v ? v : "");
}

int main(void)
{
    setvbuf(stderr, NULL, _IOLBF, 0);
    static prov_t p;
    env(p.node_name, sizeof p.node_name, "SIM_NODE_NAME");
    env(p.token, sizeof p.token, "SIM_TOKEN");
    env(p.backend_url, sizeof p.backend_url, "SIM_BACKEND_URL");
    env(p.mqtt_url, sizeof p.mqtt_url, "SIM_MQTT_URL");
    p.ca_pem = slurp(getenv("SIM_CA"));
    p.cert_pem = slurp(getenv("SIM_CERT"));
    p.key_pem = slurp(getenv("SIM_KEY"));
    p.di_active_low = true;
    if (!p.token[0] || !p.backend_url[0] || !p.mqtt_url[0] || !p.ca_pem || !p.cert_pem || !p.key_pem) {
        ESP_LOGE("main", "this box is not provisioned (SIM_* variables)");
        return 78;
    }
    hw_init();
    hw_storage_mount();
    net_eth_start(&p);
    agent_run(&p);
    return 0;
}
