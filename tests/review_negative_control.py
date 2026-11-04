"""Restore one reviewed defect in an isolated owner source copy only.

Build the same owner assertions against that copy and require an executable
assertion failure. A compile/link failure does not establish a negative control.
"""

import argparse
from pathlib import Path
import re


FAULTS = {
    "force-awake": (
        "src/pmw3610.c",
        "    if (force_awake_runtime && enabled) {",
        "    if (enabled) {",
    ),
    "page-cleanup": (
        "src/pmw3610.c",
        "int page_err = err ? pmw3610_write_reg(dev, PMW3610_REG_SPI_PAGE0, 0x00) : 0;",
        "int page_err = 0;",
    ),
    "motion-queue": (
        "src/pmw3610.c",
        "k_work_submit_to_queue(zmk_workqueue_lowprio_work_q(), &data->trigger_work);",
        "k_work_submit(&data->trigger_work);",
    ),
    "motion-lock": (
        "src/pmw3610.c",
        "struct pixart_runtime_config rt = data->runtime;\n\n"
        "    uint32_t report_interval_min_ms",
        "struct pixart_runtime_config rt = data->runtime;\n"
        "    k_mutex_unlock(&data->lock);\n\n"
        "    uint32_t report_interval_min_ms",
    ),
    "read-lock": (
        "src/pmw3610.c",
        "int err = pmw3610_read_reg(dev, addr, value);\n"
        "    k_mutex_unlock(&data->lock);",
        "k_mutex_unlock(&data->lock);\n"
        "    int err = pmw3610_read_reg(dev, addr, value);",
    ),
    "lease-expiry": (
        "src/studio/pmw3610_request_exec.c",
        "bool expired = frame_stream_lease_deadline != 0 &&",
        "bool expired = false && frame_stream_lease_deadline != 0 &&",
    ),
    "stale-frame": (
        "src/studio/pmw3610_request_exec.c",
        "frame_len = 0;\n    int err = pmw3610_capture_frame",
        "int err = pmw3610_capture_frame",
    ),
    "late-renewal": (
        "src/studio/pmw3610_request_exec.c",
        "if (req->renew_only) {",
        "if (false && req->renew_only) {",
    ),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fault", choices=FAULTS)
    parser.add_argument("isolated_owner", type=Path)
    args = parser.parse_args()
    owner = Path(__file__).resolve().parents[1]
    isolated = args.isolated_owner.resolve()
    if isolated == owner or isolated.is_relative_to(owner):
        parser.error("The negative control requires an isolated container source copy")
    relative, old, new = FAULTS[args.fault]
    source = isolated / relative
    content = source.read_text()
    pattern = r"\s+".join(re.escape(token) for token in old.split())
    if len(list(re.finditer(pattern, content))) != 1:
        parser.error(
            "The selected source does not have exactly one expected control site"
        )
    source.write_text(re.sub(pattern, lambda _: new, content, count=1))
    print("Applied isolated negative control: " + args.fault)


if __name__ == "__main__":
    main()
