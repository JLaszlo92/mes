#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "mbedtls/x509_crt.h"
#include "mes_util.h"
#include "plat.h"

static const char *TAG = "plat";

plat_queue_t *plat_queue_new(size_t length, size_t item_size) { return (plat_queue_t *)xQueueCreate(length, item_size); }

bool plat_queue_send(plat_queue_t *q, const void *item, int timeout_ms)
{
    return xQueueSend((QueueHandle_t)q, item, timeout_ms ? pdMS_TO_TICKS(timeout_ms) : 0) == pdTRUE;
}

bool plat_queue_recv(plat_queue_t *q, void *item, int timeout_ms)
{
    return xQueueReceive((QueueHandle_t)q, item, timeout_ms ? pdMS_TO_TICKS(timeout_ms) : 0) == pdTRUE;
}

static TaskHandle_t s_agent;
void plat_agent_bind(void) { s_agent = xTaskGetCurrentTaskHandle(); }
void plat_agent_notify(void)
{
    if (s_agent) xTaskNotifyGive(s_agent);
}
void plat_agent_wait(int ms) { ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(ms)); }

void plat_thread(void (*fn)(void *), const char *name, size_t stack, void *arg) { xTaskCreate(fn, name, (uint32_t)stack, arg, 5, NULL); }
void plat_sleep_ms(int ms) { vTaskDelay(pdMS_TO_TICKS(ms)); }

int64_t plat_mono_ms(void) { return esp_timer_get_time() / 1000; }

int64_t plat_wall_ms(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

void plat_set_wall_ms(int64_t ms)
{
    struct timeval tv = {.tv_sec = (time_t)(ms / 1000), .tv_usec = (suseconds_t)((ms % 1000) * 1000)};
    settimeofday(&tv, NULL);
}

void plat_random(void *buf, size_t len) { esp_fill_random(buf, len); }

void *plat_big_alloc(size_t n)
{
    void *p = heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    return p ? p : malloc(n);
}
size_t plat_big_free(void) { return heap_caps_get_free_size(MALLOC_CAP_SPIRAM); }
size_t plat_internal_free(void) { return heap_caps_get_free_size(MALLOC_CAP_INTERNAL); }

void plat_wdt_add(void) { ESP_ERROR_CHECK(esp_task_wdt_add(NULL)); }
void plat_wdt_feed(void) { esp_task_wdt_reset(); }
void plat_restart(void)
{
    esp_restart();
    for (;;) {}
}

const char *plat_version(void) { return esp_app_get_description()->version; }

int64_t plat_cert_expiry_ms(const char *pem)
{
    mbedtls_x509_crt crt;
    mbedtls_x509_crt_init(&crt);
    int64_t ms = 0;
    if (mbedtls_x509_crt_parse(&crt, (const unsigned char *)pem, strlen(pem) + 1) == 0) {
        const mbedtls_x509_time *t = &crt.valid_to;
        ms = mes_epoch_ms_utc(t->year, t->mon, t->day, t->hour, t->min, t->sec);
    }
    mbedtls_x509_crt_free(&crt);
    return ms;
}

static void (*s_on_sync)(void);
static void sync_cb(struct timeval *tv)
{
    (void)tv;
    if (s_on_sync) s_on_sync();
}

void plat_sntp_start(const char *server, void (*on_sync)(void))
{
    s_on_sync = on_sync;
    esp_sntp_config_t sc = ESP_NETIF_SNTP_DEFAULT_CONFIG(server);
    sc.sync_cb = sync_cb;
    if (esp_netif_sntp_init(&sc) != ESP_OK) ESP_LOGW(TAG, "NTP could not be started");
}
