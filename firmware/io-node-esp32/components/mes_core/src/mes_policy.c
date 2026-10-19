#include "mes_policy.h"

#include <string.h>

mes_claim_failure_t mes_classify_claim_failure(int status)
{
    if (status == 0 || status >= 500 || status == 408 || status == 429) return MES_FAIL_UNREACHABLE;
    return MES_FAIL_REJECTED;
}

mes_heartbeat_failure_t mes_classify_heartbeat_failure(int status)
{
    if (status >= 400 && status < 500 && status != 408 && status != 429) return MES_HB_LEASE_LOST;
    return MES_HB_TRANSIENT;
}

int64_t mes_backoff_ms(int attempt)
{
    if (attempt < 0) attempt = 0;
    if (attempt >= 4) return 60000;
    int64_t v = 5000LL << attempt;
    return v > 60000 ? 60000 : v;
}

void mes_rejection_reset(mes_rejection_t *r)
{
    r->rejecting = false;
    r->first_rejected_ms = 0;
}

bool mes_rejection_note(mes_rejection_t *r, int64_t now_ms)
{
    if (!r->rejecting) {
        r->rejecting = true;
        r->first_rejected_ms = now_ms;
    }
    return now_ms - r->first_rejected_ms >= MES_REJECTION_GRACE_MS;
}

bool mes_measure_ahead(int64_t sent_wall_ms, int64_t rtt_ms, int64_t server_time_ms, int64_t *ahead_ms)
{
    if (rtt_ms < 0 || rtt_ms > MES_CLOCK_MAX_ROUND_TRIP_MS) return false;
    /* Same formula as clock-check.ts: round((sent + received) / 2) - server. */
    int64_t mid = sent_wall_ms + (rtt_ms + 1) / 2;
    *ahead_ms = mid - server_time_ms;
    return true;
}

void mes_restart_decider_init(mes_restart_decider_t *d)
{
    memset(d, 0, sizeof *d);
}

mes_restart_reason_t mes_restart_decide(mes_restart_decider_t *d, int64_t uptime_ms, const char *claimed, const char *hb, bool requested)
{
    if (requested && uptime_ms >= MES_RESTART_MIN_UPTIME_REQUEST_MS) return MES_RESTART_REQUESTED;
    if (!claimed || !hb || strcmp(claimed, hb) == 0) {
        d->has_pending = false;
        return MES_RESTART_NONE;
    }
    if (d->has_pending && strcmp(d->pending, hb) == 0 && uptime_ms >= MES_RESTART_MIN_UPTIME_REVISION_MS) return MES_RESTART_CONFIG_CHANGED;
    strncpy(d->pending, hb, sizeof d->pending - 1);
    d->pending[sizeof d->pending - 1] = 0;
    d->has_pending = true;
    return MES_RESTART_NONE;
}

const char *mes_restart_reason_text(mes_restart_reason_t r)
{
    switch (r) {
    case MES_RESTART_REQUESTED: return "a restart was requested from the dashboard";
    case MES_RESTART_CONFIG_CHANGED: return "the channel or node configuration was changed in the dashboard";
    default: return "none";
    }
}
