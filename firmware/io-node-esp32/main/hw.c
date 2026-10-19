#include "hw.h"

#include <string.h>

#include "board.h"
#include "driver/i2c_master.h"
#include "driver/rmt_tx.h"
#include "esp_littlefs.h"
#include "esp_log.h"
#include "mes_util.h"

static const char *TAG = "hw";

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_tca, s_rtc;

static esp_err_t relays_off(void)
{
    /* TCA9554: output register 0x01 = 0 (all relays off), then configuration 0x03 = 0 (all pins outputs). */
    uint8_t out[2] = {0x01, 0x00};
    esp_err_t err = i2c_master_transmit(s_tca, out, 2, 100);
    if (err != ESP_OK) return err;
    uint8_t cfg[2] = {0x03, 0x00};
    return i2c_master_transmit(s_tca, cfg, 2, 100);
}

esp_err_t hw_init(void)
{
    gpio_config_t buz = {.pin_bit_mask = 1ULL << BOARD_BUZZER, .mode = GPIO_MODE_OUTPUT};
    gpio_config(&buz);
    gpio_set_level(BOARD_BUZZER, 0);

    i2c_master_bus_config_t bc = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = BOARD_I2C_SDA,
        .scl_io_num = BOARD_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    esp_err_t err = i2c_new_master_bus(&bc, &s_bus);
    if (err != ESP_OK) return err;
    i2c_device_config_t tca = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = BOARD_TCA9554_ADDR, .scl_speed_hz = 100000};
    i2c_device_config_t rtc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = BOARD_PCF85063_ADDR, .scl_speed_hz = 100000};
    i2c_master_bus_add_device(s_bus, &tca, &s_tca);
    i2c_master_bus_add_device(s_bus, &rtc, &s_rtc);
    err = relays_off();
    if (err != ESP_OK) ESP_LOGW(TAG, "could not set the relay expander (%s); the relays stay in their power-on state (off)", esp_err_to_name(err));
    return ESP_OK;
}

static uint8_t bcd2bin(uint8_t v) { return (uint8_t)((v >> 4) * 10 + (v & 0x0f)); }
static uint8_t bin2bcd(int v) { return (uint8_t)(((v / 10) << 4) | (v % 10)); }

bool hw_rtc_read(int64_t *epoch_ms)
{
    uint8_t reg = 0x04, r[7];
    if (i2c_master_transmit_receive(s_rtc, &reg, 1, r, sizeof r, 100) != ESP_OK) return false;
    if (r[0] & 0x80) return false; /* OS: the oscillator stopped, the time is not valid */
    int sec = bcd2bin(r[0] & 0x7f), min = bcd2bin(r[1] & 0x7f), hour = bcd2bin(r[2] & 0x3f);
    int day = bcd2bin(r[3] & 0x3f), mon = bcd2bin(r[5] & 0x1f), year = 2000 + bcd2bin(r[6]);
    if (mon < 1 || mon > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59 || year < 2024) return false;
    *epoch_ms = mes_epoch_ms_utc(year, mon, day, hour, min, sec);
    return true;
}

esp_err_t hw_rtc_write(int64_t epoch_ms)
{
    int64_t s = epoch_ms / 1000;
    int64_t days = s / 86400;
    int rem = (int)(s % 86400);
    char iso[32];
    mes_iso8601(epoch_ms, iso); /* "YYYY-MM-DDThh:mm:ss.mmmZ": take the date from it */
    int year = (iso[0] - '0') * 1000 + (iso[1] - '0') * 100 + (iso[2] - '0') * 10 + (iso[3] - '0');
    int mon = (iso[5] - '0') * 10 + (iso[6] - '0');
    int day = (iso[8] - '0') * 10 + (iso[9] - '0');
    int wday = (int)((days + 4) % 7); /* 1970-01-01 was a Thursday */
    uint8_t w[8] = {0x04,
                    bin2bcd(rem % 60), /* writing the seconds clears the OS flag */
                    bin2bcd(rem / 60 % 60),
                    bin2bcd(rem / 3600),
                    bin2bcd(day),
                    (uint8_t)wday,
                    bin2bcd(mon),
                    bin2bcd(year - 2000)};
    return i2c_master_transmit(s_rtc, w, sizeof w, 100);
}

/* ---- WS2812 status LED (GRB) over RMT ---- */

static rmt_channel_handle_t s_led_ch;
static rmt_encoder_handle_t s_led_enc;
static led_state_t s_led_state = LED_NO_NETWORK;
static int64_t s_flash_until;
static uint32_t s_last_rgb = 0xffffffff;

esp_err_t hw_led_init(void)
{
    rmt_tx_channel_config_t cc = {
        .gpio_num = BOARD_RGB_LED, .clk_src = RMT_CLK_SRC_DEFAULT, .resolution_hz = 10 * 1000 * 1000, .mem_block_symbols = 64, .trans_queue_depth = 4};
    esp_err_t err = rmt_new_tx_channel(&cc, &s_led_ch);
    if (err != ESP_OK) return err;
    rmt_bytes_encoder_config_t ec = {
        .bit0 = {.level0 = 1, .duration0 = 3, .level1 = 0, .duration1 = 9}, /* 0.3 us high, 0.9 us low */
        .bit1 = {.level0 = 1, .duration0 = 9, .level1 = 0, .duration1 = 3},
        .flags.msb_first = 1,
    };
    err = rmt_new_bytes_encoder(&ec, &s_led_enc);
    if (err != ESP_OK) return err;
    return rmt_enable(s_led_ch);
}

static void led_write(uint32_t rgb)
{
    if (!s_led_ch || rgb == s_last_rgb) return;
    s_last_rgb = rgb;
    uint8_t grb[3] = {(uint8_t)(rgb >> 8), (uint8_t)(rgb >> 16), (uint8_t)rgb};
    rmt_transmit_config_t tc = {.loop_count = 0};
    rmt_transmit(s_led_ch, s_led_enc, grb, sizeof grb, &tc);
}

void hw_led_set(led_state_t s) { s_led_state = s; }

void hw_led_flash(void) { s_flash_until = -1; /* armed: the next tick starts it */ }

void hw_led_tick(int64_t now)
{
    if (s_flash_until == -1) s_flash_until = now + 60;
    if (s_flash_until > now) {
        led_write(0x202020);
        return;
    }
    uint32_t c;
    switch (s_led_state) {
    case LED_UNPROVISIONED: c = (now / 500) % 2 ? 0x200000 : 0; break;
    case LED_NO_NETWORK: c = 0x000020; break;
    case LED_CONNECTING: c = 0x201000; break;
    case LED_BUFFER_HIGH: c = 0x200020; break;
    default: c = 0x002000; break;
    }
    led_write(c);
}

/* ---- flash file system for the event buffer ---- */

esp_err_t hw_storage_mount(void)
{
    esp_vfs_littlefs_conf_t conf = {.base_path = STORAGE_BASE, .partition_label = "storage", .format_if_mount_failed = true, .dont_mount = false};
    esp_err_t err = esp_vfs_littlefs_register(&conf);
    if (err != ESP_OK) ESP_LOGE(TAG, "the buffer file system cannot be mounted (%s); events are kept in RAM only", esp_err_to_name(err));
    return err;
}

void hw_storage_usage(size_t *total, size_t *used)
{
    *total = *used = 0;
    esp_littlefs_info("storage", total, used);
}
