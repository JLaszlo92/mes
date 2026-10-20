#include "net.h"

#include <stdlib.h>
#include <string.h>

#include "board.h"
#include "driver/spi_master.h"
#include "esp_eth.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "lwip/ip4_addr.h"
#include "mes_util.h"
#include "mqtt_client.h"

static const char *TAG = "net";

/* ---------------- Ethernet ---------------- */

static volatile bool s_has_ip;

static void on_eth(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)base;
    (void)data;
    if (id == ETHERNET_EVENT_CONNECTED) ESP_LOGI(TAG, "Ethernet link up");
    if (id == ETHERNET_EVENT_DISCONNECTED) {
        ESP_LOGW(TAG, "Ethernet link down");
        s_has_ip = false;
    }
}

static void on_ip(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)base;
    if (id == IP_EVENT_ETH_GOT_IP) {
        const ip_event_got_ip_t *e = data;
        ESP_LOGI(TAG, "address " IPSTR ", gateway " IPSTR, IP2STR(&e->ip_info.ip), IP2STR(&e->ip_info.gw));
        s_has_ip = true;
    } else if (id == IP_EVENT_ETH_LOST_IP) {
        s_has_ip = false;
    }
}

esp_err_t net_eth_start(const prov_t *p)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_err_t err = gpio_install_isr_service(0);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;

    spi_bus_config_t bus = {.miso_io_num = BOARD_ETH_MISO, .mosi_io_num = BOARD_ETH_MOSI, .sclk_io_num = BOARD_ETH_SCLK, .quadwp_io_num = -1, .quadhd_io_num = -1};
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));
    spi_device_interface_config_t dev = {.mode = 0, .clock_speed_hz = BOARD_ETH_SPI_MHZ * 1000 * 1000, .queue_size = 20, .spics_io_num = BOARD_ETH_CS};
    eth_w5500_config_t w5500 = ETH_W5500_DEFAULT_CONFIG(SPI2_HOST, &dev);
    w5500.int_gpio_num = BOARD_ETH_INT;
    eth_mac_config_t mac_cfg = ETH_MAC_DEFAULT_CONFIG();
    eth_phy_config_t phy_cfg = ETH_PHY_DEFAULT_CONFIG();
    phy_cfg.reset_gpio_num = -1;
    esp_eth_mac_t *mac = esp_eth_mac_new_w5500(&w5500, &mac_cfg);
    esp_eth_phy_t *phy = esp_eth_phy_new_w5500(&phy_cfg);
    esp_eth_config_t cfg = ETH_DEFAULT_CONFIG(mac, phy);
    esp_eth_handle_t eth = NULL;
    err = esp_eth_driver_install(&cfg, &eth);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "the W5500 Ethernet chip does not answer (%s)", esp_err_to_name(err));
        return err;
    }
    uint8_t addr[6];
    esp_read_mac(addr, ESP_MAC_ETH); /* the W5500 has no address of its own: use the one of this ESP32 */
    esp_eth_ioctl(eth, ETH_CMD_S_MAC_ADDR, addr);
    ESP_LOGI(TAG, "MAC address %02x:%02x:%02x:%02x:%02x:%02x", addr[0], addr[1], addr[2], addr[3], addr[4], addr[5]);

    esp_netif_config_t ncfg = ESP_NETIF_DEFAULT_ETH();
    esp_netif_t *netif = esp_netif_new(&ncfg);
    esp_netif_set_hostname(netif, p->node_name);
    ESP_ERROR_CHECK(esp_netif_attach(netif, esp_eth_new_netif_glue(eth)));
    if (p->static_ip) {
        esp_netif_dhcpc_stop(netif);
        esp_netif_ip_info_t ip = {0};
        ip.ip.addr = ipaddr_addr(p->ip);
        ip.netmask.addr = ipaddr_addr(p->netmask);
        ip.gw.addr = ipaddr_addr(p->gateway);
        esp_netif_set_ip_info(netif, &ip);
        if (p->dns[0]) {
            esp_netif_dns_info_t dns = {.ip.type = ESP_IPADDR_TYPE_V4};
            dns.ip.u_addr.ip4.addr = ipaddr_addr(p->dns);
            esp_netif_set_dns_info(netif, ESP_NETIF_DNS_MAIN, &dns);
        }
    }
    esp_event_handler_register(ETH_EVENT, ESP_EVENT_ANY_ID, on_eth, NULL);
    esp_event_handler_register(IP_EVENT, ESP_EVENT_ANY_ID, on_ip, NULL);
    return esp_eth_start(eth);
}

bool net_has_ip(void) { return s_has_ip; }

/* ---------------- HTTPS ---------------- */

#define MAX_RESPONSE (64 * 1024)

int net_https_post(const prov_t *p, const char *path, const char *body, int timeout_ms, char **resp)
{
    *resp = NULL;
    char url[256];
    snprintf(url, sizeof url, "%s%s", p->backend_url, path);
    esp_http_client_config_t c = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .cert_pem = p->ca_pem,
        .common_name = p->tls_name[0] ? p->tls_name : NULL,
        .timeout_ms = timeout_ms,
        .buffer_size = 2048,
        .buffer_size_tx = 1024,
        .keep_alive_enable = false,
    };
    esp_http_client_handle_t h = esp_http_client_init(&c);
    if (!h) return 0;
    esp_http_client_set_header(h, "Content-Type", "application/json");
    int status = 0;
    size_t len = strlen(body);
    if (esp_http_client_open(h, (int)len) != ESP_OK) goto done;
    if (esp_http_client_write(h, body, (int)len) != (int)len) goto done;
    if (esp_http_client_fetch_headers(h) < 0) goto done;
    status = esp_http_client_get_status_code(h);
    size_t cap = 2048, n = 0;
    char *buf = malloc(cap);
    while (buf) {
        if (n + 1025 > cap) {
            if (cap >= MAX_RESPONSE) break;
            char *nb = realloc(buf, cap * 2);
            if (!nb) break;
            buf = nb;
            cap *= 2;
        }
        int r = esp_http_client_read(h, buf + n, 1024);
        if (r <= 0) break;
        n += (size_t)r;
    }
    if (buf) {
        buf[n] = 0;
        *resp = buf;
    }
done:
    esp_http_client_close(h);
    esp_http_client_cleanup(h);
    return status;
}

/* ---------------- MQTT ---------------- */

static esp_mqtt_client_handle_t s_mqtt;
static volatile bool s_mqtt_up;
static net_mqtt_event_fn s_on_conn;
static net_mqtt_ack_fn s_on_data;

static void on_mqtt(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)base;
    esp_mqtt_event_handle_t e = data;
    switch ((esp_mqtt_event_id_t)id) {
    case MQTT_EVENT_CONNECTED:
        s_mqtt_up = true;
        ESP_LOGI(TAG, "connected to broker");
        if (s_on_conn) s_on_conn(true);
        break;
    case MQTT_EVENT_DISCONNECTED:
        if (s_mqtt_up) ESP_LOGW(TAG, "connection to broker closed");
        s_mqtt_up = false;
        if (s_on_conn) s_on_conn(false);
        break;
    case MQTT_EVENT_DATA:
        /* acks are tiny; a fragmented message is not an ack */
        if (e->current_data_offset == 0 && e->data_len == e->total_data_len && s_on_data) s_on_data(e->topic, (size_t)e->topic_len, e->data, (size_t)e->data_len);
        break;
    case MQTT_EVENT_ERROR:
        if (e->error_handle && e->error_handle->error_type == MQTT_ERROR_TYPE_TCP_TRANSPORT)
            ESP_LOGW(TAG, "broker connection failed (tls 0x%x, socket errno %d)", (unsigned)e->error_handle->esp_tls_last_esp_err,
                     e->error_handle->esp_transport_sock_errno);
        else if (e->error_handle && e->error_handle->error_type == MQTT_ERROR_TYPE_CONNECTION_REFUSED)
            ESP_LOGE(TAG, "the broker refused the connection (code %d): is the ACL entry of this node there?", e->error_handle->connect_return_code);
        break;
    default: break;
    }
}

esp_err_t net_mqtt_start(const prov_t *p, net_mqtt_event_fn on_conn, net_mqtt_ack_fn on_data)
{
    s_on_conn = on_conn;
    s_on_data = on_data;
    uint8_t r[6];
    esp_fill_random(r, sizeof r);
    static char client_id[48];
    snprintf(client_id, sizeof client_id, "edge-node-%02x%02x%02x%02x%02x%02x", r[0], r[1], r[2], r[3], r[4], r[5]);
    esp_mqtt_client_config_t c = {
        .broker.address.uri = p->mqtt_url,
        .broker.verification.certificate = p->ca_pem,
        .broker.verification.common_name = p->tls_name[0] ? p->tls_name : NULL,
        .credentials.client_id = client_id,
        .credentials.authentication.certificate = p->cert_pem,
        .credentials.authentication.key = p->key_pem,
        .session.keepalive = 15,              /* same as node-gate (v11) */
        .network.reconnect_timeout_ms = 2000, /* reconnectPeriod */
        .network.timeout_ms = 10000,          /* connectTimeout */
        .buffer.size = 2048,
        .buffer.out_size = 2048,
        .task.stack_size = 8192, /* TLS handshake with the device certificate */
        .outbox.limit = 256 * 1024,
    };
    s_mqtt = esp_mqtt_client_init(&c);
    if (!s_mqtt) return ESP_FAIL;
    esp_mqtt_client_register_event(s_mqtt, ESP_EVENT_ANY_ID, on_mqtt, NULL);
    return esp_mqtt_client_start(s_mqtt);
}

bool net_mqtt_connected(void) { return s_mqtt_up; }

bool net_mqtt_publish(const char *topic, const char *data, size_t len)
{
    if (!s_mqtt || !s_mqtt_up) return false;
    return esp_mqtt_client_enqueue(s_mqtt, topic, data, (int)len, 1, 0, true) >= 0;
}

void net_mqtt_subscribe(const char *topic)
{
    if (s_mqtt && s_mqtt_up && esp_mqtt_client_subscribe(s_mqtt, topic, 1) < 0) ESP_LOGW(TAG, "failed to subscribe to %s", topic);
}

void net_mqtt_unsubscribe(const char *topic)
{
    if (s_mqtt && s_mqtt_up) esp_mqtt_client_unsubscribe(s_mqtt, topic);
}
