# Host tests of the portable core: `make -C components/mes_core/test`
# cJSON comes from the ESP-IDF checkout (the same copy the firmware is built with).
IDF_PATH ?= $(HOME)/esp-idf
CJSON_DIR ?= $(IDF_PATH)/components/json/cJSON
CC ?= cc
CFLAGS ?= -std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer
SRC = ../src/mes_util.c ../src/mes_policy.c ../src/mes_signal.c ../src/mes_queue.c ../src/mes_proto.c

all: run

test_core: test_core.c $(SRC) $(wildcard ../include/*.h)
	@test -f $(CJSON_DIR)/cJSON.c || { echo "cJSON not found: set IDF_PATH or CJSON_DIR"; exit 1; }
	$(CC) $(CFLAGS) -I../include -I$(CJSON_DIR) -o $@ test_core.c $(SRC) $(CJSON_DIR)/cJSON.c -lm

run: test_core
	./test_core

clean:
	rm -f test_core

.PHONY: all run clean
