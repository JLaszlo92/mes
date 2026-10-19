#pragma once
/* On-board peripherals: relays (kept off), the real-time clock, the status LED, the flash file system. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

/** I2C bus, relays switched off and held off (the I/O node never drives the machine), buzzer silent. */
esp_err_t hw_init(void);

/** Reads the PCF85063. False if it has no valid time (battery flat, never set): its "oscillator stopped" flag is set. */
bool hw_rtc_read(int64_t *epoch_ms);
esp_err_t hw_rtc_write(int64_t epoch_ms);

typedef enum {
    LED_UNPROVISIONED, /* red, blinking */
    LED_NO_NETWORK,    /* blue */
    LED_CONNECTING,    /* yellow: network, but no lease or no broker */
    LED_OK,            /* green */
    LED_BUFFER_HIGH,   /* magenta: the buffer is over 80 % */
} led_state_t;

esp_err_t hw_led_init(void);
void hw_led_set(led_state_t s);
/** A short white flash (a part was counted); shows the wiring works without a laptop. */
void hw_led_flash(void);
/** Call every ~50 ms from one task: drives blinking and the flash. */
void hw_led_tick(int64_t now_ms);

#ifndef STORAGE_BASE
#define STORAGE_BASE "/data"
#endif
esp_err_t hw_storage_mount(void);
void hw_storage_usage(size_t *total, size_t *used);
