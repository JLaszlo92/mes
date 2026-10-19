#pragma once
/*
 * Provisioning: what makes this box one particular edge node. Written once over USB by
 * tools/provision.sh into its own NVS partition ("mescfg", namespace "mes"); the firmware
 * image itself is the same for every box.
 */
#include <stdbool.h>

#include "esp_err.h"

typedef struct {
    char node_name[48];
    char token[160];       /* EDGE_NODE_TOKEN */
    char backend_url[160]; /* BACKEND_HTTP_URL, e.g. https://192.168.60.141 */
    char mqtt_url[160];    /* MQTT_URL, e.g. mqtts://192.168.60.141:8884 */
    char tls_name[96];     /* the name checked in the server certificates (they carry DNS:mes.pilot.internal) */
    char *ca_pem;          /* server CA (/etc/ssl/mes-ca.crt) */
    char *cert_pem;        /* device certificate (CN = node name) */
    char *key_pem;         /* its private key */
    bool di_active_low;
    char ntp_server[96];   /* optional; without it the backend's time (and the RTC) is the clock */
    bool static_ip;
    char ip[16], netmask[16], gateway[16], dns[16];
} prov_t;

/** Reads the provisioning. ESP_ERR_NOT_FOUND (and a log line naming the key) if something required is missing. */
esp_err_t prov_load(prov_t *p);
