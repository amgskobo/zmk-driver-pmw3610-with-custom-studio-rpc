#include "fixtures.h"
#include "../../../src/split/pmw3610_relay.c"

int raise_zmk_pmw3610_relay_request(struct zmk_pmw3610_relay_request event) {
    ARG_UNUSED(event);
    test_request_count++;
    return 0;
}
int raise_zmk_pmw3610_relay_response(struct zmk_pmw3610_relay_response event) {
    zassert_true(test_response_count < ARRAY_SIZE(test_responses));
    pb_istream_t stream = pb_istream_from_buffer(event.payload, event.size);
    zassert_true(pb_decode(&stream, cormoran_pmw3610_RelayResponse_fields,
                           &test_responses[test_response_count++]));
    return 0;
}
int raise_zmk_pmw3610_relay_notification(struct zmk_pmw3610_relay_notification event) {
    test_record_notification(event.payload, event.size);
    return 0;
}
int raise_zmk_pmw3610_relay_stop(struct zmk_pmw3610_relay_stop event) {
    ARG_UNUSED(event);
    return 0;
}

static void before(void *fixture) {
    ARG_UNUSED(fixture);
    test_start_queue();
    pmw3610_request_stop_stream();
    test_drain_queue();
    test_lock_state = ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
#if IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
    k_work_cancel_delayable_sync(&relay_stop_work, &(struct k_work_sync){0});
    stop_pending = false;
    atomic_clear(&relay_stream_enabled);
    k_msgq_purge(&relay_response_queue);
    k_msgq_purge(&relay_notification_queue);
    next_relay_request_id = first_current_request_id = 1;
#else
    k_msgq_purge(&relay_request_queue);
#endif
    test_clear_sinks();
}

#if IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
static uint32_t request(bool stream) {
    cormoran_pmw3610_Request request = cormoran_pmw3610_Request_init_zero;
    if (stream) {
        request.which_request_type = cormoran_pmw3610_Request_set_frame_stream_tag;
        request.request_type.set_frame_stream.enable = true;
        request.request_type.set_frame_stream.source = 1;
    } else {
        request.which_request_type = cormoran_pmw3610_Request_get_info_tag;
        request.request_type.get_info.source = 1;
    }
    return send_relay_request(&request);
}
static struct zmk_pmw3610_relay_notification chunk(uint32_t offset) {
    cormoran_pmw3610_Notification notification = cormoran_pmw3610_Notification_init_zero;
    notification.which_notification_type = cormoran_pmw3610_Notification_frame_stream_chunk_tag;
    notification.notification_type.frame_stream_chunk.frame_id = 9;
    notification.notification_type.frame_stream_chunk.offset = offset;
    notification.notification_type.frame_stream_chunk.total_size = 484;
    notification.notification_type.frame_stream_chunk.data.size = 1;
    notification.notification_type.frame_stream_chunk.data.bytes[0] = 0x81;
    struct zmk_pmw3610_relay_notification event = {.source = 1};
    pb_ostream_t stream = pb_ostream_from_buffer(event.payload, sizeof(event.payload));
    zassert_true(pb_encode(&stream, cormoran_pmw3610_Notification_fields, &notification));
    event.size = stream.bytes_written;
    return event;
}
static struct zmk_pmw3610_relay_response response(uint32_t id) {
    cormoran_pmw3610_RelayResponse response = cormoran_pmw3610_RelayResponse_init_zero;
    response.request_id = id;
    response.has_response = true;
    response.response.which_response_type = cormoran_pmw3610_Response_set_frame_stream_tag;
    response.response.response_type.set_frame_stream.streaming = true;
    struct zmk_pmw3610_relay_response event = {.source = 1};
    pb_ostream_t stream = pb_ostream_from_buffer(event.payload, sizeof(event.payload));
    zassert_true(pb_encode(&stream, cormoran_pmw3610_RelayResponse_fields, &response));
    event.size = stream.bytes_written;
    return event;
}

ZTEST(relay, test_busy_queue_preserves_all_four_chunks_in_order) {
    zassert_not_equal(request(true), 0);
    test_block_queue();
    for (unsigned i = 0; i < 4; i++) {
        struct zmk_pmw3610_relay_notification event = chunk(i * 128);
        on_pmw3610_relay_notification(&event);
    }
    test_release_queue();
    test_drain_queue();
    zassert_equal(test_notification_count, 4);
    for (unsigned i = 0; i < 4; i++) {
        zassert_equal(test_notifications[i].notification_type.frame_stream_chunk.offset, i * 128);
        zassert_equal(test_notifications[i].notification_type.frame_stream_chunk.source, 1);
    }
}

ZTEST(relay, test_busy_queue_preserves_each_response) {
    test_block_queue();
    for (unsigned i = 0; i < 4; i++) {
        struct zmk_pmw3610_relay_response event = response(request(false));
        on_pmw3610_relay_response(&event);
    }
    test_release_queue();
    test_drain_queue();
    zassert_equal(test_notification_count, 4);
    for (unsigned i = 0; i < 4; i++) {
        zassert_equal(test_notifications[i].notification_type.peripheral_response.request_id,
                      i + 1);
    }
}

ZTEST(relay, test_lock_drops_queued_and_late_chunks_until_new_start) {
    request(true);
    test_block_queue();
    struct zmk_pmw3610_relay_notification event = chunk(0);
    on_pmw3610_relay_notification(&event);
    test_lock();
    on_pmw3610_relay_notification(&event);
    test_lock_state = ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
    on_pmw3610_relay_notification(&event);
    test_release_queue();
    test_drain_queue();
    zassert_equal(test_notification_count, 0);
    zassert_equal(test_stop_count, 1);
    request(true);
    on_pmw3610_relay_notification(&event);
    test_drain_queue();
    zassert_equal(test_notification_count, 1);
}

ZTEST(relay, test_late_response_cannot_cross_lock_unlock_boundary) {
    uint32_t retired = request(false);
    test_lock();
    test_lock_state = ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
    struct zmk_pmw3610_relay_response event = response(retired);
    on_pmw3610_relay_response(&event);
    test_drain_queue();
    zassert_equal(test_notification_count, 0);
    event = response(request(false));
    on_pmw3610_relay_response(&event);
    test_drain_queue();
    zassert_equal(test_notification_count, 1);
}

ZTEST(relay, test_queue_overflow_keeps_owned_packets_and_rejects_oversized_input) {
    request(true);
    test_block_queue();
    for (unsigned i = 0; i < CONFIG_ZMK_PMW3610_RELAY_QUEUE_DEPTH + 3; i++) {
        struct zmk_pmw3610_relay_notification event = chunk(i * 32);
        on_pmw3610_relay_notification(&event);
    }
    struct zmk_pmw3610_relay_notification oversized = {.size = sizeof(oversized.payload) + 1};
    zassert_equal(on_pmw3610_relay_notification(&oversized), -EMSGSIZE);
    test_release_queue();
    test_drain_queue();
    zassert_equal(test_notification_count, CONFIG_ZMK_PMW3610_RELAY_QUEUE_DEPTH);
    for (unsigned i = 0; i < test_notification_count; i++) {
        zassert_equal(test_notifications[i].notification_type.frame_stream_chunk.offset, i * 32);
    }
}

ZTEST(relay, test_failed_stop_is_retried_and_new_start_retires_retry) {
    test_stop_error = -ENOMEM;
    test_lock();
    zassert_true(stop_pending);
    zassert_equal(test_stop_count, 1);
    test_stop_error = 0;
    k_sleep(K_MSEC(25));
    test_drain_queue();
    zassert_false(stop_pending);
    zassert_equal(test_stop_count, 2);
    test_stop_error = -ENOMEM;
    pmw3610_relay_revoke_session();
    test_lock_state = ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
    request(true);
    unsigned count = test_stop_count;
    k_sleep(K_MSEC(25));
    test_drain_queue();
    zassert_equal(test_stop_count, count);
}

#else
static struct zmk_pmw3610_relay_request request(uint32_t id, bool stream) {
    cormoran_pmw3610_RelayRequest request = cormoran_pmw3610_RelayRequest_init_zero;
    request.request_id = id;
    request.has_request = true;
    request.request.which_request_type = stream ? cormoran_pmw3610_Request_set_frame_stream_tag
                                                : cormoran_pmw3610_Request_get_info_tag;
    if (stream)
        request.request.request_type.set_frame_stream.enable = true;
    struct zmk_pmw3610_relay_request event = {.source = 1};
    pb_ostream_t stream_out = pb_ostream_from_buffer(event.payload, sizeof(event.payload));
    zassert_true(pb_encode(&stream_out, cormoran_pmw3610_RelayRequest_fields, &request));
    event.size = stream_out.bytes_written;
    return event;
}
static void stop(void) {
    struct zmk_pmw3610_relay_stop event = {.source = 1};
    on_pmw3610_relay_stop(&event);
}
ZTEST(relay, test_busy_queue_preserves_each_request) {
    test_block_queue();
    for (unsigned i = 0; i < 4; i++) {
        struct zmk_pmw3610_relay_request event = request(i + 1, false);
        on_pmw3610_relay_request(&event);
    }
    test_release_queue();
    test_drain_queue();
    zassert_equal(test_response_count, 4);
    for (unsigned i = 0; i < 4; i++)
        zassert_equal(test_responses[i].request_id, i + 1);
}
ZTEST(relay, test_stop_bypasses_full_queue_and_retires_pending_starts) {
    test_block_queue();
    for (unsigned i = 0; i < CONFIG_ZMK_PMW3610_RELAY_QUEUE_DEPTH; i++) {
        struct zmk_pmw3610_relay_request event = request(i + 1, true);
        on_pmw3610_relay_request(&event);
    }
    stop();
    test_release_queue();
    test_drain_queue();
    zassert_equal(test_begin_calls[0], 0);
    zassert_equal(test_response_count, 0);
}
ZTEST(relay, test_stop_during_admitted_begin_leaves_no_session) {
    test_begin_hook = stop;
    struct zmk_pmw3610_relay_request event = request(1, true);
    on_pmw3610_relay_request(&event);
    test_drain_queue();
    zassert_equal(test_begin_calls[0], 1);
    zassert_equal(test_end_calls[0], 1);
    zassert_false(test_sensor_capturing[0]);
    zassert_equal(test_notification_count, 0);
    zassert_equal(test_response_count, 0);
}

ZTEST(relay, test_disconnect_retires_queued_stream_start) {
    test_block_queue();
    struct zmk_pmw3610_relay_request event = request(1, true);
    on_pmw3610_relay_request(&event);
    test_disconnect();
    test_release_queue();
    test_drain_queue();
    zassert_equal(test_begin_calls[0], 0);
    zassert_equal(test_response_count, 0);
}
#endif

ZTEST_SUITE(relay, NULL, NULL, before, NULL, NULL);
