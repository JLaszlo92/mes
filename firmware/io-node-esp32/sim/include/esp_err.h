#pragma once
/* Linux simulator: the parts of ESP-IDF's esp_err.h the agent uses. */
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_NO_MEM 0x101
#define ESP_ERR_NOT_FOUND 0x105
