#include "mes_proto.h"

#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "mes_util.h"

/* ---- events ---- */

static const char *kind_fields(mes_reading_kind_t k)
{
    switch (k) {
    case MES_READ_GOOD: return "\"type\":\"production_count\",\"result\":\"good\"";
    case MES_READ_SCRAP: return "\"type\":\"production_count\",\"result\":\"scrap\"";
    case MES_READ_RUNNING: return "\"type\":\"machine_status\",\"status\":\"running\"";
    default: return "\"type\":\"machine_status\",\"status\":\"down\"";
    }
}

static int envelope(char *out, size_t cap, const char *machine_id, int64_t epoch_ms, const char *id)
{
    char mid[2 * MES_MACHINE_ID_MAX + 8];
    char ts[32];
    if (mes_json_escape(machine_id, mid, sizeof mid) < 0) return -1;
    mes_iso8601(epoch_ms, ts);
    int n = snprintf(out, cap, "{\"machineId\":\"%s\",\"timestamp\":\"%s\",\"sourceEventId\":\"%s\",", mid, ts, id);
    return n < 0 || (size_t)n >= cap ? -1 : n;
}

int mes_event_reading(char *out, size_t cap, const char *machine_id, int64_t epoch_ms, const char *id, mes_reading_kind_t kind)
{
    int n = envelope(out, cap, machine_id, epoch_ms, id);
    if (n < 0) return -1;
    int m = snprintf(out + n, cap - (size_t)n, "%s}", kind_fields(kind));
    return m < 0 || (size_t)m >= cap - (size_t)n ? -1 : n + m;
}

int mes_event_data_gap(char *out, size_t cap, const char *machine_id, int64_t epoch_ms, const char *id, const char *reason, bool gap_known,
                       int64_t gap_seconds, uint32_t lost_good, uint32_t lost_scrap)
{
    int n = envelope(out, cap, machine_id, epoch_ms, id);
    if (n < 0) return -1;
    char rs[64], gap[24];
    if (mes_json_escape(reason, rs, sizeof rs) < 0) return -1;
    if (gap_known) snprintf(gap, sizeof gap, "%lld", (long long)gap_seconds);
    else strcpy(gap, "null");
    int m = snprintf(out + n, cap - (size_t)n, "\"type\":\"data_gap\",\"reason\":\"%s\",\"gapSeconds\":%s,\"lostGood\":%u,\"lostScrap\":%u}", rs, gap,
                     (unsigned)lost_good, (unsigned)lost_scrap);
    return m < 0 || (size_t)m >= cap - (size_t)n ? -1 : n + m;
}

void mes_event_topic(char *out, size_t cap, const char *machine_id) { snprintf(out, cap, "mes/machines/%s/events", machine_id); }
void mes_ack_topic(char *out, size_t cap, const char *machine_id) { snprintf(out, cap, "mes/machines/%s/acks", machine_id); }

bool mes_machine_of_ack_topic(const char *topic, size_t len, char *out, size_t cap)
{
    static const char pre[] = "mes/machines/", post[] = "/acks";
    const size_t lp = sizeof pre - 1, ls = sizeof post - 1;
    if (len <= lp + ls || strncmp(topic, pre, lp) != 0 || strncmp(topic + len - ls, post, ls) != 0) return false;
    size_t n = len - lp - ls;
    if (n + 1 > cap || memchr(topic + lp, '/', n)) return false;
    memcpy(out, topic + lp, n);
    out[n] = 0;
    return true;
}

bool mes_parse_ack(const char *data, size_t len, char *out, size_t cap)
{
    cJSON *j = cJSON_ParseWithLength(data, len);
    if (!j) return false;
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(j, "sourceEventId");
    bool ok = cJSON_IsString(id) && id->valuestring[0] && strlen(id->valuestring) < cap;
    if (ok) strcpy(out, id->valuestring);
    cJSON_Delete(j);
    return ok;
}

/* ---- claim ---- */

static bool get_ms(const cJSON *o, const char *key, int64_t *out)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
    if (!cJSON_IsNumber(v) || !isfinite(v->valuedouble)) return false;
    *out = (int64_t)llround(v->valuedouble);
    return true;
}

static bool get_str(const cJSON *o, const char *key, char *out, size_t cap)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
    if (!cJSON_IsString(v) || strlen(v->valuestring) >= cap) return false;
    strcpy(out, v->valuestring);
    return true;
}

int mes_parse_di(const void *item)
{
    const cJSON *v = (const cJSON *)item;
    if (!v || cJSON_IsNull(v)) return 0;
    if (cJSON_IsNumber(v)) {
        double d = v->valuedouble;
        if (d >= 1 && d <= MES_DI_COUNT && d == floor(d)) return (int)d;
        return -1;
    }
    if (!cJSON_IsString(v)) return -1;
    const char *s = v->valuestring;
    while (isspace((unsigned char)*s)) s++;
    if (*s == 0) return 0;
    if ((tolower((unsigned char)s[0]) == 'd' || tolower((unsigned char)s[0]) == 'i') &&
        (tolower((unsigned char)s[1]) == 'i' || tolower((unsigned char)s[1]) == 'n'))
        s += 2;
    while (isspace((unsigned char)*s) || *s == '-' || *s == '_') s++;
    char *end;
    long n = strtol(s, &end, 10);
    while (isspace((unsigned char)*end)) end++;
    if (end == s || *end != 0 || n < 1 || n > MES_DI_COUNT) return -1;
    return (int)n;
}

static uint32_t opt_ms(const cJSON *cc, const char *key, uint32_t def, uint32_t max)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(cc, key);
    if (!cJSON_IsNumber(v) || v->valuedouble < 0 || v->valuedouble > max) return def;
    return (uint32_t)v->valuedouble;
}

static void parse_channel(const cJSON *c, mes_channel_t *ch)
{
    memset(ch, 0, sizeof *ch);
    get_str(c, "machineId", ch->machine_id, sizeof ch->machine_id);
    const cJSON *src = cJSON_GetObjectItemCaseSensitive(c, "signalSource");
    snprintf(ch->source_name, sizeof ch->source_name, "%s", cJSON_IsString(src) ? src->valuestring : "?");
    ch->source = strcmp(ch->source_name, "gpio") == 0 ? MES_SRC_GPIO : MES_SRC_UNSUPPORTED;

    const cJSON *mode = cJSON_GetObjectItemCaseSensitive(c, "statusMode");
    ch->cfg.status_mode = cJSON_IsString(mode) && strcmp(mode->valuestring, "signal_presence") == 0 ? MES_SIGNAL_PRESENCE : MES_STATUS_BIT;
    int64_t t;
    ch->cfg.no_signal_timeout_ms = get_ms(c, "noSignalTimeoutSeconds", &t) && t >= 1 && t <= 86400 ? (uint32_t)(t * 1000) : 60000;
    const cJSON *accept = cJSON_GetObjectItemCaseSensitive(c, "acceptProductionWhileDown");
    ch->cfg.accept_production_while_down = !cJSON_IsFalse(accept); /* default true, like the agent's env default */

    const cJSON *cc = cJSON_GetObjectItemCaseSensitive(c, "connectionConfig");
    int good = mes_parse_di(cJSON_GetObjectItemCaseSensitive(cc, "goodPin"));
    int scrap = mes_parse_di(cJSON_GetObjectItemCaseSensitive(cc, "scrapPin"));
    int status = mes_parse_di(cJSON_GetObjectItemCaseSensitive(cc, "statusPin"));
    ch->cfg.count_debounce_ms = opt_ms(cc, "countDebounceMs", MES_DEFAULT_COUNT_DEBOUNCE_MS, 10000);
    ch->cfg.status_debounce_ms = opt_ms(cc, "statusDebounceMs", MES_DEFAULT_STATUS_DEBOUNCE_MS, 600000);
    ch->cfg.status_invert = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(cc, "statusInvert"));

    if (ch->source != MES_SRC_GPIO) {
        char name[sizeof ch->source_name];
        memcpy(name, ch->source_name, sizeof name);
        snprintf(ch->problem, sizeof ch->problem, "signal source \"%s\" cannot run on the I/O node (only GPIO)", name);
    } else if (good < 0 || scrap < 0 || status < 0) {
        snprintf(ch->problem, sizeof ch->problem, "a pin is not one of the inputs DI1..DI8");
    } else if (good == 0 && scrap == 0 && status == 0) {
        snprintf(ch->problem, sizeof ch->problem, "no input is assigned (goodPin, scrapPin, statusPin)");
    } else if (good && good == scrap) {
        snprintf(ch->problem, sizeof ch->problem, "goodPin and scrapPin are the same input");
    }
    ch->cfg.good_di = (uint8_t)(good > 0 ? good : 0);
    ch->cfg.scrap_di = (uint8_t)(scrap > 0 ? scrap : 0);
    ch->cfg.status_di = (uint8_t)(status > 0 ? status : 0);
}

static bool parse_claim_json(const cJSON *j, mes_claim_t *out)
{
    memset(out, 0, sizeof *out);
    const cJSON *channels = cJSON_GetObjectItemCaseSensitive(j, "channels");
    if (!cJSON_IsArray(channels)) return false;
    get_str(j, "sessionId", out->session_id, sizeof out->session_id);
    out->has_server_time = get_ms(j, "serverTimeMs", &out->server_time_ms);
    out->has_revision = get_str(j, "configRevision", out->revision, sizeof out->revision);
    out->catchup_max_minutes = 10;
    const cJSON *settings = cJSON_GetObjectItemCaseSensitive(j, "settings");
    int64_t cm;
    if (get_ms(settings, "catchupMaxMinutes", &cm) && cm >= 0 && cm <= 1440) out->catchup_max_minutes = (int)cm;
    const cJSON *c;
    cJSON_ArrayForEach(c, channels)
    {
        const cJSON *mid = cJSON_GetObjectItemCaseSensitive(c, "machineId");
        if (!cJSON_IsString(mid) || !mid->valuestring[0] || strlen(mid->valuestring) > MES_MACHINE_ID_MAX || out->n_channels >= MES_MAX_CHANNELS) {
            out->n_ignored++; /* not assigned to a machine (the agent filters these too) or too many */
            continue;
        }
        parse_channel(c, &out->channels[out->n_channels++]);
    }
    return true;
}

bool mes_parse_claim(const char *body, mes_claim_t *out)
{
    cJSON *j = cJSON_Parse(body);
    if (!j) return false;
    bool ok = parse_claim_json(j, out);
    cJSON_Delete(j);
    return ok;
}

bool mes_parse_heartbeat(const char *body, mes_heartbeat_answer_t *out)
{
    memset(out, 0, sizeof *out);
    cJSON *j = body ? cJSON_Parse(body) : NULL;
    if (!j) return false;
    out->has_server_time = get_ms(j, "serverTimeMs", &out->server_time_ms);
    out->has_revision = get_str(j, "configRevision", out->revision, sizeof out->revision);
    out->restart_requested = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(j, "restartRequested"));
    cJSON_Delete(j);
    return true;
}

static void add_cert(cJSON *o, int64_t cert_expires_ms)
{
    if (cert_expires_ms <= 0) return;
    cJSON *c = cJSON_AddObjectToObject(o, "clientCert");
    cJSON_AddNumberToObject(c, "expiresAtMs", (double)cert_expires_ms);
}

static char *finish(cJSON *o)
{
    char *s = cJSON_PrintUnformatted(o);
    cJSON_Delete(o);
    return s;
}

char *mes_body_claim(const char *token, int64_t client_time_ms, int64_t cert_expires_ms, const char *agent_version)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "token", token);
    if (client_time_ms >= 0) cJSON_AddNumberToObject(o, "clientTimeMs", (double)client_time_ms);
    add_cert(o, cert_expires_ms);
    if (agent_version) cJSON_AddStringToObject(o, "agentVersion", agent_version);
    return finish(o);
}

char *mes_body_heartbeat(const char *token, const char *session_id, int64_t client_time_ms, int64_t cert_expires_ms)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "token", token);
    cJSON_AddStringToObject(o, "sessionId", session_id);
    if (client_time_ms >= 0) cJSON_AddNumberToObject(o, "clientTimeMs", (double)client_time_ms);
    add_cert(o, cert_expires_ms);
    return finish(o);
}

char *mes_body_release(const char *token, const char *session_id)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "token", token);
    cJSON_AddStringToObject(o, "sessionId", session_id);
    return finish(o);
}

/* ---- claim cache ---- */

char *mes_cache_encode(const char *token, int64_t saved_at_ms, const char *claim_body)
{
    cJSON *claim = cJSON_Parse(claim_body);
    if (!claim) return NULL;
    cJSON_DeleteItemFromObjectCaseSensitive(claim, "sessionId"); /* a session is never reused */
    cJSON_DeleteItemFromObjectCaseSensitive(claim, "serverTimeMs");
    char hash[65];
    mes_sha256_hex(token, strlen(token), hash);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddNumberToObject(o, "version", 1);
    cJSON_AddStringToObject(o, "tokenSha256", hash);
    cJSON_AddNumberToObject(o, "savedAtMs", (double)saved_at_ms);
    cJSON_AddItemToObject(o, "claim", claim);
    return finish(o);
}

mes_cache_result_t mes_cache_decode(const char *file, const char *token, int64_t now_ms, int64_t max_age_ms, mes_claim_t *out, int64_t *age_ms)
{
    *age_ms = -1;
    cJSON *j = file ? cJSON_Parse(file) : NULL;
    if (!j) return MES_CACHE_BAD;
    mes_cache_result_t r = MES_CACHE_BAD;
    char stored[80], hash[65];
    int64_t saved;
    const cJSON *claim = cJSON_GetObjectItemCaseSensitive(j, "claim");
    if (get_str(j, "tokenSha256", stored, sizeof stored) && get_ms(j, "savedAtMs", &saved) && cJSON_IsObject(claim)) {
        mes_sha256_hex(token, strlen(token), hash);
        if (strcmp(stored, hash) != 0) {
            r = MES_CACHE_OTHER_TOKEN;
        } else {
            if (now_ms >= 0) *age_ms = now_ms - saved;
            if (now_ms >= 0 && max_age_ms > 0 && (now_ms - saved > max_age_ms || now_ms < saved - 60000)) r = MES_CACHE_TOO_OLD;
            else r = parse_claim_json(claim, out) ? MES_CACHE_OK : MES_CACHE_BAD;
        }
    }
    cJSON_Delete(j);
    return r;
}

const char *mes_cache_result_text(mes_cache_result_t r)
{
    switch (r) {
    case MES_CACHE_OK: return "ok";
    case MES_CACHE_OTHER_TOKEN: return "the cache belongs to another token";
    case MES_CACHE_TOO_OLD: return "the cache is too old";
    default: return "no usable cache";
    }
}
