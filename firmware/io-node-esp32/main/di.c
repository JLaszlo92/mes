#include "di.h"

#include "board.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "di";

static plat_queue_t *s_q;
static bool s_active_low;
static volatile uint8_t s_levels;
static volatile uint32_t s_overflows;
static esp_timer_handle_t s_timer;

static uint8_t sample(void)
{
    uint8_t m = 0;
    for (int i = 0; i < 8; i++) {
        bool high = gpio_get_level(BOARD_DI_GPIO[i]) != 0;
        if (high != s_active_low) m |= (uint8_t)(1u << i);
    }
    return m;
}

static void on_tick(void *arg)
{
    (void)arg;
    uint8_t now = sample();
    uint8_t diff = now ^ s_levels;
    if (!diff) return;
    int64_t t = esp_timer_get_time() / 1000;
    bool queued = false;
    for (int i = 0; i < 8; i++) {
        if (!(diff & (1u << i))) continue;
        di_edge_t e = {.di = (uint8_t)(i + 1), .active = (now >> i) & 1, .t_ms = t};
        if (plat_queue_send(s_q, &e, 0)) queued = true;
        else s_overflows++;
    }
    s_levels = now;
    if (queued) plat_agent_notify();
}

esp_err_t di_start(bool active_low, plat_queue_t **edges)
{
    s_active_low = active_low;
    uint64_t mask = 0;
    for (int i = 0; i < 8; i++) mask |= 1ULL << BOARD_DI_GPIO[i];
    gpio_config_t c = {.pin_bit_mask = mask, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE, .pull_down_en = GPIO_PULLDOWN_DISABLE};
    esp_err_t err = gpio_config(&c);
    if (err != ESP_OK) return err;
    s_q = plat_queue_new(512, sizeof(di_edge_t));
    if (!s_q) return ESP_ERR_NO_MEM;
    s_levels = sample();
    esp_timer_create_args_t ta = {.callback = on_tick, .name = "di", .dispatch_method = ESP_TIMER_TASK};
    err = esp_timer_create(&ta, &s_timer);
    if (err == ESP_OK) err = esp_timer_start_periodic(s_timer, 1000);
    *edges = s_q;
    ESP_LOGI(TAG, "inputs sampled every 1 ms, active %s; now active: 0x%02x", active_low ? "low" : "high", s_levels);
    return err;
}

uint8_t di_levels(void) { return s_levels; }
uint32_t di_overflows(void) { return s_overflows; }
