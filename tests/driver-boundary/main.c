#include <zephyr/ztest.h>
#include "../../src/pmw3610.c"

/* Only SPI/GPIO/activity are synthetic. The production driver, its mutex,
 * timers and workqueue execution use the selected Zephyr implementation. */
static struct pixart_data sensor_data;
static uint8_t registers[2][128];
static unsigned page, spi_calls, write_calls, fail_write;
static struct k_work_q lowprio;
K_THREAD_STACK_DEFINE(lowprio_stack, 4096);
K_SEM_DEFINE(heartbeat_seen, 0, 1);

struct k_work_q *zmk_workqueue_lowprio_work_q(void) { return &lowprio; }
enum zmk_activity_state zmk_activity_get_state(void) { return ZMK_ACTIVITY_ACTIVE; }

static int spi_exchange(const struct device *bus, const struct spi_config *config,
                        const struct spi_buf_set *tx, const struct spi_buf_set *rx) {
    ARG_UNUSED(bus);
    ARG_UNUSED(config);
    zassert_equal(sensor_data.lock.owner, k_current_get(), "SPI escaped the sensor mutex");
    spi_calls++;
    zassert_not_null(tx);
    const uint8_t *bytes = tx->buffers[0].buf;
    uint8_t address = bytes[0] & 0x7f;
    if (!rx) {
        write_calls++;
        if (write_calls == fail_write)
            return -EIO;
        if (address == PMW3610_REG_SPI_PAGE0) {
            page = bytes[1] != 0;
        } else {
            registers[page][address] = bytes[1];
        }
    } else {
        unsigned offset = 0;
        for (size_t i = 0; i < rx->count; i++) {
            uint8_t *destination = rx->buffers[i].buf;
            if (!destination)
                continue;
            for (size_t j = 0; j < rx->buffers[i].len; j++) {
                uint8_t start = address == PMW3610_REG_MOTION_BURST ? PMW3610_REG_MOTION : address;
                destination[j] = registers[page][(start + offset++) & 0x7f];
            }
        }
    }
    return 0;
}

static int gpio_interrupt(const struct device *port, gpio_pin_t pin, enum gpio_int_mode mode,
                          enum gpio_int_trig trigger) {
    ARG_UNUSED(port);
    ARG_UNUSED(pin);
    ARG_UNUSED(mode);
    ARG_UNUSED(trigger);
    return 0;
}

static const struct spi_driver_api spi_api = {.transceive = spi_exchange};
static const struct device spi_bus = {.name = "synthetic-spi", .api = &spi_api};
static const struct gpio_driver_api gpio_api = {.pin_interrupt_configure = gpio_interrupt};
static const struct gpio_driver_config gpio_config = {.port_pin_mask = UINT32_MAX};
static struct gpio_driver_data gpio_data;
static const struct device gpio_port = {
    .name = "synthetic-gpio", .api = &gpio_api, .config = &gpio_config, .data = &gpio_data};
static const struct pixart_config sensor_config = {
    .spi = {.bus = &spi_bus, .config = {.operation = SPI_WORD_SET(8)}},
    .irq_gpio = {.port = &gpio_port, .pin = 0},
};
static const struct device sensor = {
    .name = "synthetic-sensor", .data = &sensor_data, .config = &sensor_config};

static void heartbeat(struct k_work *work) {
    ARG_UNUSED(work);
    k_sem_give(&heartbeat_seen);
}
K_WORK_DEFINE(heartbeat_work, heartbeat);

static void *setup(void) {
    k_work_queue_start(&lowprio, lowprio_stack, K_THREAD_STACK_SIZEOF(lowprio_stack), 5, NULL);
    return NULL;
}

static void before(void *fixture) {
    ARG_UNUSED(fixture);
    k_work_queue_drain(&lowprio, false);
    memset(&sensor_data, 0, sizeof(sensor_data));
    memset(registers, 0, sizeof(registers));
    k_mutex_init(&sensor_data.lock);
    sensor_data.dev = &sensor;
    sensor_data.ready = true;
    sensor_data.runtime.force_awake = true;
    sensor_data.runtime.cpi = 600;
    sensor_data.runtime.run_downshift_ms = 128;
    k_work_init(&sensor_data.trigger_work, pmw3610_work_callback);
    k_work_init(&sensor_data.activity_work, pmw3610_activity_work_callback);
    k_work_init_delayable(&sensor_data.init_work, pmw3610_async_init);
    page = spi_calls = write_calls = fail_write = 0;
    k_sem_reset(&heartbeat_seen);
}

ZTEST(driver, test_force_awake_off_clears_hardware_and_preserves_low_bits) {
    registers[0][PMW3610_REG_PERFORMANCE] = 0xf1;
    zassert_ok(pmw3610_set_force_awake(&sensor, false));
    zassert_equal(registers[0][PMW3610_REG_PERFORMANCE], 0x01);
    zassert_false(sensor_data.runtime.force_awake);
    zassert_ok(pmw3610_set_force_awake(&sensor, true));
    zassert_equal(registers[0][PMW3610_REG_PERFORMANCE], 0xf1);
}

ZTEST(driver, test_failed_cpi_restores_page_zero_and_clock) {
    fail_write = 3; /* resolution write after selecting page one */
    zassert_equal(pmw3610_set_cpi_runtime(&sensor, 800), -EIO);
    zassert_equal(page, 0);
    zassert_equal(registers[0][PMW3610_REG_SPI_CLK_ON_REQ], PMW3610_SPI_CLOCK_CMD_DISABLE);
    fail_write = 0;
    zassert_ok(pmw3610_set_cpi_runtime(&sensor, 600));
    zassert_equal(registers[1][PMW3610_REG_RES_STEP & 0x7f], 3);
    zassert_equal(page, 0);
}

ZTEST(driver, test_failed_clock_enable_skips_payload_and_failed_payload_still_disables_clock) {
    fail_write = 1;
    zassert_equal(pmw3610_write_register(&sensor, PMW3610_REG_PERFORMANCE, 0xf1), -EIO);
    zassert_equal(registers[0][PMW3610_REG_PERFORMANCE], 0);
    zassert_equal(registers[0][PMW3610_REG_SPI_CLK_ON_REQ], PMW3610_SPI_CLOCK_CMD_DISABLE);
    fail_write = write_calls + 2;
    zassert_equal(pmw3610_write_register(&sensor, PMW3610_REG_PERFORMANCE, 0xf1), -EIO);
    zassert_equal(registers[0][PMW3610_REG_SPI_CLK_ON_REQ], PMW3610_SPI_CLOCK_CMD_DISABLE);
}

ZTEST(driver, test_recovery_restores_page_before_reset) {
    page = 1;
    k_mutex_lock(&sensor_data.lock, K_FOREVER);
    zassert_ok(pmw3610_async_init_power_up(&sensor));
    k_mutex_unlock(&sensor_data.lock);
    zassert_equal(page, 0);
    zassert_equal(registers[0][PMW3610_REG_POWER_UP_RESET], PMW3610_POWERUP_CMD_RESET);
    zassert_equal(registers[1][PMW3610_REG_POWER_UP_RESET], 0);
}

ZTEST(driver, test_failed_pixel_grab_arm_restores_page_and_clock) {
    fail_write = 3; /* page-one magic write */
    uint8_t pixels[4];
    uint16_t collected;
    struct pmw3610_frame_capture_result result = {0};
    k_mutex_lock(&sensor_data.lock, K_FOREVER);
    zassert_equal(pmw3610_frame_capture_read_pixel_grab_locked(&sensor, pixels, sizeof(pixels), 1,
                                                               k_uptime_get() + 1000, &result,
                                                               &collected),
                  -EIO);
    k_mutex_unlock(&sensor_data.lock);
    zassert_equal(collected, 0);
    zassert_equal(page, 0);
    zassert_equal(registers[0][PMW3610_REG_SPI_CLK_ON_REQ], PMW3610_SPI_CLOCK_CMD_DISABLE);
}

ZTEST(driver, test_motion_and_raw_reads_hold_sensor_mutex) {
    sensor_data.runtime.smart_algorithm = true;
    registers[0][PMW3610_REG_SHUTTER_LOWER] = 50;
    zassert_ok(pmw3610_report_data(&sensor));
    zassert_true(sensor_data.sw_smart_flag);
    uint8_t value;
    zassert_ok(pmw3610_read_register(&sensor, PMW3610_REG_PERFORMANCE, &value));
    zassert_true(spi_calls > 0);
}

ZTEST(driver, test_activity_does_not_touch_capture_registers) {
    sensor_data.capture_active = true;
    pmw3610_activity_work_callback(&sensor_data.activity_work);
    zassert_equal(spi_calls, 0);
    sensor_data.capture_active = false;
    pmw3610_activity_work_callback(&sensor_data.activity_work);
    zassert_equal(registers[0][PMW3610_REG_PERFORMANCE], 0xf0);
}

ZTEST(driver, test_queued_motion_cannot_block_system_workqueue_on_capture_mutex) {
    k_mutex_lock(&sensor_data.lock, K_FOREVER);
    sensor_data.capture_active = true;
    pmw3610_gpio_callback(NULL, &sensor_data.irq_gpio_cb, 1);
    k_work_submit(&heartbeat_work);
    int heartbeat_result = k_sem_take(&heartbeat_seen, K_MSEC(100));
    k_mutex_unlock(&sensor_data.lock);
    k_work_queue_drain(&lowprio, false);
    zassert_ok(heartbeat_result, "motion occupied system workqueue while capture held its mutex");
    zassert_equal(spi_calls, 0);
}

ZTEST(driver, test_run_downshift_boundaries) {
    zassert_equal(pmw3610_set_run_downshift_ms(&sensor, 31), -EINVAL);
    zassert_ok(pmw3610_set_run_downshift_ms(&sensor, 32));
    zassert_equal(registers[0][PMW3610_REG_RUN_DOWNSHIFT], 1);
    zassert_ok(pmw3610_set_run_downshift_ms(&sensor, 8160));
    zassert_equal(registers[0][PMW3610_REG_RUN_DOWNSHIFT], 255);
    zassert_equal(pmw3610_set_run_downshift_ms(&sensor, 8161), -EINVAL);
}

ZTEST_SUITE(driver, NULL, setup, before, NULL, NULL);
