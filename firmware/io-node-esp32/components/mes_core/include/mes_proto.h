#pragma once
/*
 * The wire contract with the backend, as node-gate speaks it:
 *  - MQTT events (packages/shared/src/events.ts) on mes/machines/<id>/events, acks on .../acks;
 *  - HTTP claim / heartbeat / release (packages/edge-agent/src/index.ts, backend edge-node routes);
 *  - the claim cache (claim-cache.ts: start from the last configuration when the backend is unreachable).
 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "mes_signal.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MES_MAX_CHANNELS 8
#define MES_MACHINE_ID_MAX 64
#define MES_CLAIM_CACHE_MAX_AGE_MS (168LL * 3600 * 1000) /* CLAIM_CACHE_MAX_AGE_HOURS default */

/* ---- events ---- */

/** One event as a JSON line. Returns its length, or -1 if `cap` is too small. */
int mes_event_reading(char *out, size_t cap, const char *machine_id, int64_t epoch_ms, const char *source_event_id, mes_reading_kind_t kind);
/** A `data_gap` event (parts that could not be booked). `gap_seconds` < 0 together with `gap_known` false = null. */
int mes_event_data_gap(char *out, size_t cap, const char *machine_id, int64_t epoch_ms, const char *source_event_id, const char *reason,
                       bool gap_known, int64_t gap_seconds, uint32_t lost_good, uint32_t lost_scrap);

void mes_event_topic(char *out, size_t cap, const char *machine_id);
void mes_ack_topic(char *out, size_t cap, const char *machine_id);
/** The machine id of an ack topic "mes/machines/<id>/acks"; false otherwise. */
bool mes_machine_of_ack_topic(const char *topic, size_t topic_len, char *out, size_t cap);
/** The sourceEventId of an ack message {"sourceEventId":"..."}; false if it is not one. */
bool mes_parse_ack(const char *data, size_t len, char *out, size_t cap);

/* ---- claim ---- */

typedef enum { MES_SRC_GPIO = 0, MES_SRC_UNSUPPORTED } mes_source_t;

typedef struct {
    char machine_id[MES_MACHINE_ID_MAX + 1];
    mes_source_t source;
    char source_name[16];
    mes_chan_cfg_t cfg;
    char problem[96]; /* why the channel cannot run on this box; empty = runs */
} mes_channel_t;

typedef struct {
    char session_id[96];
    bool has_server_time;
    int64_t server_time_ms;
    bool has_revision;
    char revision[48];
    int catchup_max_minutes;
    size_t n_channels;
    mes_channel_t channels[MES_MAX_CHANNELS];
    size_t n_ignored; /* channels without a machine, or beyond MES_MAX_CHANNELS */
} mes_claim_t;

/** Parses the claim answer (also the cached copy, which has no session). False if it is not a claim answer. */
bool mes_parse_claim(const char *body, mes_claim_t *out);

/**
 * A gpio pin of this box: 1..8, also as text "3", "DI3", "di 3", "in3". 0 = not set; -1 = set but not an input
 * of this box. (node-gate's GPIO pins are Raspberry Pi pin numbers; here they are the terminals DI1..DI8.)
 */
int mes_parse_di(const void *cjson_item);

typedef struct {
    bool has_server_time;
    int64_t server_time_ms;
    bool has_revision;
    char revision[48];
    bool restart_requested;
} mes_heartbeat_answer_t;

bool mes_parse_heartbeat(const char *body, mes_heartbeat_answer_t *out);

/** Request bodies; malloc'ed, the caller frees. `client_time_ms` < 0 and `cert_expires_ms` <= 0 = leave them out. */
char *mes_body_claim(const char *token, int64_t client_time_ms, int64_t cert_expires_ms, const char *agent_version);
char *mes_body_heartbeat(const char *token, const char *session_id, int64_t client_time_ms, int64_t cert_expires_ms);
char *mes_body_release(const char *token, const char *session_id);

/* ---- claim cache ---- */

/** The cache file: the claim answer, bound to the token (only its SHA-256 is stored) and stamped with the time. */
char *mes_cache_encode(const char *token, int64_t saved_at_ms, const char *claim_body);

typedef enum { MES_CACHE_OK, MES_CACHE_BAD, MES_CACHE_OTHER_TOKEN, MES_CACHE_TOO_OLD } mes_cache_result_t;
/**
 * Decodes the cache into `out`. `now_ms` < 0 = the time is unknown (no RTC, no server yet): the age is not checked.
 * `*age_ms` is set when known, else -1.
 */
mes_cache_result_t mes_cache_decode(const char *file, const char *token, int64_t now_ms, int64_t max_age_ms, mes_claim_t *out, int64_t *age_ms);
const char *mes_cache_result_text(mes_cache_result_t r);

#ifdef __cplusplus
}
#endif
