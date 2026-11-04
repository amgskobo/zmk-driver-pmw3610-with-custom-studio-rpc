#include "fixtures.h"
#include <stdio.h>
#include <pb_decode.h>
#include <pb_encode.h>
#include <zephyr/sys/atomic.h>
#include <cormoran/pmw3610/pmw3610_api.h>
#include <zmk/studio/custom.h>
#include <zmk/split/central.h>

static struct k_work_q queue;
K_THREAD_STACK_DEFINE(queue_stack, 8192);
K_SEM_DEFINE(gate_entered, 0, 1);
K_SEM_DEFINE(gate_release, 0, 1);
static atomic_t gate_owned;
bool test_sensor_capturing[2];
unsigned test_begin_calls[2], test_end_calls[2];
bool test_cancel_begin, test_cancel_read, test_fail_read;
void (*test_begin_hook)(void);
unsigned test_notification_count, test_response_count, test_request_count, test_stop_count;
cormoran_pmw3610_Notification test_notifications[64];
cormoran_pmw3610_RelayResponse test_responses[64];
int test_stop_error;
enum zmk_studio_core_lock_state test_lock_state = ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
static struct device devices[2];

struct k_work_q *zmk_workqueue_lowprio_work_q(void) { return &queue; }
void test_start_queue(void) {
    static bool started;
    if (!started) {
        k_work_queue_start(&queue, queue_stack, K_THREAD_STACK_SIZEOF(queue_stack), 5, NULL);
        started = true;
    }
}
static void gate_handler(struct k_work *work) {
    ARG_UNUSED(work);
    k_sem_give(&gate_entered);
    k_sem_take(&gate_release, K_FOREVER);
}
K_WORK_DEFINE(gate, gate_handler);
void test_block_queue(void) {
    zassert_equal(k_work_busy_get(&gate), 0);
    zassert_true(atomic_cas(&gate_owned, 0, 1));
    k_sem_reset(&gate_entered);
    k_sem_reset(&gate_release);
    k_work_submit_to_queue(&queue, &gate);
    zassert_ok(k_sem_take(&gate_entered, K_SECONDS(2)));
}
void test_release_queue(void) {
    /* A failed case and its cleanup may both release the same gate. */
    if (atomic_cas(&gate_owned, 1, 0)) {
        k_sem_give(&gate_release);
    }
}
void test_drain_queue(void) {
    k_work_queue_drain(&queue, false);
    /* The gate handler has returned, so neither reset can steal its permit. */
    k_sem_reset(&gate_entered);
    k_sem_reset(&gate_release);
}
void test_clear_sinks(void) {
    test_notification_count = test_response_count = test_request_count = test_stop_count = 0;
    test_stop_error = 0;
    test_cancel_begin = test_cancel_read = false;
    test_fail_read = false;
    test_begin_hook = NULL;
    memset(test_begin_calls, 0, sizeof(test_begin_calls));
    memset(test_end_calls, 0, sizeof(test_end_calls));
}
enum zmk_studio_core_lock_state zmk_studio_core_get_lock_state(void) { return test_lock_state; }
int zmk_split_central_send_relay_event(struct zmk_split_relay_event_payload *payload) {
    zassert_mem_equal(payload->event_type, "pms", 3);
    zassert_equal(payload->header.event_data_size, 1);
    test_stop_count++;
    return test_stop_error;
}
void test_record_notification(const uint8_t *payload, size_t size) {
    zassert_true(test_notification_count < ARRAY_SIZE(test_notifications));
    pb_istream_t stream = pb_istream_from_buffer(payload, size);
    zassert_true(pb_decode(&stream, cormoran_pmw3610_Notification_fields,
                           &test_notifications[test_notification_count++]));
}
int raise_zmk_studio_custom_notification(struct zmk_studio_custom_notification event) {
    uint8_t payload[cormoran_pmw3610_Notification_size];
    pb_ostream_t stream = pb_ostream_from_buffer(payload, sizeof(payload));
    zassert_true(event.encode_payload.funcs.encode(&stream, NULL, &event.encode_payload.arg));
    test_record_notification(payload, stream.bytes_written);
    return 0;
}
size_t pmw3610_device_count(void) { return 2; }
const struct device *pmw3610_get_device(size_t index) { return index < 2 ? &devices[index] : NULL; }
bool pmw3610_is_ready(const struct device *device) { return device != NULL; }
int pmw3610_get_init_error(const struct device *device) { return device ? 0 : -ENODEV; }
int pmw3610_get_device_id(const struct device *device, char *buffer, size_t length) {
    ARG_UNUSED(device);
    snprintf(buffer, length, "synthetic");
    return 0;
}
int pmw3610_read_register(const struct device *device, uint8_t address, uint8_t *value) {
    ARG_UNUSED(device);
    *value = address;
    return 0;
}
int pmw3610_write_register(const struct device *device, uint8_t address, uint8_t value) {
    ARG_UNUSED(device);
    ARG_UNUSED(address);
    ARG_UNUSED(value);
    return 0;
}
int pmw3610_read_diagnostics(const struct device *device, struct pmw3610_diagnostics *out) {
    ARG_UNUSED(device);
    memset(out, 0, sizeof(*out));
    return 0;
}
int pmw3610_get_runtime_config(const struct device *device, struct pmw3610_runtime_config *out) {
    ARG_UNUSED(device);
    memset(out, 0, sizeof(*out));
    return 0;
}
int pmw3610_frame_capture_begin(const struct device *device,
                                const struct pmw3610_frame_capture_params *params) {
    ARG_UNUSED(params);
    unsigned index = device - devices;
    zassert_false(test_sensor_capturing[index]);
    test_sensor_capturing[index] = true;
    test_begin_calls[index]++;
    if (test_begin_hook)
        test_begin_hook();
    if (test_cancel_begin)
        pmw3610_request_stop_stream();
    return 0;
}
int pmw3610_frame_capture_read(const struct device *device,
                               const struct pmw3610_frame_capture_params *params, uint8_t *buffer,
                               uint16_t length, struct pmw3610_frame_capture_result *result) {
    zassert_true(test_sensor_capturing[device - devices]);
    result->pixel_count = MIN(params->pixel_count ? params->pixel_count : 484, length);
    memset(buffer, 0x81, result->pixel_count);
    if (test_fail_read) {
        buffer[0] = 0x9a;
        pmw3610_request_stop_stream();
        return -EIO;
    }
    result->complete = true;
    if (test_cancel_read)
        pmw3610_request_stop_stream();
    return 0;
}
int pmw3610_frame_capture_end(const struct device *device) {
    unsigned index = device - devices;
    zassert_true(test_sensor_capturing[index]);
    test_sensor_capturing[index] = false;
    test_end_calls[index]++;
    return 0;
}
int pmw3610_capture_frame(const struct device *device,
                          const struct pmw3610_frame_capture_params *params, uint8_t *buffer,
                          uint16_t length, struct pmw3610_frame_capture_result *result) {
    pmw3610_frame_capture_begin(device, params);
    int err = pmw3610_frame_capture_read(device, params, buffer, length, result);
    int end_err = pmw3610_frame_capture_end(device);
    return err ? err : end_err;
}
