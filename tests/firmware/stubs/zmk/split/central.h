#pragma once
#include <stdint.h>
struct zmk_split_relay_event_payload {
    struct {
        uint8_t event_type_size;
        uint8_t event_data_size;
    } header;
    char event_type[4];
    uint8_t event_data[240];
};
int zmk_split_central_send_relay_event(struct zmk_split_relay_event_payload *payload);
