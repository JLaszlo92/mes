/*
 * MES I/O node — Waveshare ESP32-S3-ETH-8DI-8RO.
 * The firmware is the same on every box; what a box is (node name, token, certificates, backend address)
 * comes from its provisioning partition (tools/provision.sh). See README.md.
 */
#include "agent.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hw.h"
#include "net.h"
#include "esp_system.h"
#include "nvs_flash.h"
#include "prov.h"

static const char *TAG = "main";

static prov_t s_prov;

/* The agent is not run on the main task (3.5 KB stack in ESP-IDF's default): its claim handling alone needed 3.7 KB
 * in io-node-v1, which overflowed the stack and crashed the box at its first claim. */
#define AGENT_TASK_STACK 16384

static void agent_task(void *arg)
{
    agent_run((prov_t *)arg); /* never returns */
}

static void unprovisioned_forever(void)
{
    /* Like exit code 78 on node-gate: a configuration error does not restart in a loop. */
    hw_led_set(LED_UNPROVISIONED);
    int64_t next_log = 0;
    for (;;) {
        int64_t now = esp_timer_get_time() / 1000;
        hw_led_tick(now);
        if (now >= next_log) {
            next_log = now + 10000;
            ESP_LOGE(TAG, "this box is not provisioned: run tools/provision.sh with the bundle of new-edge-node.sh (see README.md)");
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }
    if (hw_init() != ESP_OK) ESP_LOGE(TAG, "the I2C bus could not be started (relay expander and real-time clock)");
    if (hw_led_init() != ESP_OK) ESP_LOGW(TAG, "the status LED could not be started");
    hw_led_set(LED_NO_NETWORK);
    hw_led_tick(0);

    if (prov_load(&s_prov) != ESP_OK) unprovisioned_forever();

    hw_storage_mount();
    if (net_eth_start(&s_prov) != ESP_OK) ESP_LOGE(TAG, "Ethernet could not be started; events are buffered until it works (reboot)");
    if (xTaskCreate(agent_task, "agent", AGENT_TASK_STACK, &s_prov, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "the agent task cannot be created (out of memory)");
        vTaskDelay(pdMS_TO_TICKS(5000));
        esp_restart();
    }
}
