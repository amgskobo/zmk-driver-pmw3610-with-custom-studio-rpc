#pragma once
#include <zephyr/kernel.h>

/* Typed event fixtures: transport dispatch is a boundary double; the tested
 * owner listeners, message queues and workers remain the production code. */
typedef void zmk_event_t;
#define ZMK_RELAY_EVENT_SOURCE_SELF 0xff
#define ZMK_EVENT_DECLARE(type)                                                                    \
    static inline struct type *as_##type(const zmk_event_t *event) {                               \
        return (struct type *)event;                                                               \
    }                                                                                              \
    int raise_##type(struct type event)
#define ZMK_EVENT_IMPL(...)
#define ZMK_LISTENER(...)
#define ZMK_SUBSCRIPTION(...)
#define ZMK_RELAY_EVENT_HANDLE(...)
#define ZMK_RELAY_EVENT_HANDLE_DESERIALIZE(...)
#define ZMK_RELAY_EVENT_CENTRAL_TO_PERIPHERAL_SERIALIZE(...)
#define ZMK_RELAY_EVENT_PERIPHERAL_TO_CENTRAL_SERIALIZE(...)
