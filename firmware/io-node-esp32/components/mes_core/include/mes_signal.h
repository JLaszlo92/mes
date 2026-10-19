#pragma once
/*
 * From digital input levels to machine readings: the debounce filter and the per-channel logic that the
 * Node agent splits into gpio_bridge.py, ProductionGate.ts and SignalPresenceWatchdog.ts.
 *
 * Everything works on the timestamps of the input edges (monotonic ms), not on when the code happens to
 * look: a reading carries the moment the input really changed, and a pulse shorter than the debounce time
 * is rejected however late it is evaluated. Pure, so it is unit-tested on a PC.
 */
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MES_DI_COUNT 8

/* ---- debounce: a level counts once it has been stable for `hold_ms` ---- */

typedef struct {
    uint32_t hold_ms;
    bool stable;        /* the accepted level (true = active) */
    bool has_candidate; /* a different level was seen and has not been stable long enough yet */
    bool candidate;
    int64_t candidate_since;
} mes_debounce_t;

void mes_debounce_init(mes_debounce_t *d, uint32_t hold_ms, bool level);
/** Feeds the raw level seen at `t`. Returns true and sets `*changed_at` if the PREVIOUS candidate was accepted before this edge. */
bool mes_debounce_feed(mes_debounce_t *d, bool level, int64_t t, int64_t *changed_at);
/** Returns true and sets `*changed_at` if the candidate has been stable long enough by `now`. */
bool mes_debounce_poll(mes_debounce_t *d, int64_t now, int64_t *changed_at);

/* ---- a channel: one machine, wired to up to three inputs ---- */

typedef enum { MES_STATUS_BIT = 0, MES_SIGNAL_PRESENCE = 1 } mes_status_mode_t;

typedef struct {
    mes_status_mode_t status_mode;
    uint32_t no_signal_timeout_ms;   /* signal_presence: no part for this long = down */
    bool accept_production_while_down;
    uint8_t good_di, scrap_di, status_di; /* 1..8; 0 = not wired */
    uint32_t count_debounce_ms;      /* a part pulse must be at least this long */
    uint32_t status_debounce_ms;     /* the status input must hold this long (a current switch flickers) */
    bool status_invert;              /* true: an active status input means "down" */
} mes_chan_cfg_t;

#define MES_DEFAULT_COUNT_DEBOUNCE_MS 20
#define MES_DEFAULT_STATUS_DEBOUNCE_MS 1000

typedef enum { MES_READ_GOOD, MES_READ_SCRAP, MES_READ_RUNNING, MES_READ_DOWN } mes_reading_kind_t;

typedef struct {
    mes_reading_kind_t kind;
    int64_t t; /* monotonic ms of the change */
} mes_reading_t;

typedef void (*mes_emit_fn)(void *ctx, const mes_reading_t *r);

typedef struct {
    mes_chan_cfg_t cfg;
    mes_debounce_t good, scrap, status;
    bool running;          /* status_bit: the current status; signal_presence: not down */
    bool status_known;
    int64_t last_part_t;   /* signal_presence */
    mes_emit_fn emit;
    void *ctx;
} mes_chan_logic_t;

/**
 * `levels` bit i = DI(i+1) active at `now`. Emits the current status at once (like gpio_bridge.py does on
 * start, and SignalPresenceWatchdog which starts as down).
 */
void mes_chan_start(mes_chan_logic_t *c, const mes_chan_cfg_t *cfg, uint8_t levels, int64_t now, mes_emit_fn emit, void *ctx);
/** A raw level change of input `di` (1..8) at `t`. Inputs the channel does not use are ignored. */
void mes_chan_edge(mes_chan_logic_t *c, uint8_t di, bool level, int64_t t);
/** Call often (every few ms): accepts levels that have become stable and runs the no-signal timer. */
void mes_chan_poll(mes_chan_logic_t *c, int64_t now);

#ifdef __cplusplus
}
#endif
