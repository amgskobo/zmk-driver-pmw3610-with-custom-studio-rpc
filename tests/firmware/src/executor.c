#include "fixtures.h"
/* Include the full production implementation to exercise its private session
 * transitions without exposing test hooks in production builds. */
#include "../../../src/studio/pmw3610_request_exec.c"

static void before(void *fixture) {
    ARG_UNUSED(fixture);
    test_start_queue();
    test_lock_state = ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
    pmw3610_request_stop_stream();
    k_work_flush_delayable(&frame_stream_work, &(struct k_work_sync){0});
    test_drain_queue();
    zassert_false(test_sensor_capturing[0]);
    zassert_false(test_sensor_capturing[1]);
    test_clear_sinks();
}

static cormoran_pmw3610_Response start(uint32_t index) {
    cormoran_pmw3610_Request request = cormoran_pmw3610_Request_init_zero;
    request.which_request_type = cormoran_pmw3610_Request_set_frame_stream_tag;
    request.request_type.set_frame_stream.enable = true;
    request.request_type.set_frame_stream.device_index = index;
    request.request_type.set_frame_stream.pixel_count = 484;
    cormoran_pmw3610_Response response = cormoran_pmw3610_Response_init_zero;
    zassert_true(pmw3610_request_exec_handle(&request, &response));
    return response;
}

void test_lock(void) {
    test_lock_state = ZMK_STUDIO_CORE_LOCK_STATE_LOCKED;
#if !PMW3610_IS_SPLIT_PERIPHERAL
    struct zmk_studio_core_lock_state_changed event = {.state = test_lock_state};
    on_studio_core_lock_state_changed(&event);
#endif
}

void test_disconnect(void) {
#if PMW3610_IS_SPLIT_PERIPHERAL
    struct zmk_split_peripheral_status_changed event = {.connected = false};
    on_split_peripheral_status_changed(&event);
#endif
}

ZTEST(sessions, test_retarget_rejected_and_original_sensor_released) {
    test_block_queue();
    cormoran_pmw3610_Response response = start(0);
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_set_frame_stream_tag);
    response = start(1);
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_error_tag);
    zassert_true(test_sensor_capturing[0]);
    zassert_false(test_sensor_capturing[1]);
    response = start(0);
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_set_frame_stream_tag);
    pmw3610_request_stop_stream();
    /* A restart cannot steal ownership before the previous worker cleans up. */
    response = start(1);
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_error_tag);
    test_release_queue();
    test_drain_queue();
    zassert_equal(test_begin_calls[0], 1);
    zassert_equal(test_end_calls[0], 1);
    zassert_equal(test_end_calls[1], 0);
    test_block_queue();
    response = start(1);
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_set_frame_stream_tag);
    pmw3610_request_stop_stream();
    test_release_queue();
    test_drain_queue();
    zassert_equal(test_begin_calls[1], 1);
    zassert_equal(test_end_calls[1], 1);
}

ZTEST(sessions, test_cancel_during_begin_releases_sensor) {
    test_cancel_begin = true;
    cormoran_pmw3610_Response response = start(0);
    test_drain_queue();
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_error_tag);
    zassert_equal(test_begin_calls[0], 1);
    zassert_equal(test_end_calls[0], 1);
    zassert_false(test_sensor_capturing[0]);
    zassert_equal(test_notification_count, 0);
}

ZTEST(sessions, test_cancel_during_read_sends_no_chunks) {
    test_block_queue();
    test_cancel_read = true;
    cormoran_pmw3610_Response response = start(0);
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_set_frame_stream_tag);
    test_release_queue();
    test_drain_queue();
    zassert_equal(test_end_calls[0], 1);
    zassert_equal(test_notification_count, 0);
}

ZTEST(sessions, test_one_shot_rejected_until_stream_cleanup) {
    test_block_queue();
    start(0);
    pmw3610_request_stop_stream();
    cormoran_pmw3610_Request request = cormoran_pmw3610_Request_init_zero;
    cormoran_pmw3610_Response response = cormoran_pmw3610_Response_init_zero;
    request.which_request_type = cormoran_pmw3610_Request_capture_frame_tag;
    zassert_true(pmw3610_request_exec_handle(&request, &response));
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_error_tag);
    test_release_queue();
    test_drain_queue();
    zassert_true(pmw3610_request_exec_handle(&request, &response));
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_capture_frame_tag);
    zassert_equal(test_begin_calls[0], 2);
    zassert_equal(test_end_calls[0], 2);
}

ZTEST(sessions, test_lock_or_disconnect_retires_pending_stream) {
    test_block_queue();
    start(0);
#if PMW3610_IS_SPLIT_PERIPHERAL
    struct zmk_split_peripheral_status_changed event = {.connected = false};
    on_split_peripheral_status_changed(&event);
#else
    test_lock();
    zassert_equal(test_stop_count, 1);
#endif
    test_release_queue();
    test_drain_queue();
    zassert_equal(test_notification_count, 0);
    zassert_equal(test_end_calls[0], 1);
}

ZTEST_SUITE(sessions, NULL, NULL, before, NULL, NULL);
