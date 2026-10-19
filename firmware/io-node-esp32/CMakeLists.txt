# MES I/O node: firmware for the Waveshare ESP32-S3-ETH-8DI-8RO (ESP-IDF 5.3).
# Build: idf.py build    (see README.md)
cmake_minimum_required(VERSION 3.16)

# The firmware version, sent to the backend with the claim and printed at boot.
# Bump it with every release tag (io-node-vN), like edge-agent-vN for node-gate.
set(PROJECT_VER "io-node-v1")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(mes-io-node)
