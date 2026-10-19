/*
 * The edge node itself: the same life cycle as node-gate's registry mode (packages/edge-agent/src/index.ts),
 * on one task that owns all state. Log lines keep node-gate's wording where they mean the same, so the
 * journal greps of EDGE_AGENT_RELEASES.md work on the serial log too.
 *
 *   start ── claim ──ok──────────────────────────────► running WITH a lease (heartbeat every 30 s)
 *              │ rejected (409, 401…): ask again 5,10,20,40,60 s; still refused after 150 s → reboot
 *              │ unreachable: start from the claim cache WITHOUT a lease ──► background claim ──ok──► lease adopted
 *   heartbeat refused (4xx) → lease lost: channels keep running, claim again in the background
 *   heartbeat answer: changed configuration (twice) / "Restart agent" → release the lease, reboot
 */
#include "agent.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "di.h"
#include "esp_log.h"
#include "hw.h"
#include "mes_policy.h"
#include "mes_proto.h"
#include "mes_queue.h"
#include "mes_signal.h"
#include "mes_util.h"
#include "net.h"
#include "plat.h"

static const char *TAG = "agent";

#define QUEUE_ROOT STORAGE_BASE "/q"
#define CLAIM_CACHE_PATH STORAGE_BASE "/claim-cache.json"
#define SWEEP_INTERVAL_MS 4000
#define TICK_INTERVAL_MS 100
#define STATUS_LOG_INTERVAL_MS (10 * 60 * 1000)
#define RAW_DI_LOG_MS (15 * 60 * 1000) /* after a boot, every raw input change is logged for a while (wiring check) */
#define GAP_REPORT_INTERVAL_MS 60000
#define MAX_UNSTAMPED 4096
#define RTC_REFRESH_MS (6LL * 3600 * 1000)
#define HTTP_HANG_MS 60000
#define MAX_ORPHANS 8
#define PRECISE_RTT_MS 1000

/* ---------------- state ---------------- */

typedef struct {
    mes_channel_t def;
    bool runs;
    mes_chan_logic_t logic;
    mes_queue_t *q;
    char topic[128], ack_topic[128];
    mes_reading_t *unstamped; /* readings made before the wall clock was known */
    size_t n_unstamped;
    uint32_t lost_unstamped_good, lost_unstamped_scrap;
    mes_dropped_t dropped; /* buffer full, not reported yet */
    int64_t gap_reported_at;
} chan_t;

typedef struct {
    mes_queue_t *q;
    char topic[128], ack_topic[128];
} orphan_t;

typedef enum { HTTP_CLAIM, HTTP_HEARTBEAT } http_kind_t;

typedef enum { MSG_ACK, MSG_MQTT, MSG_HTTP, MSG_SNTP } msg_type_t;

typedef struct {
    msg_type_t type;
    union {
        struct {
            char machine[MES_MACHINE_ID_MAX + 1];
            char id[64];
        } ack;
        bool connected;
        struct {
            http_kind_t kind;
            int status;
            char *body;
            int64_t sent_wall, rtt;
        } http;
    };
} msg_t;

typedef struct {
    http_kind_t kind;
    char *body;
} http_req_t;

static prov_t *P;
static plat_queue_t *s_msgs, *s_edges, *s_http_reqs;

static chan_t s_ch[MES_MAX_CHANNELS];
static size_t s_nch;
static orphan_t s_orph[MAX_ORPHANS];
static size_t s_norph;
static mes_claim_t s_active; /* the configuration the channels run on */
static bool s_channels_set;

static bool s_has_session;
static char s_session[96];
static bool s_has_revision;
static char s_revision[48];
static bool s_background_claim; /* true while running without a lease */
static bool s_offline_start;    /* started from the claim cache, no lease adopted yet */
static bool s_hold_publish;     /* collecting into the buffer while the backend refuses the lease: nothing is sent */
static int s_claim_attempt;
static mes_rejection_t s_rej;
static int64_t s_next_claim_at = 0, s_next_heartbeat_at = INT64_MAX;
static bool s_http_busy;
static int64_t s_http_since;
static mes_restart_decider_t s_restart;

static bool s_time_trusted;
static int64_t s_rtc_written_at = INT64_MIN / 2;
static int64_t s_cert_expires_ms;
static size_t s_queue_budget;

void agent_on_mqtt(bool connected);
void agent_on_mqtt_data(const char *topic, size_t topic_len, const char *data, size_t data_len);

static int64_t mono_now(void) { return plat_mono_ms(); }
static int64_t wall_now(void) { return plat_wall_ms(); }
static void set_wall(int64_t ms) { plat_set_wall_ms(ms); }
static void rnd(void *buf, size_t len) { plat_random(buf, len); }
static void *psram_alloc(size_t n) { return plat_big_alloc(n); }

/* ---------------- events ---------------- */

static bool send_to(void *ctx, const char *json, size_t len) { return !s_hold_publish && net_mqtt_publish((const char *)ctx, json, len); }

static void note_dropped(chan_t *c)
{
    mes_dropped_t d = mes_queue_take_dropped(c->q);
    if (d.good + d.scrap + d.other == 0) return;
    if (c->dropped.good + c->dropped.scrap + c->dropped.other == 0)
        ESP_LOGE(TAG, "[%s] the buffer is full - the oldest events are dropped (the lost parts are reported as a data gap)", c->def.machine_id);
    c->dropped.good += d.good;
    c->dropped.scrap += d.scrap;
    c->dropped.other += d.other;
}

static void push_line(chan_t *c, const char *line, const char *id)
{
    if (!mes_queue_push(c->q, line, id)) {
        ESP_LOGE(TAG, "[%s] an event could not be stored (out of memory)", c->def.machine_id);
        return;
    }
    mes_queue_send_last(c->q, mono_now(), send_to, c->topic);
    note_dropped(c);
}

static void push_data_gap(chan_t *c, const char *reason, uint32_t good, uint32_t scrap)
{
    char line[512], id[37];
    mes_uuid4(id, rnd);
    if (mes_event_data_gap(line, sizeof line, c->def.machine_id, wall_now(), id, reason, false, 0, good, scrap) < 0) return;
    ESP_LOGW(TAG, "[%s] parts were not booked (data gap) - reporting it as an event: reason %s, lost %u good / %u scrap", c->def.machine_id, reason,
             (unsigned)good, (unsigned)scrap);
    push_line(c, line, id);
}

static void report_drops(chan_t *c, int64_t now, bool force)
{
    if (c->dropped.good + c->dropped.scrap + c->dropped.other == 0) return;
    if (!force && now - c->gap_reported_at < GAP_REPORT_INTERVAL_MS) return;
    mes_dropped_t d = c->dropped;
    memset(&c->dropped, 0, sizeof c->dropped);
    c->gap_reported_at = now;
    ESP_LOGW(TAG, "[%s] dropped from the full buffer: %u good, %u scrap, %u other events", c->def.machine_id, (unsigned)d.good, (unsigned)d.scrap,
             (unsigned)d.other);
    if (d.good + d.scrap > 0) push_data_gap(c, "buffer_full", d.good, d.scrap);
}

static void store_reading(chan_t *c, const mes_reading_t *r)
{
    char line[512], id[37];
    mes_uuid4(id, rnd);
    int64_t wall = wall_now() - (mono_now() - r->t); /* the moment the input changed, not now */
    if (mes_event_reading(line, sizeof line, c->def.machine_id, wall, id, r->kind) < 0) return;
    if (r->kind == MES_READ_GOOD || r->kind == MES_READ_SCRAP) {
        ESP_LOGD(TAG, "[%s] part event %s", c->def.machine_id, r->kind == MES_READ_GOOD ? "good" : "scrap");
        hw_led_flash();
    } else {
        ESP_LOGI(TAG, "[%s] machine status changed: %s (sourceEventId %s)", c->def.machine_id, r->kind == MES_READ_RUNNING ? "running" : "down", id);
    }
    push_line(c, line, id);
}

static void on_reading(void *ctx, const mes_reading_t *r)
{
    chan_t *c = ctx;
    if (s_time_trusted) {
        store_reading(c, r);
        return;
    }
    /* No valid time yet (RTC empty and no answer from the server): keep the reading with its monotonic time and stamp it
     * when the time is known, instead of sending events dated 1970 (chaos finding 37 on node-gate). */
    if (!c->unstamped) c->unstamped = psram_alloc(MAX_UNSTAMPED * sizeof *c->unstamped);
    if (c->unstamped && c->n_unstamped < MAX_UNSTAMPED) {
        c->unstamped[c->n_unstamped++] = *r;
    } else if (r->kind == MES_READ_GOOD) {
        c->lost_unstamped_good++;
    } else if (r->kind == MES_READ_SCRAP) {
        c->lost_unstamped_scrap++;
    }
}

static void time_became_trusted(const char *source)
{
    if (s_time_trusted) return;
    s_time_trusted = true;
    char iso[32];
    mes_iso8601(wall_now(), iso);
    ESP_LOGI(TAG, "the time is known (%s): %s", source, iso);
    for (size_t i = 0; i < s_nch; i++) {
        chan_t *c = &s_ch[i];
        if (c->n_unstamped) ESP_LOGI(TAG, "[%s] %u readings made before the time was known are stamped now", c->def.machine_id, (unsigned)c->n_unstamped);
        for (size_t k = 0; k < c->n_unstamped; k++) store_reading(c, &c->unstamped[k]);
        c->n_unstamped = 0;
        if (c->lost_unstamped_good + c->lost_unstamped_scrap) push_data_gap(c, "clock_unknown", c->lost_unstamped_good, c->lost_unstamped_scrap);
        c->lost_unstamped_good = c->lost_unstamped_scrap = 0;
    }
}

/* ---------------- clock ---------------- */

static void refresh_rtc(bool force)
{
    int64_t now = mono_now();
    if (!force && now - s_rtc_written_at < RTC_REFRESH_MS) return;
    if (hw_rtc_write(wall_now()) == ESP_OK) s_rtc_written_at = now;
}

/** The I/O node has no other clock than the RTC: the server's time sets it (node-gate corrects its stamps instead, v13). */
static void apply_server_time(bool has, int64_t server_ms, int64_t sent_wall, int64_t rtt)
{
    int64_t ahead;
    if (!has || !mes_measure_ahead(sent_wall, rtt, server_ms, &ahead)) return;
    /* The error of one measurement is up to half the round trip: once the time is known, only a fast answer may step it. */
    if (s_time_trusted && rtt > PRECISE_RTT_MS) return;
    if (mes_clock_needs_step(ahead)) {
        set_wall(wall_now() - ahead);
        if (s_time_trusted || ahead > MES_CLOCK_WARN_MS || ahead < -MES_CLOCK_WARN_MS)
            ESP_LOGW(TAG, "The clock of this device was %lld s %s the server's; it is set to the server time", (long long)(llabs(ahead) / 1000),
                     ahead > 0 ? "ahead of" : "behind");
        refresh_rtc(true);
    } else {
        refresh_rtc(false);
    }
    time_became_trusted("server time");
}

static void on_sntp(void)
{
    msg_t m = {.type = MSG_SNTP};
    plat_queue_send(s_msgs, &m, 0);
    plat_agent_notify();
}

/* ---------------- channels and buffers ---------------- */

static void queue_dir(const char *machine_id, char *out, size_t cap) { snprintf(out, cap, QUEUE_ROOT "/%08x", (unsigned)mes_fnv1a(machine_id)); }

static size_t compute_budget(size_t nqueues)
{
    size_t ram = plat_big_free();
    size_t total = ram ? ram / 2 : 64 * 1024;
    if (total > 4 * 1024 * 1024) total = 4 * 1024 * 1024;
    size_t fs_total, fs_used;
    hw_storage_usage(&fs_total, &fs_used);
    if (fs_total && total > fs_total * 6 / 10) total = fs_total * 6 / 10;
    return total / (nqueues ? nqueues : 1);
}

static void subscribe_all(void)
{
    for (size_t i = 0; i < s_nch; i++) net_mqtt_subscribe(s_ch[i].ack_topic);
    for (size_t i = 0; i < s_norph; i++) net_mqtt_subscribe(s_orph[i].ack_topic);
}

static void open_orphans(void)
{
    DIR *d = opendir(QUEUE_ROOT);
    if (!d) return;
    struct dirent *de;
    while ((de = readdir(d)) != NULL && s_norph < MAX_ORPHANS) {
        if (de->d_name[0] == '.' || strlen(de->d_name) > 32) continue;
        char dir[128];
        snprintf(dir, sizeof dir, QUEUE_ROOT "/%.32s", de->d_name);
        bool used = false;
        for (size_t i = 0; i < s_nch; i++)
            if (strcmp(mes_queue_dir(s_ch[i].q), dir) == 0) used = true;
        if (used) continue;
        mes_queue_t *q = mes_queue_open(dir, NULL, 1 << 20);
        if (!q) continue; /* empty: removed */
        orphan_t *o = &s_orph[s_norph++];
        o->q = q;
        mes_event_topic(o->topic, sizeof o->topic, mes_queue_machine_id(q));
        mes_ack_topic(o->ack_topic, sizeof o->ack_topic, mes_queue_machine_id(q));
        ESP_LOGW(TAG, "[%s] buffer of a channel that no longer exists: %u events are sent before it is removed", mes_queue_machine_id(q),
                 (unsigned)mes_queue_pending(q));
    }
    closedir(d);
}

static void setup_channels(const mes_claim_t *c)
{
    mkdir(QUEUE_ROOT, 0775);
    s_active = *c;
    s_nch = 0;
    for (size_t i = 0; i < c->n_channels; i++) {
        chan_t *ch = &s_ch[s_nch];
        memset(ch, 0, sizeof *ch);
        ch->def = c->channels[i];
        char dir[128];
        queue_dir(ch->def.machine_id, dir, sizeof dir);
        bool dup = false;
        for (size_t k = 0; k < s_nch; k++)
            if (strcmp(mes_queue_dir(s_ch[k].q), dir) == 0) dup = true;
        if (dup) {
            ESP_LOGE(TAG, "[%s] a second channel for the same machine is ignored", ch->def.machine_id);
            continue;
        }
        ch->q = mes_queue_open(dir, ch->def.machine_id, 1 << 20);
        if (!ch->q) {
            ESP_LOGE(TAG, "[%s] the buffer cannot be opened", ch->def.machine_id);
            continue;
        }
        mes_event_topic(ch->topic, sizeof ch->topic, ch->def.machine_id);
        mes_ack_topic(ch->ack_topic, sizeof ch->ack_topic, ch->def.machine_id);
        if (mes_queue_load_skipped(ch->q)) ESP_LOGW(TAG, "[%s] %u unreadable buffer lines dropped (cut by a power loss)", ch->def.machine_id,
                                                    (unsigned)mes_queue_load_skipped(ch->q));
        s_nch++;
    }
    open_orphans();
    s_queue_budget = compute_budget(s_nch + s_norph);
    for (size_t i = 0; i < s_nch; i++) mes_queue_set_cap(s_ch[i].q, s_queue_budget);
    for (size_t i = 0; i < s_norph; i++) mes_queue_set_cap(s_orph[i].q, s_queue_budget);

    uint8_t levels = di_levels();
    int64_t now = mono_now();
    for (size_t i = 0; i < s_nch; i++) {
        chan_t *ch = &s_ch[i];
        const mes_chan_cfg_t *k = &ch->def.cfg;
        if (ch->def.problem[0]) {
            ESP_LOGE(TAG, "[%s] channel not started: %s", ch->def.machine_id, ch->def.problem);
            continue;
        }
        if (k->status_mode == MES_STATUS_BIT && !k->status_di)
            ESP_LOGW(TAG, "[%s] status_bit mode without a status input: only parts are reported (use \"signal presence\" for a status)",
                     ch->def.machine_id);
        ch->runs = true;
        ESP_LOGI(TAG, "[%s] channel started: good DI%u, scrap DI%u, status DI%u, %s, debounce %u / %u ms; %u events buffered", ch->def.machine_id,
                 k->good_di, k->scrap_di, k->status_di, k->status_mode == MES_SIGNAL_PRESENCE ? "signal presence" : "status bit",
                 (unsigned)k->count_debounce_ms, (unsigned)k->status_debounce_ms, (unsigned)mes_queue_pending(ch->q));
        mes_chan_start(&ch->logic, k, levels, now, on_reading, ch);
    }
    if (c->n_ignored) ESP_LOGW(TAG, "%u channels without a machine (or beyond %d) are ignored", (unsigned)c->n_ignored, MES_MAX_CHANNELS);
    ESP_LOGI(TAG, "buffer limit %u KiB per machine", (unsigned)(s_queue_budget / 1024));
    s_channels_set = true;
    subscribe_all();
}

static bool same_channels(const mes_claim_t *a, const mes_claim_t *b)
{
    if (a->n_channels != b->n_channels) return false;
    for (size_t i = 0; i < a->n_channels; i++) {
        const mes_channel_t *x = &a->channels[i], *y = &b->channels[i];
        if (strcmp(x->machine_id, y->machine_id) || x->source != y->source || strcmp(x->problem, y->problem) || memcmp(&x->cfg, &y->cfg, sizeof x->cfg))
            return false;
    }
    return true;
}

static void sync_all(bool force)
{
    int64_t now = mono_now();
    for (size_t i = 0; i < s_nch; i++) mes_queue_tick(s_ch[i].q, now, force);
    for (size_t i = 0; i < s_norph; i++) mes_queue_tick(s_orph[i].q, now, force);
}

/* ---------------- backend requests ---------------- */

static void http_worker(void *arg)
{
    (void)arg;
    for (;;) {
        http_req_t r;
        if (!plat_queue_recv(s_http_reqs, &r, 60000)) continue;
        const char *path = r.kind == HTTP_CLAIM ? "/api/edge-nodes/claim" : "/api/edge-nodes/heartbeat";
        int64_t sent_wall = wall_now(), t0 = mono_now();
        char *resp = NULL;
        int status = net_https_post(P, path, r.body, MES_CLAIM_TIMEOUT_MS, &resp);
        msg_t m = {.type = MSG_HTTP};
        m.http.kind = r.kind;
        m.http.status = status;
        m.http.body = resp;
        m.http.sent_wall = sent_wall;
        m.http.rtt = mono_now() - t0;
        free(r.body);
        while (!plat_queue_send(s_msgs, &m, 1000)) {}
        plat_agent_notify();
    }
}

static void request(http_kind_t kind)
{
    /* Without a known time the device clock is not sent: the backend would show (and alert on) a 1970 offset. */
    int64_t client_time = s_time_trusted ? wall_now() : -1;
    char *body = kind == HTTP_CLAIM ? mes_body_claim(P->token, client_time, s_cert_expires_ms, plat_version())
                                    : mes_body_heartbeat(P->token, s_session, client_time, s_cert_expires_ms);
    if (!body) return;
    http_req_t r = {.kind = kind, .body = body};
    if (!plat_queue_send(s_http_reqs, &r, 0)) {
        free(body);
        return;
    }
    s_http_busy = true;
    s_http_since = mono_now();
}

static void release_session(void)
{
    if (!s_has_session) return;
    char *body = mes_body_release(P->token, s_session);
    char *resp = NULL;
    int st = body ? net_https_post(P, "/api/edge-nodes/release", body, MES_RELEASE_TIMEOUT_MS, &resp) : 0;
    if (!mes_http_ok(st)) ESP_LOGW(TAG, "could not release the edge node session (HTTP %d; the next start may wait up to 90 s)", st);
    free(body);
    free(resp);
    s_has_session = false;
}

/** node-gate exits and systemd starts it again; here the box reboots (the buffers are on flash). */
static void restart_box(const char *reason, bool release)
{
    ESP_LOGW(TAG, "restarting the agent: %s", reason);
    for (size_t i = 0; i < s_nch; i++) report_drops(&s_ch[i], mono_now(), true);
    sync_all(true);
    if (release) release_session();
    plat_sleep_ms(200);
    plat_restart();
}

static void save_cache(const char *claim_body)
{
    char *file = mes_cache_encode(P->token, wall_now(), claim_body);
    if (!file) return;
    FILE *f = fopen(CLAIM_CACHE_PATH ".tmp", "w");
    bool ok = f && fputs(file, f) >= 0;
    if (f) {
        fflush(f);
        fsync(fileno(f));
        fclose(f);
    }
    ok = ok && rename(CLAIM_CACHE_PATH ".tmp", CLAIM_CACHE_PATH) == 0;
    if (!ok) ESP_LOGW(TAG, "could not save the claim cache — an offline start will not be possible until it can be written");
    free(file);
}

static bool load_cache(mes_claim_t *out)
{
    FILE *f = fopen(CLAIM_CACHE_PATH, "r");
    if (!f) {
        ESP_LOGE(TAG, "no cached configuration (this node never claimed with this firmware)");
        return false;
    }
    char *buf = malloc(64 * 1024);
    size_t n = buf ? fread(buf, 1, 64 * 1024 - 1, f) : 0;
    fclose(f);
    if (!buf) return false;
    buf[n] = 0;
    int64_t age;
    mes_cache_result_t r = mes_cache_decode(buf, P->token, s_time_trusted ? wall_now() : -1, MES_CLAIM_CACHE_MAX_AGE_MS, out, &age);
    free(buf);
    if (r != MES_CACHE_OK) {
        ESP_LOGE(TAG, "no usable cached configuration (%s)", mes_cache_result_text(r));
        return false;
    }
    if (age >= 0) ESP_LOGI(TAG, "cached configuration from %lld s ago", (long long)(age / 1000));
    return true;
}

static void start_mqtt_once(void)
{
    static bool started;
    if (started) return;
    started = true;
    if (net_mqtt_start(P, agent_on_mqtt, agent_on_mqtt_data) != ESP_OK) ESP_LOGE(TAG, "the MQTT client could not be started");
}

static void schedule_claim(void)
{
    int64_t wait = mes_backoff_ms(s_claim_attempt++);
    s_next_claim_at = mono_now() + wait;
}

static void adopt_lease(const mes_claim_t *c)
{
    s_has_session = true;
    snprintf(s_session, sizeof s_session, "%s", c->session_id);
    s_has_revision = c->has_revision;
    snprintf(s_revision, sizeof s_revision, "%s", c->revision);
    s_background_claim = false;
    s_offline_start = false;
    s_hold_publish = false;
    s_claim_attempt = 0;
    mes_rejection_reset(&s_rej);
    mes_restart_decider_init(&s_restart);
    s_next_claim_at = INT64_MAX;
    s_next_heartbeat_at = mono_now() + MES_HEARTBEAT_INTERVAL_MS;
}

static void on_claim_answer(const msg_t *m)
{
    mes_claim_t c;
    if (mes_http_ok(m->http.status) && m->http.body && mes_parse_claim(m->http.body, &c)) {
        apply_server_time(c.has_server_time, c.server_time_ms, m->http.sent_wall, m->http.rtt);
        if (!s_channels_set) {
            adopt_lease(&c);
            ESP_LOGI(TAG, "claimed edge node, starting channels (channelCount %u, catchupMaxMinutes %d)", (unsigned)c.n_channels, c.catchup_max_minutes);
            save_cache(m->http.body);
            setup_channels(&c);
            start_mqtt_once();
            return;
        }
        save_cache(m->http.body);
        if (!same_channels(&s_active, &c)) {
            adopt_lease(&c); /* so that the reboot hands it back */
            ESP_LOGW(TAG, "channel configuration changed while the node was offline (before %u, after %u)", (unsigned)s_active.n_channels,
                     (unsigned)c.n_channels);
            restart_box("the channel configuration changed while offline", true);
        }
        bool was_offline_start = s_offline_start, was_holding = s_hold_publish;
        adopt_lease(&c);
        ESP_LOGI(TAG, "%s (channelCount %u)",
                 was_holding         ? "claimed edge node — lease granted, sending the buffered events"
                 : was_offline_start ? "claimed edge node after an offline start — lease adopted"
                                     : "claimed edge node again after the lease was lost — lease adopted",
                 (unsigned)c.n_channels);
        if (was_holding) {
            for (size_t i = 0; i < s_nch; i++) mes_queue_reset_sent(s_ch[i].q);
        }
        return;
    }

    int st = m->http.status;
    const char *err = m->http.body ? m->http.body : "";
    if (mes_classify_claim_failure(st) == MES_FAIL_REJECTED) {
        bool give_up = mes_rejection_note(&s_rej, mono_now());
        if (give_up) {
            if (s_channels_set)
                ESP_LOGE(TAG, "the backend does not give this node its lease — stopping channels (another instance probably owns the node); buffered events stay on flash");
            else
                ESP_LOGE(TAG, "the backend keeps rejecting the claim (HTTP %d %.120s)", st, err);
            restart_box("the backend keeps rejecting the claim", false);
        }
        schedule_claim();
        if (!s_channels_set) {
            /* After a power cut or a crash the old lease stays fresh for up to 90 s and the claim is refused (409). node-gate
             * starts no channel then (its PLC counters are caught up afterwards); this box counts the pulses itself, so it
             * collects into the buffer from the cached configuration meanwhile, but sends nothing until it has the lease. */
            mes_claim_t cached;
            if (load_cache(&cached)) {
                ESP_LOGW(TAG, "the backend rejected the claim (HTTP %d %.120s) — collecting into the buffer from the cached configuration; nothing is sent until the lease is granted (the lease of a crashed instance of this node expires after 90 s)",
                         st, err);
                s_hold_publish = true;
                s_background_claim = true;
                s_has_revision = false;
                setup_channels(&cached);
                start_mqtt_once();
                return;
            }
        }
        if (s_channels_set)
            ESP_LOGW(TAG, "background claim failed — still running; the lease is held by someone else or is not free yet (HTTP %d, next in %lld s)", st,
                     (long long)((s_next_claim_at - mono_now()) / 1000));
        else
            ESP_LOGW(TAG, "the backend rejected the claim — no channel is started; asking again (HTTP %d %.120s, next in %lld s; the lease of a crashed instance of this node expires after 90 s)",
                     st, err, (long long)((s_next_claim_at - mono_now()) / 1000));
        return;
    }

    /* unreachable */
    if (!s_channels_set) {
        mes_claim_t cached;
        if (load_cache(&cached)) {
            ESP_LOGW(TAG, "backend unreachable — starting channels from the cached configuration WITHOUT a lease; will keep trying to claim (channelCount %u)",
                     (unsigned)cached.n_channels);
            s_background_claim = true;
            s_offline_start = true;
            s_has_revision = false; /* no revision before a claim: only an explicit restart request restarts the box */
            setup_channels(&cached);
            start_mqtt_once();
            s_claim_attempt = 0;
            schedule_claim();
            return;
        }
        schedule_claim();
        ESP_LOGW(TAG, "claim failed (HTTP %d, %s) — next attempt in %lld s", st, st ? "server error" : "no answer", (long long)((s_next_claim_at - mono_now()) / 1000));
        return;
    }
    schedule_claim();
    ESP_LOGW(TAG, "background claim failed — still running from the cached configuration (HTTP %d, next in %lld s)", st,
             (long long)((s_next_claim_at - mono_now()) / 1000));
}

static void on_heartbeat_answer(const msg_t *m)
{
    s_next_heartbeat_at = mono_now() + MES_HEARTBEAT_INTERVAL_MS;
    if (mes_http_ok(m->http.status)) {
        mes_heartbeat_answer_t hb;
        mes_parse_heartbeat(m->http.body, &hb);
        apply_server_time(hb.has_server_time, hb.server_time_ms, m->http.sent_wall, m->http.rtt);
        mes_restart_reason_t why = mes_restart_decide(&s_restart, mono_now(), s_has_revision ? s_revision : NULL, hb.has_revision ? hb.revision : NULL,
                                                      hb.restart_requested);
        if (why != MES_RESTART_NONE) restart_box(mes_restart_reason_text(why), true);
        return;
    }
    if (mes_classify_heartbeat_failure(m->http.status) == MES_HB_LEASE_LOST) {
        ESP_LOGW(TAG, "the backend no longer accepts this node's lease (HTTP %d: another instance claimed the node, or the token is not valid any more) — claiming again; the channels keep running and the events stay buffered",
                 m->http.status);
        s_has_session = false;
        s_background_claim = true;
        s_next_heartbeat_at = INT64_MAX;
        s_claim_attempt = 0;
        mes_rejection_reset(&s_rej);
        schedule_claim();
        return;
    }
    ESP_LOGW(TAG, "heartbeat failed (HTTP %d) — will retry next tick", m->http.status);
}

/* ---------------- MQTT callbacks (client task) ---------------- */

void agent_on_mqtt(bool connected)
{
    msg_t m = {.type = MSG_MQTT, .connected = connected};
    plat_queue_send(s_msgs, &m, 0);
    plat_agent_notify();
}

void agent_on_mqtt_data(const char *topic, size_t topic_len, const char *data, size_t data_len)
{
    msg_t m = {.type = MSG_ACK};
    if (!mes_machine_of_ack_topic(topic, topic_len, m.ack.machine, sizeof m.ack.machine)) return;
    if (!mes_parse_ack(data, data_len, m.ack.id, sizeof m.ack.id)) return;
    if (plat_queue_send(s_msgs, &m, 0)) plat_agent_notify(); /* full: the event is sent again and acked again */
}

static void on_ack(const msg_t *m)
{
    for (size_t i = 0; i < s_nch; i++)
        if (strcmp(s_ch[i].def.machine_id, m->ack.machine) == 0) {
            mes_queue_ack(s_ch[i].q, m->ack.id);
            return;
        }
    for (size_t i = 0; i < s_norph; i++)
        if (strcmp(mes_queue_machine_id(s_orph[i].q), m->ack.machine) == 0) {
            mes_queue_ack(s_orph[i].q, m->ack.id);
            return;
        }
}

static void sweep_all(int64_t now)
{
    if (!net_mqtt_connected()) return;
    for (size_t i = 0; i < s_nch; i++) mes_queue_sweep(s_ch[i].q, now, MES_RETRY_MAX_BATCH, send_to, s_ch[i].topic);
    for (size_t i = 0; i < s_norph; i++) mes_queue_sweep(s_orph[i].q, now, MES_RETRY_MAX_BATCH, send_to, s_orph[i].topic);
}

static void drop_finished_orphans(void)
{
    for (size_t i = 0; i < s_norph;) {
        if (mes_queue_pending(s_orph[i].q) == 0) {
            ESP_LOGI(TAG, "[%s] the buffer of the removed channel is empty — deleted", mes_queue_machine_id(s_orph[i].q));
            net_mqtt_unsubscribe(s_orph[i].ack_topic);
            mes_queue_destroy(s_orph[i].q);
            s_orph[i] = s_orph[--s_norph];
            continue;
        }
        i++;
    }
}

/* ---------------- misc ---------------- */

static int64_t read_cert_expiry(const char *pem)
{
    int64_t ms = plat_cert_expiry_ms(pem);
    if (ms > 0) {
        char iso[32];
        mes_iso8601(ms, iso);
        ESP_LOGI(TAG, "device certificate valid until %s", iso);
    } else {
        ESP_LOGE(TAG, "the device certificate cannot be read");
    }
    return ms;
}

static void log_status(void)
{
    size_t fs_total, fs_used;
    hw_storage_usage(&fs_total, &fs_used);
    ESP_LOGI(TAG, "status: ip %s, lease %s, broker %s, time %s, heap %u KiB internal / %u KiB PSRAM free, flash %u / %u KiB used, input overflows %u",
             net_has_ip() ? "yes" : "no", s_has_session ? "yes" : "no", net_mqtt_connected() ? "up" : "down", s_time_trusted ? "known" : "unknown",
             (unsigned)(plat_internal_free() / 1024), (unsigned)(plat_big_free() / 1024),
             (unsigned)(fs_used / 1024), (unsigned)(fs_total / 1024), (unsigned)di_overflows());
    for (size_t i = 0; i < s_nch; i++)
        ESP_LOGI(TAG, "  [%s] %s, %u events buffered (%u KiB of %u)", s_ch[i].def.machine_id, s_ch[i].runs ? "running" : "NOT started",
                 (unsigned)mes_queue_pending(s_ch[i].q), (unsigned)(mes_queue_bytes(s_ch[i].q) / 1024), (unsigned)(mes_queue_cap(s_ch[i].q) / 1024));
}

static void update_led(void)
{
    if (!net_has_ip()) {
        hw_led_set(LED_NO_NETWORK);
        return;
    }
    if (!s_has_session || !net_mqtt_connected()) {
        hw_led_set(LED_CONNECTING);
        return;
    }
    for (size_t i = 0; i < s_nch; i++)
        if (mes_queue_bytes(s_ch[i].q) > mes_queue_cap(s_ch[i].q) / 10 * 8) {
            hw_led_set(LED_BUFFER_HIGH);
            return;
        }
    hw_led_set(LED_OK);
}

/* ---------------- main loop ---------------- */

void agent_run(prov_t *p)
{
    P = p;
    plat_agent_bind();
    mes_queue_set_allocator(psram_alloc, free);
    s_msgs = plat_queue_new(160, sizeof(msg_t));
    s_http_reqs = plat_queue_new(2, sizeof(http_req_t));
    mes_rejection_reset(&s_rej);
    mes_restart_decider_init(&s_restart);
    ESP_LOGI(TAG, "MES I/O node %s, node \"%s\"", plat_version(), p->node_name);
    s_cert_expires_ms = read_cert_expiry(p->cert_pem);

    int64_t rtc_ms;
    if (hw_rtc_read(&rtc_ms)) {
        set_wall(rtc_ms);
        time_became_trusted("real-time clock");
    } else {
        ESP_LOGW(TAG, "the real-time clock has no valid time (battery?); events wait for the server time before they are stamped");
    }
    if (p->ntp_server[0]) plat_sntp_start(p->ntp_server, on_sntp);

    if (di_start(p->di_active_low, &s_edges) != ESP_OK) {
        ESP_LOGE(TAG, "the inputs cannot be read");
        plat_sleep_ms(5000);
        plat_restart();
    }
    plat_thread(http_worker, "backend", 8192, NULL);
    plat_wdt_add();

    int64_t next_sweep = 0, next_tick = 0, next_status = mono_now() + 60000, next_led = 0;
    uint32_t raw_logged = 0;
    int64_t raw_window = 0;

    for (;;) {
        plat_wdt_feed();
        int64_t now = mono_now();

        /* inputs first: their own timestamps keep the order right however late they are handled */
        di_edge_t e;
        while (plat_queue_recv(s_edges, &e, 0)) {
            if (e.t_ms < RAW_DI_LOG_MS) {
                if (e.t_ms / 1000 != raw_window) {
                    raw_window = e.t_ms / 1000;
                    raw_logged = 0;
                }
                if (raw_logged++ < 20) ESP_LOGI(TAG, "DI%u %s", e.di, e.active ? "active" : "inactive");
            }
            for (size_t i = 0; i < s_nch; i++)
                if (s_ch[i].runs) mes_chan_edge(&s_ch[i].logic, e.di, e.active, e.t_ms);
        }
        now = mono_now();
        for (size_t i = 0; i < s_nch; i++)
            if (s_ch[i].runs) mes_chan_poll(&s_ch[i].logic, now);

        msg_t m;
        for (int k = 0; k < 64 && plat_queue_recv(s_msgs, &m, 0); k++) {
            switch (m.type) {
            case MSG_ACK: on_ack(&m); break;
            case MSG_MQTT:
                if (m.connected) {
                    subscribe_all();
                    for (size_t i = 0; i < s_nch; i++) mes_queue_reset_sent(s_ch[i].q);
                    for (size_t i = 0; i < s_norph; i++) mes_queue_reset_sent(s_orph[i].q);
                    next_sweep = 0;
                }
                break;
            case MSG_HTTP:
                s_http_busy = false;
                if (m.http.kind == HTTP_CLAIM) on_claim_answer(&m);
                else on_heartbeat_answer(&m);
                free(m.http.body);
                break;
            case MSG_SNTP:
                refresh_rtc(true);
                time_became_trusted("NTP");
                break;
            }
        }

        now = mono_now();
        if (!s_http_busy) {
            if ((!s_channels_set || s_background_claim) && now >= s_next_claim_at && net_has_ip()) request(HTTP_CLAIM);
            else if (s_has_session && now >= s_next_heartbeat_at) request(HTTP_HEARTBEAT);
        } else if (now - s_http_since > HTTP_HANG_MS) {
            restart_box("a request to the backend hung", false);
        }
        if (now >= next_sweep) {
            next_sweep = now + SWEEP_INTERVAL_MS;
            sweep_all(now);
            drop_finished_orphans();
        }
        if (now >= next_tick) {
            next_tick = now + TICK_INTERVAL_MS;
            sync_all(false);
            for (size_t i = 0; i < s_nch; i++) report_drops(&s_ch[i], now, false);
        }
        if (now >= next_led) {
            next_led = now + 50;
            update_led();
            hw_led_tick(now);
        }
        if (now >= next_status) {
            next_status = now + STATUS_LOG_INTERVAL_MS;
            log_status();
        }
        if (s_time_trusted) refresh_rtc(false);
        plat_agent_wait(5);
    }
}
