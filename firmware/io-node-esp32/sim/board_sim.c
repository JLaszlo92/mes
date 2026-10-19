/*
 * Linux simulator of the board: hw.h (RTC in a file, LED printed), di.h (inputs driven through a FIFO) and
 * net.h (libcurl for the backend, libmosquitto with the device certificate for the broker).
 *
 * Input commands, one per line, written to $SIM_DI_FIFO (default ./di.fifo):
 *   set <di> <0|1>                     level of input DI1..DI8
 *   pulse <di> <ms>                    one pulse
 *   pulses <di> <count> <width> <gap>  a burst of pulses
 */
#define _GNU_SOURCE
#include <curl/curl.h>
#include <errno.h>
#include <fcntl.h>
#include <mosquitto.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "di.h"
#include "esp_log.h"
#include "hw.h"
#include "net.h"
#include "plat.h"

static const char *TAG = "sim";

/* ---------------- hw ---------------- */

esp_err_t hw_init(void) { return ESP_OK; }

/* RTC file: "<device ms at write> <host ms at write>" -> the RTC keeps running while the process is down. */
bool hw_rtc_read(int64_t *epoch_ms)
{
    if (getenv("SIM_RTC_EMPTY")) return false;
    FILE *f = fopen("rtc", "r");
    if (!f) return false;
    long long dev, host;
    int n = fscanf(f, "%lld %lld", &dev, &host);
    fclose(f);
    if (n != 2) return false;
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    long long now = (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
    *epoch_ms = dev + (now - host);
    return true;
}

esp_err_t hw_rtc_write(int64_t epoch_ms)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    FILE *f = fopen("rtc", "w");
    if (!f) return ESP_FAIL;
    fprintf(f, "%lld %lld\n", (long long)epoch_ms, (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
    fclose(f);
    return ESP_OK;
}

static led_state_t s_led = (led_state_t)-1;
esp_err_t hw_led_init(void) { return ESP_OK; }
void hw_led_set(led_state_t s)
{
    static const char *names[] = {"red blinking (unprovisioned)", "blue (no network)", "yellow (connecting)", "green", "magenta (buffer high)"};
    if (s != s_led) ESP_LOGI(TAG, "LED %s", names[s]);
    s_led = s;
}
void hw_led_flash(void) {}
void hw_led_tick(int64_t now_ms) { (void)now_ms; }

esp_err_t hw_storage_mount(void)
{
    mkdir(STORAGE_BASE, 0775);
    return ESP_OK;
}
void hw_storage_usage(size_t *total, size_t *used)
{
    *total = 0x9E0000; /* the storage partition of the board */
    *used = 0;
}

/* ---------------- di ---------------- */

static plat_queue_t *s_q;
static uint8_t s_levels;

static void put(int di, bool on)
{
    if (di < 1 || di > 8 || (((s_levels >> (di - 1)) & 1) == on)) return;
    s_levels ^= (uint8_t)(1u << (di - 1));
    di_edge_t e = {.di = (uint8_t)di, .active = on, .t_ms = plat_mono_ms()};
    plat_queue_send(s_q, &e, 100);
    plat_agent_notify();
}

static void di_thread(void *arg)
{
    const char *path = arg;
    char line[128];
    for (;;) {
        FILE *f = fopen(path, "r"); /* blocks until a writer opens it */
        if (!f) {
            plat_sleep_ms(500);
            continue;
        }
        while (fgets(line, sizeof line, f)) {
            int di, a, b, c;
            if (sscanf(line, "set %d %d", &di, &a) == 2) put(di, a != 0);
            else if (sscanf(line, "pulses %d %d %d %d", &di, &a, &b, &c) == 4)
                for (int i = 0; i < a; i++) {
                    put(di, true);
                    plat_sleep_ms(b);
                    put(di, false);
                    plat_sleep_ms(c);
                }
            else if (sscanf(line, "pulse %d %d", &di, &a) == 2) {
                put(di, true);
                plat_sleep_ms(a);
                put(di, false);
            }
        }
        fclose(f);
    }
}

esp_err_t di_start(bool active_low, plat_queue_t **edges)
{
    (void)active_low;
    s_q = plat_queue_new(512, sizeof(di_edge_t));
    *edges = s_q;
    const char *p = getenv("SIM_DI_FIFO");
    static char path[256];
    snprintf(path, sizeof path, "%s", p ? p : "di.fifo");
    if (mkfifo(path, 0600) != 0 && errno != EEXIST) return ESP_FAIL;
    const char *init = getenv("SIM_DI_LEVELS"); /* levels at boot, e.g. "4" = DI3 active */
    if (init) s_levels = (uint8_t)atoi(init);
    plat_thread(di_thread, "di", 0, path);
    ESP_LOGI("di", "simulated inputs on %s, now active: 0x%02x", path, s_levels);
    return ESP_OK;
}
uint8_t di_levels(void) { return s_levels; }
uint32_t di_overflows(void) { return 0; }

/* ---------------- net ---------------- */

esp_err_t net_eth_start(const prov_t *p)
{
    (void)p;
    curl_global_init(CURL_GLOBAL_DEFAULT);
    mosquitto_lib_init();
    return ESP_OK;
}
bool net_has_ip(void) { return getenv("SIM_NO_IP") == NULL; }

typedef struct {
    char *buf;
    size_t n;
} sink_t;
static size_t on_body(char *ptr, size_t size, size_t nm, void *ud)
{
    sink_t *s = ud;
    size_t add = size * nm;
    char *nb = realloc(s->buf, s->n + add + 1);
    if (!nb) return 0;
    memcpy(nb + s->n, ptr, add);
    s->buf = nb;
    s->n += add;
    s->buf[s->n] = 0;
    return add;
}

int net_https_post(const prov_t *p, const char *path, const char *body, int timeout_ms, char **resp)
{
    char url[300];
    snprintf(url, sizeof url, "%s%s", p->backend_url, path);
    CURL *c = curl_easy_init();
    struct curl_slist *h = curl_slist_append(NULL, "Content-Type: application/json");
    sink_t s = {0};
    struct curl_blob ca = {.data = p->ca_pem, .len = strlen(p->ca_pem), .flags = CURL_BLOB_COPY};
    curl_easy_setopt(c, CURLOPT_URL, url);
    curl_easy_setopt(c, CURLOPT_HTTPHEADER, h);
    curl_easy_setopt(c, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, (long)timeout_ms);
    curl_easy_setopt(c, CURLOPT_CAINFO_BLOB, &ca);
    curl_easy_setopt(c, CURLOPT_NOPROXY, "*");
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, on_body);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &s);
    long status = 0;
    if (curl_easy_perform(c) == CURLE_OK) curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status);
    curl_slist_free_all(h);
    curl_easy_cleanup(c);
    *resp = s.buf;
    return (int)status;
}

static struct mosquitto *s_m;
static volatile bool s_up;
static net_mqtt_event_fn s_on_conn;
static net_mqtt_ack_fn s_on_data;

static void on_connect(struct mosquitto *m, void *ud, int rc)
{
    (void)m;
    (void)ud;
    if (rc != 0) {
        ESP_LOGE("net", "the broker refused the connection (code %d): is the ACL entry of this node there?", rc);
        return;
    }
    s_up = true;
    ESP_LOGI("net", "connected to broker");
    s_on_conn(true);
}
static void on_disconnect(struct mosquitto *m, void *ud, int rc)
{
    (void)m;
    (void)ud;
    (void)rc;
    if (s_up) ESP_LOGW("net", "connection to broker closed");
    s_up = false;
    s_on_conn(false);
}
static void on_message(struct mosquitto *m, void *ud, const struct mosquitto_message *msg)
{
    (void)m;
    (void)ud;
    s_on_data(msg->topic, strlen(msg->topic), msg->payload, (size_t)msg->payloadlen);
}

static const char *pem_file(const char *name, const char *pem)
{
    static char paths[3][128];
    static int n;
    char *path = paths[n++ % 3];
    snprintf(path, 128, "%s/.%s.pem", STORAGE_BASE, name);
    FILE *f = fopen(path, "w");
    fputs(pem, f);
    fclose(f);
    chmod(path, 0600);
    return path;
}

/* libmosquitto does not retry a first connection that failed (esp-mqtt does): keep asking, like the device client. */
static void reconnect_thread(void *arg)
{
    (void)arg;
    for (;;) {
        plat_sleep_ms(3000);
        if (!s_up) mosquitto_reconnect_async(s_m);
    }
}

esp_err_t net_mqtt_start(const prov_t *p, net_mqtt_event_fn on_conn, net_mqtt_ack_fn on_data)
{
    s_on_conn = on_conn;
    s_on_data = on_data;
    char host[128];
    int port = 8883;
    if (sscanf(p->mqtt_url, "mqtts://%127[^:]:%d", host, &port) < 1) return ESP_FAIL;
    unsigned char r[6];
    plat_random(r, sizeof r);
    char id[48];
    snprintf(id, sizeof id, "edge-node-%02x%02x%02x%02x%02x%02x", r[0], r[1], r[2], r[3], r[4], r[5]);
    s_m = mosquitto_new(id, true, NULL);
    mosquitto_tls_set(s_m, pem_file("ca", p->ca_pem), NULL, pem_file("cert", p->cert_pem), pem_file("key", p->key_pem), NULL);
    mosquitto_tls_opts_set(s_m, 1, "tlsv1.2", NULL);
    mosquitto_connect_callback_set(s_m, on_connect);
    mosquitto_disconnect_callback_set(s_m, on_disconnect);
    mosquitto_message_callback_set(s_m, on_message);
    mosquitto_reconnect_delay_set(s_m, 2, 2, false);
    mosquitto_connect_async(s_m, host, port, 15);
    plat_thread(reconnect_thread, "mqtt-retry", 0, NULL);
    return mosquitto_loop_start(s_m) == MOSQ_ERR_SUCCESS ? ESP_OK : ESP_FAIL;
}
bool net_mqtt_connected(void) { return s_up; }
bool net_mqtt_publish(const char *topic, const char *data, size_t len)
{
    if (!s_up) return false;
    return mosquitto_publish(s_m, NULL, topic, (int)len, data, 1, false) == MOSQ_ERR_SUCCESS;
}
void net_mqtt_subscribe(const char *topic)
{
    if (s_up) mosquitto_subscribe(s_m, NULL, topic, 1);
}
void net_mqtt_unsubscribe(const char *topic)
{
    if (s_up) mosquitto_unsubscribe(s_m, NULL, topic);
}
