cmake_minimum_required(VERSION 3.20.0)
if(NOT PMW3610_NANOPB_DIR)
  message(FATAL_ERROR "Pass the selected West nanopb project as PMW3610_NANOPB_DIR")
endif()
# This isolated app uses actual Zephyr/nanopb with synthetic sensor/Studio/split
# boundaries. Do not include the production ZMK app or duplicate owner modules.
set(ZEPHYR_MODULES ${PMW3610_NANOPB_DIR})
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(pmw3610_regressions)
get_filename_component(OWNER_ROOT ../.. ABSOLUTE)
target_include_directories(app BEFORE PRIVATE stubs ${OWNER_ROOT}/include ${CMAKE_CURRENT_BINARY_DIR} ${CMAKE_CURRENT_BINARY_DIR}/proto)
target_sources(app PRIVATE src/fixtures.c src/executor.c src/relay.c)
target_compile_definitions(app PRIVATE
  CONFIG_ZMK_SPLIT=1 CONFIG_ZMK_PMW3610_SPLIT_RPC_RELAY=1
  CONFIG_ZMK_PMW3610_STUDIO_RPC_FRAME_BUF_SIZE=484 CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE=256
  CONFIG_ZMK_PMW3610_FRAME_STREAM_LEASE_MS=1000
  CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN=240 CONFIG_ZMK_PMW3610_RELAY_QUEUE_DEPTH=8 CONFIG_ZMK_LOG_LEVEL=0)
if(PMW3610_CENTRAL)
  target_compile_definitions(app PRIVATE CONFIG_ZMK_SPLIT_ROLE_CENTRAL=1)
endif()
list(APPEND CMAKE_MODULE_PATH ${ZEPHYR_BASE}/modules/nanopb)
include(nanopb)
set(NANOPB_GENERATE_CPP_APPEND_PATH TRUE)
set(NANOPB_GENERATE_CPP_STANDALONE OFF)
nanopb_generate_cpp(proto_srcs proto_hdrs RELPATH ${OWNER_ROOT}
  ${OWNER_ROOT}/proto/cormoran/pmw3610/pmw3610.proto)
target_sources(app PRIVATE ${proto_srcs} ${proto_hdrs})
