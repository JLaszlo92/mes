#pragma once
/*
 * The decisions of the Node edge agent (packages/edge-agent/src), ported 1:1 so that the I/O node
 * behaves like node-gate towards the backend. Each block names the TypeScript file it mirrors;
 * a change there should be made here too.
 */
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- offline-claim.ts / initial-claim.ts / heartbeat-failure.ts ---- */

#define MES_CLAIM_TIMEOUT_MS 10000
#define MES_RELEASE_TIMEOUT_MS 3000
#define MES_HEARTBEAT_INTERVAL_MS 30000
/** A lease of a crashed instance of this node expires after 90 s; a refusal lasting longer means someone else owns it. */
#define MES_REJECTION_GRACE_MS 150000

typedef enum { MES_FAIL_UNREACHABLE, MES_FAIL_REJECTED } mes_claim_failure_t;
typedef enum { MES_HB_TRANSIENT, MES_HB_LEASE_LOST } mes_heartbeat_failure_t;

/** `http_status` 0 = no answer (network, TLS, timeout). 5xx, 408, 429 count as unreachable. */
mes_claim_failure_t mes_classify_claim_failure(int http_status);
/** 4xx except 408 and 429: the backend no longer accepts this node's lease. Everything else is transient. */
mes_heartbeat_failure_t mes_classify_heartbeat_failure(int http_status);
/** 5 s, 10 s, 20 s, 40 s, then every 60 s. */
int64_t mes_backoff_ms(int attempt);

/** Counts how long the backend keeps refusing; `true` = give up (the refusal lasted MES_REJECTION_GRACE_MS). */
typedef struct {
    bool rejecting;
    int64_t first_rejected_ms;
} mes_rejection_t;
void mes_rejection_reset(mes_rejection_t *r);
bool mes_rejection_note(mes_rejection_t *r, int64_t now_ms);

/* ---- corrected-clock.ts / clock-check.ts ---- */

#define MES_CLOCK_MIN_STEP_MS 2000
#define MES_CLOCK_MAX_ROUND_TRIP_MS 5000
#define MES_CLOCK_WARN_MS 30000

/**
 * How far the device clock is ahead of the server's (negative = behind), from one request:
 * the middle of the request is compared with the server's time. False if the round trip
 * (measured on the monotonic clock) was too slow or negative.
 */
bool mes_measure_ahead(int64_t sent_wall_ms, int64_t rtt_ms, int64_t server_time_ms, int64_t *ahead_ms);

/**
 * The I/O node has no other time source than the server (and its battery backed RTC), so unlike
 * node-gate it does not keep a correction next to a wrong system clock: it SETS the system clock.
 * True if a measured offset is large enough to step the clock.
 */
static inline bool mes_clock_needs_step(int64_t ahead_ms) { return ahead_ms >= MES_CLOCK_MIN_STEP_MS || ahead_ms <= -MES_CLOCK_MIN_STEP_MS; }

/* ---- restart-decision.ts ---- */

#define MES_RESTART_MIN_UPTIME_REQUEST_MS 20000
#define MES_RESTART_MIN_UPTIME_REVISION_MS 60000

typedef enum { MES_RESTART_NONE = 0, MES_RESTART_REQUESTED, MES_RESTART_CONFIG_CHANGED } mes_restart_reason_t;

typedef struct {
    char pending[48];
    bool has_pending;
} mes_restart_decider_t;

void mes_restart_decider_init(mes_restart_decider_t *d);
/**
 * `claimed_revision` NULL = unknown (offline start, old backend); `hb_revision` NULL = the heartbeat carried none.
 * A restart request needs 20 s uptime; a changed revision must be seen on two heartbeats in a row and needs 60 s.
 */
mes_restart_reason_t mes_restart_decide(mes_restart_decider_t *d, int64_t uptime_ms, const char *claimed_revision, const char *hb_revision,
                                        bool restart_requested);
const char *mes_restart_reason_text(mes_restart_reason_t r);

#ifdef __cplusplus
}
#endif
