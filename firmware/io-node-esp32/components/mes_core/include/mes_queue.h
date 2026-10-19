#pragma once
/*
 * The durable event buffer of one machine (node-gate: buffer.ts + retry-tracker.ts + ack-batcher.ts).
 *
 * Flash is not a disk: rewriting the whole buffer file on every acknowledgement (what buffer.ts does) would
 * wear it out and take seconds for a big backlog. So the buffer is a log of SEGMENT files that are only ever
 * appended to and deleted:
 *   - an event is appended (one line of JSON) to the current segment; a segment is closed at 32 KiB;
 *   - an acknowledgement only marks the event in RAM; a segment whose events are all acknowledged is deleted;
 *   - after a restart every event still on flash is loaded as unacknowledged and sent again; the backend
 *     skips what it already has (ON CONFLICT DO NOTHING) and acknowledges it again;
 *   - the writer never appends to a segment from before a restart, so a line cut by a power loss stays alone
 *     and is dropped when it is loaded (it does not end in "}").
 * Appends are synced at most once a second (power loss loses at most the last second, like node-gate).
 *
 * The events live in RAM too (PSRAM on the device). The buffer has a byte limit: when it is full the oldest
 * events are dropped and counted, and the caller reports the lost parts as a `data_gap` event.
 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MES_QUEUE_SEGMENT_BYTES (32 * 1024)
#define MES_QUEUE_SYNC_MS 1000
#define MES_QUEUE_IDLE_CLOSE_MS 5000 /* a fully acknowledged writer segment idle this long is closed and deleted */
#define MES_RETRY_MIN_AGE_MS 15000 /* retry-tracker.ts RETRY_MIN_AGE_MS */
#define MES_RETRY_MAX_BATCH 300    /* retry-tracker.ts RETRY_MAX_BATCH */
#define MES_QUEUE_MAX_LINE 1024

typedef struct mes_queue mes_queue_t;

/** Allocator for the event lines (PSRAM on the device); defaults to malloc/free. */
void mes_queue_set_allocator(void *(*alloc)(size_t), void (*release)(void *));

/**
 * Opens (creating) the buffer in directory `dir` and loads what is in it. `machine_id` NULL = take it from the
 * first stored event (a buffer left over from a channel that no longer exists); NULL is returned if there is none.
 */
mes_queue_t *mes_queue_open(const char *dir, const char *machine_id, size_t cap_bytes);
void mes_queue_close(mes_queue_t *q);
/** Closes and deletes every file of the buffer and the directory. */
void mes_queue_destroy(mes_queue_t *q);

const char *mes_queue_machine_id(const mes_queue_t *q);
const char *mes_queue_dir(const mes_queue_t *q);
void mes_queue_set_cap(mes_queue_t *q, size_t cap_bytes);

/** Appends an event (one JSON object, no newline) with its sourceEventId. False only if it cannot be kept even in RAM. */
bool mes_queue_push(mes_queue_t *q, const char *json, const char *source_event_id);

/** Returns false to stop the sweep (not connected, client outbox full). */
typedef bool (*mes_send_fn)(void *ctx, const char *json, size_t len);

/** Sends the event pushed last, if it was never sent (node-gate publishes a new event at once). */
void mes_queue_send_last(mes_queue_t *q, int64_t now, mes_send_fn send, void *ctx);
/** Sends what is due: never sent, or sent at least 15 s ago without an ack; at most `max`, oldest first. Returns the number sent. */
int mes_queue_sweep(mes_queue_t *q, int64_t now, int max, mes_send_fn send, void *ctx);
/** After a (re)connect nothing sent earlier is in flight: everything is due again. */
void mes_queue_reset_sent(mes_queue_t *q);
/** Marks an event acknowledged. False if it is not (or no longer) in the buffer. */
bool mes_queue_ack(mes_queue_t *q, const char *source_event_id);

/** Syncs pending appends (after MES_QUEUE_SYNC_MS) and deletes segments whose events are all acknowledged. `force` syncs now. */
void mes_queue_tick(mes_queue_t *q, int64_t now, bool force);

size_t mes_queue_pending(const mes_queue_t *q);
size_t mes_queue_bytes(const mes_queue_t *q);
/** Lines dropped while loading (cut by a power loss, unreadable). */
size_t mes_queue_load_skipped(const mes_queue_t *q);

/** Events dropped because the buffer was full, since the last call (then reset). */
typedef struct {
    uint32_t good, scrap, other;
} mes_dropped_t;
mes_dropped_t mes_queue_take_dropped(mes_queue_t *q);
/** The byte limit of the buffer (event lines plus their bookkeeping). */
size_t mes_queue_cap(const mes_queue_t *q);

#ifdef __cplusplus
}
#endif
