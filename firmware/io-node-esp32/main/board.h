#pragma once
/*
 * Waveshare ESP32-S3-ETH-8DI-8RO (RS485 variant): pin map from the Waveshare wiki and its ESPHome
 * configuration. The inputs are optocoupled; the GPIO reads LOW while current flows through an input
 * (pull-up, active low), which is the default of the `di_active_low` provisioning setting.
 */
#include "driver/gpio.h"

/* Digital inputs DI1..DI8 */
static const gpio_num_t BOARD_DI_GPIO[8] = {GPIO_NUM_4, GPIO_NUM_5, GPIO_NUM_6, GPIO_NUM_7, GPIO_NUM_8, GPIO_NUM_9, GPIO_NUM_10, GPIO_NUM_11};

/* W5500 Ethernet on SPI2 */
#define BOARD_ETH_SCLK GPIO_NUM_15
#define BOARD_ETH_MOSI GPIO_NUM_13
#define BOARD_ETH_MISO GPIO_NUM_14
#define BOARD_ETH_CS GPIO_NUM_16
#define BOARD_ETH_INT GPIO_NUM_12
#define BOARD_ETH_SPI_MHZ 20

/* I2C: TCA9554 (relays, address 0x20) and the PCF85063 real-time clock (0x51) */
#define BOARD_I2C_SDA GPIO_NUM_42
#define BOARD_I2C_SCL GPIO_NUM_41
#define BOARD_TCA9554_ADDR 0x20
#define BOARD_PCF85063_ADDR 0x51

/* WS2812 status LED and the buzzer (kept silent) */
#define BOARD_RGB_LED GPIO_NUM_38
#define BOARD_BUZZER GPIO_NUM_46
