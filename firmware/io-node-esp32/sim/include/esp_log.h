#pragma once
/* Linux simulator: ESP_LOGx print like the device's serial log (level letter, uptime in ms, tag). */
#include <stdio.h>
#include <stdint.h>
int64_t plat_mono_ms(void);
#define SIM_LOG(l, tag, fmt, ...) fprintf(stderr, "%s (%lld) %s: " fmt "\n", l, (long long)plat_mono_ms(), tag, ##__VA_ARGS__)
#define ESP_LOGE(tag, fmt, ...) SIM_LOG("E", tag, fmt, ##__VA_ARGS__)
#define ESP_LOGW(tag, fmt, ...) SIM_LOG("W", tag, fmt, ##__VA_ARGS__)
#define ESP_LOGI(tag, fmt, ...) SIM_LOG("I", tag, fmt, ##__VA_ARGS__)
#define ESP_LOGD(tag, fmt, ...) do { if (getenv("SIM_DEBUG")) SIM_LOG("D", tag, fmt, ##__VA_ARGS__); } while (0)
#include <stdlib.h>
