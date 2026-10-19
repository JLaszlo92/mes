# The firmware's agent on Linux, for end-to-end tests against a real backend and broker (see README.md).
# Needs: libcurl4-openssl-dev libmosquitto-dev libssl-dev; cJSON from an ESP-IDF checkout.
IDF_PATH ?= $(HOME)/esp-idf
CJSON_DIR ?= $(IDF_PATH)/components/json/cJSON
CC ?= cc
CFLAGS ?= -std=gnu11 -Wall -Wextra -Wno-unused-parameter -g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer
CORE = ../components/mes_core/src
SRC = main_sim.c plat_linux.c board_sim.c ../main/agent.c $(wildcard $(CORE)/*.c) $(CJSON_DIR)/cJSON.c

io-node-sim: $(SRC) $(wildcard ../main/*.h ../components/mes_core/include/*.h include/*.h)
	$(CC) $(CFLAGS) -DSTORAGE_BASE='"data"' -Iinclude -I../main -I../components/mes_core/include -I$(CJSON_DIR) -I/usr/include/x86_64-linux-gnu \
		-o $@ $(SRC) -lcurl -lmosquitto -lcrypto -lpthread -lm

clean:
	rm -f io-node-sim

.PHONY: clean
