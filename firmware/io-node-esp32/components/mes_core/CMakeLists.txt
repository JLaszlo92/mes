# The portable core: no ESP-IDF API, unit-tested on a PC (test/Makefile).
idf_component_register(
    SRCS "src/mes_util.c" "src/mes_policy.c" "src/mes_signal.c" "src/mes_queue.c" "src/mes_proto.c"
    INCLUDE_DIRS "include"
    REQUIRES json
)
