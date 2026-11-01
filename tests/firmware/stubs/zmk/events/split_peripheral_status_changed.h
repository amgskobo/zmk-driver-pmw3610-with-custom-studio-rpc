#pragma once
#include <zmk/event_manager.h>
struct zmk_split_peripheral_status_changed {
    bool connected;
};
ZMK_EVENT_DECLARE(zmk_split_peripheral_status_changed);
