#pragma once
#include "prov.h"

/** Runs the edge node (claim, channels, buffer, MQTT, heartbeat); never returns. */
void agent_run(prov_t *p);
