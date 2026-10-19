#pragma once
/*
 * The eight digital inputs, sampled every millisecond by a high-resolution timer. Every change of a
 * sampled level is queued with its monotonic time; debouncing is done by the channels (mes_signal),
 * because the same input may be a part pulse (20 ms) for one use and a status (seconds) for another.
 */
#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "plat.h"

typedef struct {
    uint8_t di;   /* 1..8 */
    bool active;
    int64_t t_ms; /* monotonic */
} di_edge_t;

/** Starts sampling; edges go to the returned queue and wake the agent task. */
esp_err_t di_start(bool active_low, plat_queue_t **edges);
/** Bit i = DI(i+1) active, as sampled last. */
uint8_t di_levels(void);
/** Edges lost because the queue was full (should stay 0). */
uint32_t di_overflows(void);
