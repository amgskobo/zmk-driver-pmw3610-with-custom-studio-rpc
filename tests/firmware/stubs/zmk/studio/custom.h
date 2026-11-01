#pragma once
#include <pb_encode.h>
#include <zmk/event_manager.h>

struct zmk_rpc_custom_subsystem {
    const char *identifier;
};
static struct zmk_rpc_custom_subsystem test_subsystem = {.identifier = "cormoran__pmw3610"};
#undef STRUCT_SECTION_COUNT
#undef STRUCT_SECTION_GET
#define STRUCT_SECTION_COUNT(type, count) (*(count) = 1)
#define STRUCT_SECTION_GET(type, index, result) (*(result) = &test_subsystem)
struct zmk_studio_custom_notification {
    uint8_t subsystem_index;
    pb_callback_t encode_payload;
};
static inline bool zmk_rpc_custom_subsystem_encode_response_payload(pb_ostream_t *stream,
                                                                    const pb_field_t *field,
                                                                    const pb_msgdesc_t *fields,
                                                                    const void *message) {
    ARG_UNUSED(field);
    return pb_encode(stream, fields, message);
}
int raise_zmk_studio_custom_notification(struct zmk_studio_custom_notification event);
