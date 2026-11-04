#include "fixtures.h"
/* Include the full production implementation to exercise its private session
 * transitions without exposing test hooks in production builds. */
#include "../../../src/studio/pmw3610_request_exec.c"

static void before(void *fixture) {
    ARG_UNUSED(fixture);
    test_start_queue();
    test_lock_state = ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
    pmw3610_request_stop_stream();
    k_timer_stop(&frame_stream_lease_timer);
    test_release_queue();
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

static cormoran_pmw3610_Response renew(uint32_t epoch) {
    cormoran_pmw3610_Request request = cormoran_pmw3610_Request_init_zero;
    request.which_request_type = cormoran_pmw3610_Request_set_frame_stream_tag;
    request.request_type.set_frame_stream.enable = true;
    request.request_type.set_frame_stream.renew_only = true;
    request.request_type.set_frame_stream.stream_epoch = epoch;
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
    zassert_equal(frame_stream_lease_deadline, 0);
}

ZTEST(sessions, test_client_lease_expires_without_queue_progress_or_renewal) {
    test_block_queue();
    uint32_t epoch = start(0).response_type.set_frame_stream.stream_epoch;
    zassert_not_equal(epoch, 0);
    k_sleep(K_MSEC(CONFIG_ZMK_PMW3610_FRAME_STREAM_LEASE_MS + 20));
    zassert_false(atomic_get(&frame_stream_active));
    zassert_true(test_sensor_capturing[0]); /* cleanup still waits for the queue */
    cormoran_pmw3610_Response response = start(0);
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_error_tag);
    test_release_queue();
    test_drain_queue();
    zassert_false(test_sensor_capturing[0]);
    zassert_equal(test_end_calls[0], 1);
    zassert_equal(test_notification_count, 0);
    /* Cleanup has completed: an old renewal must still never start a session. */
    response = renew(epoch);
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_error_tag);
    zassert_equal(test_begin_calls[0], 1);
    zassert_false(test_sensor_capturing[0]);
    test_block_queue();
    uint32_t replacement_epoch = start(0).response_type.set_frame_stream.stream_epoch;
    zassert_not_equal(replacement_epoch, 0);
    zassert_not_equal(replacement_epoch, epoch);
    response = renew(epoch);
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_error_tag);
    response = renew(0);
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_error_tag);
    response = renew(replacement_epoch);
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_set_frame_stream_tag);
    pmw3610_request_stop_stream();
    test_release_queue();
    test_drain_queue();
    zassert_equal(test_end_calls[0], 2);
}

K_SEM_DEFINE(frame_mutex_held, 0, 1);
K_SEM_DEFINE(frame_mutex_release, 0, 1);
K_THREAD_STACK_DEFINE(frame_mutex_stack, 2048);
static struct k_thread frame_mutex_thread;
static bool frame_mutex_thread_started;

static void hold_frame_mutex(void *a, void *b, void *c) {
    ARG_UNUSED(a);
    ARG_UNUSED(b);
    ARG_UNUSED(c);
    k_mutex_lock(&frame_lock, K_FOREVER);
    k_sem_give(&frame_mutex_held);
    k_sem_take(&frame_mutex_release, K_FOREVER);
    k_mutex_unlock(&frame_lock);
}

ZTEST(sessions, test_identical_renewal_extends_lease_while_frame_mutex_is_busy) {
    test_block_queue();
    uint32_t epoch = start(0).response_type.set_frame_stream.stream_epoch;
    int64_t original_deadline = frame_stream_lease_deadline;
    k_thread_create(&frame_mutex_thread, frame_mutex_stack,
                    K_THREAD_STACK_SIZEOF(frame_mutex_stack), hold_frame_mutex, NULL, NULL, NULL, 4,
                    0, K_NO_WAIT);
    frame_mutex_thread_started = true;
    zassert_ok(k_sem_take(&frame_mutex_held, K_SECONDS(2)));
    k_sleep(K_MSEC(CONFIG_ZMK_PMW3610_FRAME_STREAM_LEASE_MS / 2));
    cormoran_pmw3610_Response response = renew(epoch);
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_set_frame_stream_tag);
    zassert_true(frame_stream_lease_deadline > original_deadline);
    zassert_equal(test_begin_calls[0], 1);
    k_sem_give(&frame_mutex_release);
    zassert_ok(k_thread_join(&frame_mutex_thread, K_SECONDS(2)));
    frame_mutex_thread_started = false;
    k_sleep(K_MSEC(CONFIG_ZMK_PMW3610_FRAME_STREAM_LEASE_MS / 2 + 20));
    zassert_true(atomic_get(&frame_stream_active));
    k_sleep(K_MSEC(CONFIG_ZMK_PMW3610_FRAME_STREAM_LEASE_MS / 2 + 20));
    zassert_false(atomic_get(&frame_stream_active));
    test_release_queue();
    test_drain_queue();
    zassert_equal(test_end_calls[0], 1);
}

ZTEST(sessions, test_failed_capture_invalidates_previously_readable_frame) {
    cormoran_pmw3610_Request request = cormoran_pmw3610_Request_init_zero;
    cormoran_pmw3610_Response response = cormoran_pmw3610_Response_init_zero;
    request.which_request_type = cormoran_pmw3610_Request_capture_frame_tag;
    zassert_true(pmw3610_request_exec_handle(&request, &response));
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_capture_frame_tag);
    uint32_t previous_id = response.response_type.capture_frame.frame_id;
    test_fail_read = true;
    zassert_true(pmw3610_request_exec_handle(&request, &response));
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_error_tag);
    request.which_request_type = cormoran_pmw3610_Request_get_frame_chunk_tag;
    request.request_type.get_frame_chunk.frame_id = previous_id;
    request.request_type.get_frame_chunk.offset = 0;
    zassert_true(pmw3610_request_exec_handle(&request, &response));
    zassert_equal(response.which_response_type, cormoran_pmw3610_Response_error_tag);
    zassert_equal(frame_len, 0);
}

static void after(void *fixture) {
    ARG_UNUSED(fixture);
    /* Assertions can leave the queue gate or frame-mutex helper parked. Stop
     * production resubmissions and release both before waiting for cleanup. */
    pmw3610_request_stop_stream();
    k_timer_stop(&frame_stream_lease_timer);
    test_release_queue();
    if (frame_mutex_thread_started) {
        k_sem_give(&frame_mutex_release);
        int ret = k_thread_join(&frame_mutex_thread, K_SECONDS(2));
        if (ret != 0) {
            zassert_ok(ret, "Frame-mutex fixture cleanup did not complete");
            return; /* Do not wait indefinitely on its still-owned mutex. */
        }
        frame_mutex_thread_started = false;
    }
    k_sem_reset(&frame_mutex_held);
    k_sem_reset(&frame_mutex_release);
    k_work_flush_delayable(&frame_stream_work, &(struct k_work_sync){0});
    test_drain_queue();
}

ZTEST_SUITE(sessions, NULL, NULL, before, after, NULL);
