#pragma once
/* Wired network (W5500), HTTPS requests to the backend, the MQTT connection with the device certificate. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "prov.h"

esp_err_t net_eth_start(const prov_t *p);
bool net_has_ip(void);

/**
 * POST `body` (JSON) to backend_url + `path` with TLS (server CA from the provisioning).
 * Returns the HTTP status, 0 if there was no answer. `*resp` (malloc'ed, 0-terminated) holds the body; free it.
 */
int net_https_post(const prov_t *p, const char *path, const char *body, int timeout_ms, char **resp);

typedef void (*net_mqtt_event_fn)(bool connected);
typedef void (*net_mqtt_ack_fn)(const char *topic, size_t topic_len, const char *data, size_t data_len);

esp_err_t net_mqtt_start(const prov_t *p, net_mqtt_event_fn on_conn, net_mqtt_ack_fn on_data);
bool net_mqtt_connected(void);
/** QoS 1, queued into the client's outbox (sent by its task). False if not connected or the outbox is full. */
bool net_mqtt_publish(const char *topic, const char *data, size_t len);
void net_mqtt_subscribe(const char *topic);
void net_mqtt_unsubscribe(const char *topic);
