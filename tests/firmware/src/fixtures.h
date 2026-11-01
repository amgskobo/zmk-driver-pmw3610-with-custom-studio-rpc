#pragma once
#include <zephyr/kernel.h>
#include <zephyr/ztest.h>
#include <cormoran/pmw3610/pmw3610.pb.h>
#include <cormoran/pmw3610/pmw3610_request_exec.h>
#include <zmk/studio/core.h>

extern bool test_sensor_capturing[2];
extern unsigned test_begin_calls[2], test_end_calls[2];
extern bool test_cancel_begin, test_cancel_read;
extern void (*test_begin_hook)(void);
extern unsigned test_notification_count, test_response_count, test_request_count, test_stop_count;
extern cormoran_pmw3610_Notification test_notifications[64];
extern cormoran_pmw3610_RelayResponse test_responses[64];
extern int test_stop_error;
void test_start_queue(void);
void test_block_queue(void);
void test_release_queue(void);
void test_drain_queue(void);
void test_clear_sinks(void);
void test_record_notification(const uint8_t *payload, size_t size);
void test_lock(void);
void test_disconnect(void);
