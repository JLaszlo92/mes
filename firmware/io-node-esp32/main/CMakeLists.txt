idf_component_register(
    SRCS "app_main.c" "agent.c" "plat_esp.c" "prov.c" "hw.c" "di.c" "net.c"
    INCLUDE_DIRS "."
    REQUIRES mes_core esp_littlefs nvs_flash esp_eth esp_netif esp_event esp_http_client mqtt esp_driver_gpio esp_driver_i2c
             esp_driver_rmt esp_driver_spi esp_timer esp_app_format mbedtls lwip
)
