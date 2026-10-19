#include "prov.h"

#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "prov";

#define PARTITION "mescfg"
#define NAMESPACE "mes"

static esp_err_t get_str(nvs_handle_t h, const char *key, char *out, size_t cap, bool required)
{
    size_t len = cap;
    esp_err_t err = nvs_get_str(h, key, out, &len);
    if (err == ESP_ERR_NVS_NOT_FOUND && !required) {
        out[0] = 0;
        return ESP_OK;
    }
    if (err != ESP_OK) ESP_LOGE(TAG, "provisioning key \"%s\": %s", key, esp_err_to_name(err));
    return err;
}

static esp_err_t get_alloc(nvs_handle_t h, const char *key, char **out)
{
    size_t len = 0;
    esp_err_t err = nvs_get_str(h, key, NULL, &len);
    if (err == ESP_OK) {
        *out = malloc(len);
        if (!*out) return ESP_ERR_NO_MEM;
        err = nvs_get_str(h, key, *out, &len);
    }
    if (err != ESP_OK) ESP_LOGE(TAG, "provisioning key \"%s\": %s", key, esp_err_to_name(err));
    return err;
}

esp_err_t prov_load(prov_t *p)
{
    memset(p, 0, sizeof *p);
    esp_err_t err = nvs_flash_init_partition(PARTITION);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "the provisioning partition cannot be read (%s)", esp_err_to_name(err));
        return ESP_ERR_NOT_FOUND;
    }
    nvs_handle_t h;
    err = nvs_open_from_partition(PARTITION, NAMESPACE, NVS_READONLY, &h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "this box is not provisioned (%s)", esp_err_to_name(err));
        return ESP_ERR_NOT_FOUND;
    }
    bool ok = get_str(h, "node_name", p->node_name, sizeof p->node_name, true) == ESP_OK &&
              get_str(h, "token", p->token, sizeof p->token, true) == ESP_OK &&
              get_str(h, "backend_url", p->backend_url, sizeof p->backend_url, true) == ESP_OK &&
              get_str(h, "mqtt_url", p->mqtt_url, sizeof p->mqtt_url, true) == ESP_OK &&
              get_str(h, "tls_name", p->tls_name, sizeof p->tls_name, false) == ESP_OK &&
              get_alloc(h, "ca_pem", &p->ca_pem) == ESP_OK && get_alloc(h, "cert_pem", &p->cert_pem) == ESP_OK &&
              get_alloc(h, "key_pem", &p->key_pem) == ESP_OK && get_str(h, "ntp_server", p->ntp_server, sizeof p->ntp_server, false) == ESP_OK &&
              get_str(h, "ip", p->ip, sizeof p->ip, false) == ESP_OK && get_str(h, "netmask", p->netmask, sizeof p->netmask, false) == ESP_OK &&
              get_str(h, "gateway", p->gateway, sizeof p->gateway, false) == ESP_OK && get_str(h, "dns", p->dns, sizeof p->dns, false) == ESP_OK;
    uint8_t low = 1;
    if (nvs_get_u8(h, "di_active_low", &low) != ESP_OK) low = 1;
    p->di_active_low = low != 0;
    nvs_close(h);
    if (!ok) return ESP_ERR_NOT_FOUND;
    p->static_ip = p->ip[0] != 0;
    if (p->static_ip && (!p->netmask[0] || !p->gateway[0])) {
        ESP_LOGE(TAG, "a static address needs \"netmask\" and \"gateway\" too");
        return ESP_ERR_NOT_FOUND;
    }
    /* Never log the token or the key. */
    ESP_LOGI(TAG, "node \"%s\", backend %s, broker %s, certificate name check \"%s\", inputs active %s, %s", p->node_name, p->backend_url,
             p->mqtt_url, p->tls_name[0] ? p->tls_name : "(host of the URL)", p->di_active_low ? "low" : "high", p->static_ip ? p->ip : "DHCP");
    return ESP_OK;
}
