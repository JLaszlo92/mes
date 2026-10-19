/*
 * Host unit tests of the portable core (no device needed): `make -C components/mes_core/test`.
 * Each block names the TypeScript test of node-gate whose behaviour it checks.
 */
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "cJSON.h"
#include "mes_policy.h"
#include "mes_proto.h"
#include "mes_queue.h"
#include "mes_signal.h"
#include "mes_util.h"

static int g_fail, g_run;
#define CHECK(c)                                                                                                                                     \
    do {                                                                                                                                             \
        g_run++;                                                                                                                                     \
        if (!(c)) {                                                                                                                                  \
            g_fail++;                                                                                                                                \
            fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #c);                                                                  \
        }                                                                                                                                            \
    } while (0)
#define CHECK_STR(a, b) CHECK(strcmp((a), (b)) == 0)

static unsigned s_seed = 1;
static void test_rnd(void *buf, size_t len)
{
    for (size_t i = 0; i < len; i++) ((unsigned char *)buf)[i] = (unsigned char)((s_seed = s_seed * 1103515245u + 12345u) >> 16);
}

/* ---------------- util ---------------- */

static void test_util(void)
{
    char ts[32];
    mes_iso8601(0, ts);
    CHECK_STR(ts, "1970-01-01T00:00:00.000Z");
    mes_iso8601(1760877296789LL, ts); /* date -u -d @1760877296 */
    CHECK_STR(ts, "2025-10-19T12:34:56.789Z");
    mes_iso8601(951782400000LL, ts); /* leap day 2000 */
    CHECK_STR(ts, "2000-02-29T00:00:00.000Z");
    mes_iso8601(-1, ts);
    CHECK_STR(ts, "1969-12-31T23:59:59.999Z");

    CHECK(mes_epoch_ms_utc(1970, 1, 1, 0, 0, 0) == 0);
    CHECK(mes_epoch_ms_utc(2025, 10, 19, 12, 34, 56) == 1760877296000LL);
    CHECK(mes_epoch_ms_utc(2000, 2, 29, 0, 0, 0) == 951782400000LL);
    CHECK(mes_epoch_ms_utc(2027, 10, 2, 7, 54, 40) == 1822463680000LL);

    char id[37];
    mes_uuid4(id, test_rnd);
    CHECK(strlen(id) == 36 && id[14] == '4' && strchr("89ab", id[19]) && id[8] == '-' && id[23] == '-');

    char out[16];
    CHECK(mes_json_escape("a\"b\\c", out, sizeof out) == 7);
    CHECK_STR(out, "a\\\"b\\\\c");
    CHECK(mes_json_escape("0123456789abcdef", out, sizeof out) == -1);

    char h[65];
    mes_sha256_hex("", 0, h);
    CHECK_STR(h, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    mes_sha256_hex("abc", 3, h);
    CHECK_STR(h, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const char *m = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"; /* 56 bytes: two padding blocks */
    mes_sha256_hex(m, strlen(m), h);
    CHECK_STR(h, "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
}

/* ---------------- policy (offline-claim / heartbeat-failure / restart-decision / clock-check tests) ---------------- */

static void test_policy(void)
{
    CHECK(mes_classify_claim_failure(0) == MES_FAIL_UNREACHABLE);
    CHECK(mes_classify_claim_failure(502) == MES_FAIL_UNREACHABLE);
    CHECK(mes_classify_claim_failure(408) == MES_FAIL_UNREACHABLE);
    CHECK(mes_classify_claim_failure(429) == MES_FAIL_UNREACHABLE);
    CHECK(mes_classify_claim_failure(409) == MES_FAIL_REJECTED);
    CHECK(mes_classify_claim_failure(401) == MES_FAIL_REJECTED);
    CHECK(mes_classify_heartbeat_failure(409) == MES_HB_LEASE_LOST);
    CHECK(mes_classify_heartbeat_failure(404) == MES_HB_LEASE_LOST);
    CHECK(mes_classify_heartbeat_failure(429) == MES_HB_TRANSIENT);
    CHECK(mes_classify_heartbeat_failure(503) == MES_HB_TRANSIENT);
    CHECK(mes_classify_heartbeat_failure(0) == MES_HB_TRANSIENT);
    CHECK(mes_backoff_ms(0) == 5000 && mes_backoff_ms(1) == 10000 && mes_backoff_ms(2) == 20000 && mes_backoff_ms(3) == 40000);
    CHECK(mes_backoff_ms(4) == 60000 && mes_backoff_ms(40) == 60000);

    mes_rejection_t r;
    mes_rejection_reset(&r);
    CHECK(!mes_rejection_note(&r, 1000));
    CHECK(!mes_rejection_note(&r, 150999));
    CHECK(mes_rejection_note(&r, 151000));

    int64_t ahead;
    CHECK(mes_measure_ahead(10000, 200, 9000, &ahead) && ahead == 1100);
    CHECK(mes_measure_ahead(10000, 3, 10000, &ahead) && ahead == 2); /* Math.round(1.5) = 2 */
    CHECK(!mes_measure_ahead(10000, 5001, 0, &ahead));
    CHECK(!mes_measure_ahead(10000, -1, 0, &ahead));
    CHECK(!mes_clock_needs_step(1999) && !mes_clock_needs_step(-1999) && mes_clock_needs_step(2000) && mes_clock_needs_step(-300000));

    mes_restart_decider_t d;
    mes_restart_decider_init(&d);
    CHECK(mes_restart_decide(&d, 10000, "a", "a", true) == MES_RESTART_NONE); /* request too early */
    CHECK(mes_restart_decide(&d, 20000, "a", "a", true) == MES_RESTART_REQUESTED);
    mes_restart_decider_init(&d);
    CHECK(mes_restart_decide(&d, 70000, "a", "b", false) == MES_RESTART_NONE); /* first sight */
    CHECK(mes_restart_decide(&d, 100000, "a", "b", false) == MES_RESTART_CONFIG_CHANGED);
    mes_restart_decider_init(&d);
    CHECK(mes_restart_decide(&d, 70000, "a", "b", false) == MES_RESTART_NONE);
    CHECK(mes_restart_decide(&d, 100000, "a", "c", false) == MES_RESTART_NONE); /* changed again: wait */
    CHECK(mes_restart_decide(&d, 130000, "a", "c", false) == MES_RESTART_CONFIG_CHANGED);
    mes_restart_decider_init(&d);
    CHECK(mes_restart_decide(&d, 10000, "a", "b", false) == MES_RESTART_NONE);
    CHECK(mes_restart_decide(&d, 40000, "a", "b", false) == MES_RESTART_NONE); /* < 60 s uptime */
    CHECK(mes_restart_decide(&d, 70000, "a", "b", false) == MES_RESTART_CONFIG_CHANGED);
    mes_restart_decider_init(&d);
    CHECK(mes_restart_decide(&d, 70000, NULL, "b", false) == MES_RESTART_NONE); /* offline start: no revision */
    CHECK(mes_restart_decide(&d, 100000, NULL, "b", false) == MES_RESTART_NONE);
    CHECK(mes_restart_decide(&d, 100000, "a", NULL, false) == MES_RESTART_NONE); /* old backend */
}

/* ---------------- signal (gpio bridge, ProductionGate, SignalPresenceWatchdog tests) ---------------- */

#define MAXR 64
static mes_reading_t s_r[MAXR];
static int s_nr;
static void collect(void *ctx, const mes_reading_t *r)
{
    (void)ctx;
    if (s_nr < MAXR) s_r[s_nr++] = *r;
}

static mes_chan_cfg_t cfg_status_bit(void)
{
    mes_chan_cfg_t c = {.status_mode = MES_STATUS_BIT, .no_signal_timeout_ms = 60000, .accept_production_while_down = true, .good_di = 1, .scrap_di = 2,
                        .status_di = 3, .count_debounce_ms = 20, .status_debounce_ms = 1000};
    return c;
}

static void pulse(mes_chan_logic_t *c, uint8_t di, int64_t t, int64_t width)
{
    mes_chan_edge(c, di, true, t);
    mes_chan_edge(c, di, false, t + width);
}

static void test_debounce(void)
{
    mes_debounce_t d;
    int64_t at;
    mes_debounce_init(&d, 20, false);
    CHECK(!mes_debounce_feed(&d, true, 100, &at));
    CHECK(!mes_debounce_poll(&d, 119, &at));
    CHECK(mes_debounce_poll(&d, 120, &at) && at == 100 && d.stable);
    /* a bounce: on 5 ms, off, on again -> the candidate restarts at the last edge */
    mes_debounce_init(&d, 20, false);
    mes_debounce_feed(&d, true, 0, &at);
    mes_debounce_feed(&d, false, 5, &at);
    mes_debounce_feed(&d, true, 7, &at);
    CHECK(!mes_debounce_poll(&d, 26, &at));
    CHECK(mes_debounce_poll(&d, 27, &at) && at == 7);
    /* evaluated late: the edge that follows a mature candidate first commits it */
    mes_debounce_init(&d, 20, false);
    mes_debounce_feed(&d, true, 0, &at);
    CHECK(mes_debounce_feed(&d, false, 500, &at) && at == 0 && d.stable);
    CHECK(mes_debounce_poll(&d, 520, &at) && at == 500 && !d.stable);
}

static void test_channel(void)
{
    mes_chan_logic_t c;
    mes_chan_cfg_t cfg = cfg_status_bit();

    /* status_bit: the status is reported at once, parts are counted on the rising edge, pulses below 20 ms are noise */
    s_nr = 0;
    mes_chan_start(&c, &cfg, 1u << 2, 0, collect, NULL); /* DI3 active = running */
    CHECK(s_nr == 1 && s_r[0].kind == MES_READ_RUNNING && s_r[0].t == 0);
    pulse(&c, 1, 100, 50);
    pulse(&c, 1, 300, 10); /* too short */
    pulse(&c, 2, 500, 40);
    mes_chan_poll(&c, 1000);
    CHECK(s_nr == 3 && s_r[1].kind == MES_READ_GOOD && s_r[1].t == 100 && s_r[2].kind == MES_READ_SCRAP && s_r[2].t == 500);

    /* status change after the status debounce; a 400 ms flicker is ignored */
    s_nr = 0;
    mes_chan_edge(&c, 3, false, 2000);
    mes_chan_edge(&c, 3, true, 2400);
    mes_chan_poll(&c, 5000);
    CHECK(s_nr == 0);
    mes_chan_edge(&c, 3, false, 6000);
    mes_chan_poll(&c, 6999);
    CHECK(s_nr == 0);
    mes_chan_poll(&c, 7000);
    CHECK(s_nr == 1 && s_r[0].kind == MES_READ_DOWN && s_r[0].t == 6000);

    /* ProductionGate: accept=false drops parts while down */
    cfg.accept_production_while_down = false;
    s_nr = 0;
    mes_chan_start(&c, &cfg, 0, 0, collect, NULL);
    CHECK(s_nr == 1 && s_r[0].kind == MES_READ_DOWN);
    pulse(&c, 1, 100, 50);
    mes_chan_poll(&c, 1000);
    CHECK(s_nr == 1);
    mes_chan_edge(&c, 3, true, 2000);
    mes_chan_poll(&c, 3000);
    pulse(&c, 1, 3100, 50);
    mes_chan_poll(&c, 4000);
    CHECK(s_nr == 3 && s_r[1].kind == MES_READ_RUNNING && s_r[2].kind == MES_READ_GOOD);

    /* inverted status input (e.g. a "fault" lamp: on = down) */
    cfg = cfg_status_bit();
    cfg.status_invert = true;
    s_nr = 0;
    mes_chan_start(&c, &cfg, 1u << 2, 0, collect, NULL);
    CHECK(s_nr == 1 && s_r[0].kind == MES_READ_DOWN);

    /* no status input in status_bit mode: parts only, no status (ProductionGate starts as running) */
    cfg = cfg_status_bit();
    cfg.status_di = 0;
    cfg.accept_production_while_down = false;
    s_nr = 0;
    mes_chan_start(&c, &cfg, 0, 0, collect, NULL);
    pulse(&c, 1, 100, 50);
    mes_chan_poll(&c, 1000);
    CHECK(s_nr == 1 && s_r[0].kind == MES_READ_GOOD);

    /* signal_presence: down at start, running with the first part, down after the timeout (at last part + timeout) */
    cfg = cfg_status_bit();
    cfg.status_mode = MES_SIGNAL_PRESENCE;
    cfg.no_signal_timeout_ms = 10000;
    s_nr = 0;
    mes_chan_start(&c, &cfg, 0, 0, collect, NULL);
    CHECK(s_nr == 1 && s_r[0].kind == MES_READ_DOWN);
    pulse(&c, 1, 1000, 50);
    pulse(&c, 1, 5000, 50);
    mes_chan_poll(&c, 14999);
    CHECK(s_nr == 4 && s_r[1].kind == MES_READ_RUNNING && s_r[1].t == 1000 && s_r[2].kind == MES_READ_GOOD && s_r[3].kind == MES_READ_GOOD);
    mes_chan_poll(&c, 15000);
    CHECK(s_nr == 5 && s_r[4].kind == MES_READ_DOWN && s_r[4].t == 15000);
    mes_chan_edge(&c, 3, true, 16000); /* the status input is ignored in this mode */
    mes_chan_poll(&c, 20000);
    CHECK(s_nr == 5);

    /* two roles on one input: the same DI as good and status in one channel */
    cfg = cfg_status_bit();
    cfg.good_di = 3;
    cfg.scrap_di = 0;
    s_nr = 0;
    mes_chan_start(&c, &cfg, 0, 0, collect, NULL);
    mes_chan_edge(&c, 3, true, 100);
    mes_chan_poll(&c, 1100);
    /* both become valid at 100: the status is reported first, so the part is counted as made while running */
    CHECK(s_nr == 3 && s_r[0].kind == MES_READ_DOWN && s_r[1].kind == MES_READ_RUNNING && s_r[1].t == 100 && s_r[2].kind == MES_READ_GOOD && s_r[2].t == 100);
}

/* ---------------- events and protocol ---------------- */

static void test_proto(void)
{
    char line[512];
    int n = mes_event_reading(line, sizeof line, "m\"1", 1760877296789LL, "id-1", MES_READ_GOOD);
    CHECK(n > 0);
    cJSON *j = cJSON_Parse(line);
    CHECK(j != NULL);
    CHECK_STR(cJSON_GetObjectItem(j, "machineId")->valuestring, "m\"1");
    CHECK_STR(cJSON_GetObjectItem(j, "timestamp")->valuestring, "2025-10-19T12:34:56.789Z");
    CHECK_STR(cJSON_GetObjectItem(j, "type")->valuestring, "production_count");
    CHECK_STR(cJSON_GetObjectItem(j, "result")->valuestring, "good");
    cJSON_Delete(j);
    CHECK(mes_event_reading(line, 40, "m1", 0, "id-1", MES_READ_DOWN) == -1);

    n = mes_event_data_gap(line, sizeof line, "m1", 0, "id-2", "buffer_full", false, 0, 7, 1);
    j = cJSON_Parse(line);
    CHECK(j && cJSON_IsNull(cJSON_GetObjectItem(j, "gapSeconds")) && cJSON_GetObjectItem(j, "lostGood")->valueint == 7);
    cJSON_Delete(j);

    char mid[65], id[64];
    const char *t = "mes/machines/cnc-01/acks";
    CHECK(mes_machine_of_ack_topic(t, strlen(t), mid, sizeof mid) && strcmp(mid, "cnc-01") == 0);
    t = "mes/machines/cnc-01/events";
    CHECK(!mes_machine_of_ack_topic(t, strlen(t), mid, sizeof mid));
    const char *a = "{\"sourceEventId\":\"abc\"}";
    CHECK(mes_parse_ack(a, strlen(a), id, sizeof id) && strcmp(id, "abc") == 0);
    CHECK(!mes_parse_ack("{}", 2, id, sizeof id));

    const char *claim =
        "{\"sessionId\":\"s1\",\"serverTimeMs\":1760877296789,\"configRevision\":\"abcd\",\"settings\":{\"catchupMaxMinutes\":15},\"channels\":["
        "{\"machineId\":\"weiler\",\"signalSource\":\"gpio\",\"connectionConfig\":{\"goodPin\":1,\"statusPin\":\"DI3\",\"statusDebounceMs\":3000},"
        "\"statusMode\":\"status_bit\",\"noSignalTimeoutSeconds\":60,\"acceptProductionWhileDown\":false},"
        "{\"machineId\":\"cma\",\"signalSource\":\"gpio\",\"connectionConfig\":{\"goodPin\":\"in 5\"},\"statusMode\":\"signal_presence\","
        "\"noSignalTimeoutSeconds\":120,\"acceptProductionWhileDown\":true},"
        "{\"machineId\":\"plc\",\"signalSource\":\"s7\",\"connectionConfig\":{\"plcIp\":\"1.2.3.4\"},\"statusMode\":\"status_bit\"},"
        "{\"machineId\":\"bad\",\"signalSource\":\"gpio\",\"connectionConfig\":{\"goodPin\":17}},"
        "{\"machineId\":null,\"signalSource\":\"gpio\",\"connectionConfig\":{}}]}";
    mes_claim_t c;
    CHECK(mes_parse_claim(claim, &c));
    CHECK_STR(c.session_id, "s1");
    CHECK(c.has_server_time && c.server_time_ms == 1760877296789LL);
    CHECK(c.has_revision && strcmp(c.revision, "abcd") == 0 && c.catchup_max_minutes == 15);
    CHECK(c.n_channels == 4 && c.n_ignored == 1);
    CHECK(c.channels[0].cfg.good_di == 1 && c.channels[0].cfg.status_di == 3 && c.channels[0].cfg.scrap_di == 0);
    CHECK(c.channels[0].cfg.status_debounce_ms == 3000 && c.channels[0].cfg.count_debounce_ms == 20 && !c.channels[0].cfg.accept_production_while_down);
    CHECK(c.channels[0].problem[0] == 0);
    CHECK(c.channels[1].cfg.good_di == 5 && c.channels[1].cfg.status_mode == MES_SIGNAL_PRESENCE && c.channels[1].cfg.no_signal_timeout_ms == 120000);
    CHECK(c.channels[2].source == MES_SRC_UNSUPPORTED && c.channels[2].problem[0]);
    CHECK(c.channels[3].problem[0]);
    CHECK(!mes_parse_claim("{\"error\":\"x\"}", &c));

    mes_heartbeat_answer_t hb;
    CHECK(mes_parse_heartbeat("{\"success\":true,\"serverTimeMs\":5,\"configRevision\":\"r2\",\"restartRequested\":true}", &hb));
    CHECK(hb.has_server_time && hb.server_time_ms == 5 && hb.restart_requested && strcmp(hb.revision, "r2") == 0);
    CHECK(mes_parse_heartbeat("{\"success\":true}", &hb) && !hb.has_revision && !hb.restart_requested);

    char *b = mes_body_heartbeat("tok", "s1", 1760877296789LL, 1790000000000LL);
    j = cJSON_Parse(b);
    CHECK(j && strcmp(cJSON_GetObjectItem(j, "sessionId")->valuestring, "s1") == 0);
    CHECK((int64_t)cJSON_GetObjectItem(cJSON_GetObjectItem(j, "clientCert"), "expiresAtMs")->valuedouble == 1790000000000LL);
    CHECK(strstr(b, "1760877296789") != NULL); /* printed as an integer */
    cJSON_Delete(j);
    free(b);
    b = mes_body_claim("tok", -1, 0, "io-node-v1");
    CHECK(b && strstr(b, "clientTimeMs") == NULL && strstr(b, "clientCert") == NULL && strstr(b, "\"agentVersion\":\"io-node-v1\""));
    free(b);

    /* claim cache: bound to the token, max age, no session kept */
    char *file = mes_cache_encode("tok", 1000000, claim);
    CHECK(file && strstr(file, "\"s1\"") == NULL && strstr(file, "tok\"") == NULL);
    int64_t age;
    CHECK(mes_cache_decode(file, "tok", 2000000, MES_CLAIM_CACHE_MAX_AGE_MS, &c, &age) == MES_CACHE_OK && age == 1000000 && c.n_channels == 4);
    CHECK(c.session_id[0] == 0);
    CHECK(mes_cache_decode(file, "other", 2000000, MES_CLAIM_CACHE_MAX_AGE_MS, &c, &age) == MES_CACHE_OTHER_TOKEN);
    CHECK(mes_cache_decode(file, "tok", 1000000 + MES_CLAIM_CACHE_MAX_AGE_MS + 1, MES_CLAIM_CACHE_MAX_AGE_MS, &c, &age) == MES_CACHE_TOO_OLD);
    CHECK(mes_cache_decode(file, "tok", -1, MES_CLAIM_CACHE_MAX_AGE_MS, &c, &age) == MES_CACHE_OK && age == -1); /* time unknown */
    CHECK(mes_cache_decode(file, "tok", 1000000 + MES_CLAIM_CACHE_MAX_AGE_MS + 1, 0, &c, &age) == MES_CACHE_OK); /* 0 = no limit */
    CHECK(mes_cache_decode("garbage", "tok", 0, 0, &c, &age) == MES_CACHE_BAD);
    free(file);
}

/* ---------------- queue (buffer.ts, retry-tracker.ts, ack-batcher.ts tests) ---------------- */

static char s_dir[256];
static int s_sent;
static char s_last_sent[512];
static bool s_connected = true;
static bool send_ok(void *ctx, const char *json, size_t len)
{
    (void)ctx;
    if (!s_connected) return false;
    s_sent++;
    snprintf(s_last_sent, sizeof s_last_sent, "%.*s", (int)len, json);
    return true;
}

static void rm_rf(const char *dir)
{
    DIR *d = opendir(dir);
    if (!d) return;
    struct dirent *de;
    char p[512];
    while ((de = readdir(d))) {
        if (de->d_name[0] == '.') continue;
        snprintf(p, sizeof p, "%s/%s", dir, de->d_name);
        unlink(p);
    }
    closedir(d);
    rmdir(dir);
}

static int count_files(const char *dir)
{
    DIR *d = opendir(dir);
    if (!d) return -1;
    int n = 0;
    struct dirent *de;
    while ((de = readdir(d)))
        if (de->d_name[0] != '.') n++;
    closedir(d);
    return n;
}

static void push_n(mes_queue_t *q, int from, int count, mes_reading_kind_t kind)
{
    char line[256], id[16];
    for (int i = from; i < from + count; i++) {
        snprintf(id, sizeof id, "e%06d", i);
        mes_event_reading(line, sizeof line, "m1", 1000 + i, id, kind);
        CHECK(mes_queue_push(q, line, id));
    }
}

static void test_queue(void)
{
    snprintf(s_dir, sizeof s_dir, "/tmp/mes-core-test-%d", (int)getpid());
    rm_rf(s_dir);
    mes_queue_t *q = mes_queue_open(s_dir, "m1", 1 << 20);
    CHECK(q && mes_queue_pending(q) == 0);

    /* a new event is sent once at once; the sweep resends only after 15 s without an ack, at most 300 */
    push_n(q, 0, 1, MES_READ_GOOD);
    s_sent = 0;
    mes_queue_send_last(q, 0, send_ok, NULL);
    mes_queue_send_last(q, 0, send_ok, NULL);
    CHECK(s_sent == 1);
    CHECK(mes_queue_sweep(q, 14999, MES_RETRY_MAX_BATCH, send_ok, NULL) == 0);
    CHECK(mes_queue_sweep(q, 15000, MES_RETRY_MAX_BATCH, send_ok, NULL) == 1);
    push_n(q, 1, 499, MES_READ_GOOD);
    CHECK(mes_queue_sweep(q, 15001, MES_RETRY_MAX_BATCH, send_ok, NULL) == 300); /* oldest first, bounded */
    CHECK(mes_queue_sweep(q, 15002, MES_RETRY_MAX_BATCH, send_ok, NULL) == 199);
    CHECK(mes_queue_sweep(q, 15003, MES_RETRY_MAX_BATCH, send_ok, NULL) == 0);
    mes_queue_reset_sent(q); /* reconnect */
    CHECK(mes_queue_sweep(q, 15004, 1000, send_ok, NULL) == 500);
    s_connected = false;
    mes_queue_reset_sent(q);
    CHECK(mes_queue_sweep(q, 15005, 1000, send_ok, NULL) == 0); /* not connected: stops at once */
    s_connected = true;

    /* acks: unknown ones do nothing, a duplicate is harmless */
    CHECK(mes_queue_ack(q, "e000000"));
    CHECK(!mes_queue_ack(q, "e000000"));
    CHECK(!mes_queue_ack(q, "nope"));
    CHECK(mes_queue_pending(q) == 499);
    mes_queue_tick(q, 20000, true);

    /* restart: everything still on flash is loaded again in its order (acks live in RAM; the backend skips resent events) */
    mes_queue_close(q);
    q = mes_queue_open(s_dir, "m1", 1 << 20);
    CHECK(q && mes_queue_pending(q) == 500);
    s_sent = 0;
    mes_queue_sweep(q, 0, 1, send_ok, NULL);
    CHECK(strstr(s_last_sent, "\"e000000\"") != NULL);

    /* acking everything deletes the segments */
    char id[16];
    for (int i = 0; i < 500; i++) {
        snprintf(id, sizeof id, "e%06d", i);
        CHECK(mes_queue_ack(q, id));
    }
    mes_queue_tick(q, 30000, true);
    CHECK(mes_queue_pending(q) == 0 && mes_queue_bytes(q) == 0);
    CHECK(count_files(s_dir) == 0);

    /* a small drained writer stays while events keep coming, and goes once it has been idle for 5 s */
    push_n(q, 900, 2, MES_READ_GOOD);
    mes_queue_tick(q, 31000, true);
    mes_queue_ack(q, "e000900");
    mes_queue_ack(q, "e000901");
    mes_queue_tick(q, 32000, false);
    CHECK(count_files(s_dir) == 1);
    mes_queue_tick(q, 36000, false);
    CHECK(count_files(s_dir) == 0);

    /* acks out of order, then restart: only the unacked ones come back */
    push_n(q, 1000, 10, MES_READ_GOOD);
    mes_queue_ack(q, "e001003");
    mes_queue_ack(q, "e001007");
    mes_queue_tick(q, 40000, true);
    mes_queue_close(q);
    q = mes_queue_open(s_dir, "m1", 1 << 20);
    CHECK(mes_queue_pending(q) == 10); /* acks are in RAM only: after a restart they are sent again (backend dedups) */
    mes_queue_close(q);

    /* a line cut by a power loss is dropped when loaded; the writer never appends to an old segment */
    rm_rf(s_dir);
    q = mes_queue_open(s_dir, "m1", 1 << 20);
    push_n(q, 0, 3, MES_READ_GOOD);
    mes_queue_close(q);
    char path[512];
    snprintf(path, sizeof path, "%s/%08x.log", s_dir, 0u);
    FILE *f = fopen(path, "a");
    fputs("{\"machineId\":\"m1\",\"timestamp\":\"2026-", f); /* cut */
    fclose(f);
    q = mes_queue_open(s_dir, "m1", 1 << 20);
    CHECK(mes_queue_pending(q) == 3 && mes_queue_load_skipped(q) == 1);
    push_n(q, 3, 1, MES_READ_GOOD);
    CHECK(count_files(s_dir) == 2);
    mes_queue_close(q);

    /* an orphan buffer (channel removed) knows its machine from its events; an empty one is removed */
    q = mes_queue_open(s_dir, NULL, 1 << 20);
    CHECK(q && strcmp(mes_queue_machine_id(q), "m1") == 0 && mes_queue_pending(q) == 4);
    mes_queue_destroy(q);
    CHECK(count_files(s_dir) == -1);
    mkdir(s_dir, 0775);
    CHECK(mes_queue_open(s_dir, NULL, 1 << 20) == NULL);
    CHECK(count_files(s_dir) == -1);

    /* full buffer: the oldest go first and are counted by kind */
    q = mes_queue_open(s_dir, "m1", 10 * (180 + 96));
    push_n(q, 0, 3, MES_READ_SCRAP);
    push_n(q, 3, 5, MES_READ_GOOD);
    push_n(q, 8, 2, MES_READ_RUNNING);
    mes_dropped_t dr = mes_queue_take_dropped(q);
    CHECK(dr.good + dr.scrap + dr.other == 0);
    push_n(q, 10, 6, MES_READ_GOOD);
    dr = mes_queue_take_dropped(q);
    CHECK(mes_queue_bytes(q) <= mes_queue_cap(q));
    CHECK(dr.scrap == 3 && dr.good + dr.other == 10 + 6 - (unsigned)mes_queue_pending(q) - 3);
    s_sent = 0;
    mes_queue_sweep(q, 0, 1, send_ok, NULL);
    CHECK(strstr(s_last_sent, "\"e000003\"") == NULL); /* the oldest are gone */
    dr = mes_queue_take_dropped(q);
    CHECK(dr.good == 0 && dr.scrap == 0);

    /* segments roll at 32 KiB and drained ones are deleted */
    mes_queue_set_cap(q, 4 << 20);
    push_n(q, 100, 600, MES_READ_GOOD);
    mes_queue_tick(q, 0, true);
    CHECK(count_files(s_dir) >= 3);
    for (int i = 100; i < 700; i++) {
        snprintf(id, sizeof id, "e%06d", i);
        mes_queue_ack(q, id);
    }
    for (int i = 0; i < 16; i++) {
        snprintf(id, sizeof id, "e%06d", i);
        mes_queue_ack(q, id);
    }
    mes_queue_tick(q, 0, true);
    CHECK(mes_queue_pending(q) == 0 && count_files(s_dir) <= 1);
    mes_queue_destroy(q);
}

int main(void)
{
    test_util();
    test_policy();
    test_debounce();
    test_channel();
    test_proto();
    test_queue();
    printf("%d checks, %d failed\n", g_run, g_fail);
    return g_fail ? 1 : 0;
}
