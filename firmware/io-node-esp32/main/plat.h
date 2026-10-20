#pragma once
/*
 * The few operating system services the agent needs. plat_esp.c implements them with FreeRTOS and ESP-IDF;
 * sim/plat_linux.c with POSIX threads, so the same agent.c runs on a PC against a real backend and broker
 * (sim/README.md: the end-to-end tests).
 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct plat_queue plat_queue_t;

plat_queue_t *plat_queue_new(size_t length, size_t item_size);
/** `timeout_ms` 0 = do not wait. Safe from the input sampler's timer callback. */
bool plat_queue_send(plat_queue_t *q, const void *item, int timeout_ms);
bool plat_queue_recv(plat_queue_t *q, void *item, int timeout_ms);

/** The agent task: wake it, or wait (at most `ms`) until it is woken. */
void plat_agent_bind(void);
void plat_agent_notify(void);
void plat_agent_wait(int ms);

void plat_thread(void (*fn)(void *), const char *name, size_t stack, void *arg);
/** Bytes of the named task's stack that were never used (its high-water mark); 0 if unknown. */
size_t plat_stack_unused(const char *task);
void plat_sleep_ms(int ms);

int64_t plat_mono_ms(void);
int64_t plat_wall_ms(void);
void plat_set_wall_ms(int64_t ms);

void plat_random(void *buf, size_t len);
void *plat_big_alloc(size_t n); /* PSRAM when there is some */
size_t plat_big_free(void);     /* free PSRAM; 0 = none */
size_t plat_internal_free(void);

void plat_wdt_add(void);
void plat_wdt_feed(void);
/** Reboot (the simulator exits with code 75 and its runner starts it again, like systemd). */
void plat_restart(void) __attribute__((noreturn));

const char *plat_version(void);
/** The expiry of a PEM certificate in ms since 1970; 0 if it cannot be read. */
int64_t plat_cert_expiry_ms(const char *pem);
/** Starts NTP with `server`; `on_sync` is called (from another task) after each synchronisation. */
void plat_sntp_start(const char *server, void (*on_sync)(void));
