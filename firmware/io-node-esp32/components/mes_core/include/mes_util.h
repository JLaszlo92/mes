#pragma once
/*
 * Small helpers shared by the portable core (no ESP-IDF dependency, so the core
 * builds and is unit-tested on a PC: see ../test).
 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Fills `buf` with `len` random bytes (esp_fill_random on the device). */
typedef void (*mes_random_fn)(void *buf, size_t len);

/** "2026-10-19T12:34:56.789Z" (UTC, milliseconds); `out` needs 25 bytes. */
void mes_iso8601(int64_t epoch_ms, char out[32]);

/** Milliseconds since 1970 of a UTC date and time (month 1..12); no time zone, no libc tm. */
int64_t mes_epoch_ms_utc(int year, int month, int day, int hour, int minute, int second);

/** A random RFC 4122 version 4 UUID, lower case; `out` needs 37 bytes. */
void mes_uuid4(char out[37], mes_random_fn rnd);

/**
 * Writes `in` as the inside of a JSON string (quotes not included).
 * Returns the length written, or -1 if it does not fit into `cap` (incl. the terminating 0).
 */
int mes_json_escape(const char *in, char *out, size_t cap);

/** FNV-1a, 32 bit: names a directory after a machine id that may contain any character. */
uint32_t mes_fnv1a(const char *s);

/** SHA-256 of `data` as 64 lower case hex characters (+ terminating 0). */
void mes_sha256_hex(const void *data, size_t len, char out[65]);

/** True if `s` is an http status of the 2xx class. */
static inline bool mes_http_ok(int status) { return status >= 200 && status < 300; }

#ifdef __cplusplus
}
#endif
