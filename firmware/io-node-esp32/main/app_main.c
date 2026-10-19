/*
 * MES I/O node — Waveshare ESP32-S3-ETH-8DI-8RO.
 * The firmware is the same on every box; what a box is (node name, token, certificates, backend address)
 * comes from its provisioning partition (tools/provision.sh). See README.md.
 */
#include "agent.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hw.h"
#include "net.h"
#include "nvs_flash.h"
#include "prov.h"

static const char *TAG = "main";

static prov_t s_prov;

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
    agent_run(&s_prov); /* never returns */
}
