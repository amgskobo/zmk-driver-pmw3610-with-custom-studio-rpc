#!/usr/bin/env python3
"""Hardware-free end-to-end test: a Studio host talks to the split PERIPHERAL's
PMW3610 over an emulated USB+WIRED split, through the split event relay.

Topology (two real nRF52840 images on one Renode session; see
pmw3610_usb_wired_split_lib.py):

    host(USB CDC) --USB(Studio)--> CENTRAL --wired(split relay)--> PERIPHERAL (sim PMW3610)

The host (a Renode DualCdcAcmBridge on the central's USB CDC) issues a PMW3610
`GetInfo(source=0xFFFFFFFF)` custom Studio RPC to the central. The central
answers its own (empty) local devices synchronously AND broadcasts the request
to the peripheral over the split event relay; the peripheral's PMW3610 subsystem
answers and the central forwards it to the host as a `PeripheralResponse` custom
notification. This test asserts that notification carries the peripheral's real
`DeviceInfo` -- product_id 0x3E and ready=true, i.e. the simulated PMW3610 on the
peripheral's SPIM0 answered THROUGH the relay.

This is the "host <-> peripheral PMW3610 via event relay" proof. The usb+wired
path round-trips the large relayed response where a pure-Studio transport can't:
the wired split link (cormoran/zmk#34's relay-event transport) has no radio cap,
and Studio rides the emulated USB CDC. The central enables Studio locking;
the harness presses its &studio_unlock key before secured calls. The final
test lets the real core idle timer lock Studio, verifies the secured gate,
and checks that the peripheral exits capture over the wired stop-control path.

Run via:
  # Prepare the pinned CPU backport first; see README.md.
  west zmk-build tests/zmk-config --build-yaml tests/zmk-config/build-usb-split.yaml -af usb-wired-central
  west zmk-build tests/zmk-config --build-yaml tests/zmk-config/build-usb-split.yaml -af usb-wired-peripheral
  python3 tools/renode_core.py run --cache /tmp/pmw-renode-core -- \
    west zmk-renode-test --mode wired-split \
      --elf build/usb-wired-central/zephyr/zmk.elf \
      --peripheral-elf build/usb-wired-peripheral/zephyr/zmk.elf \
      tests/renode

Named `*_renode_test.py` (not `test_*.py`) so it stays out of `python3 -m
unittest` auto-discovery -- it needs real firmware ELFs. SKIPs if not built.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

try:
    import renode_harness as rh
except ImportError:  # pragma: no cover - local-dev fallback
    for cand in (
        REPO_ROOT / "dependencies" / "zmk-west-commands" / "scripts" / "lib" / "renode",
        REPO_ROOT.parent / "zmk-west-commands" / "scripts" / "lib" / "renode",
    ):
        if cand.is_dir():
            sys.path.insert(0, str(cand))
            import renode_harness as rh  # noqa: F401

            break
    else:
        raise

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pmw3610_usb_wired_split_lib as splitlib  # noqa: E402

PMW3610_PRODUCT_ID = 0x3E
# Single custom subsystem on the central -> deterministic index 0 (see the
# template's KNOWN_SUBSYSTEM_INDEX note).
SUBSYSTEM_INDEX = 0
# GetInfo sentinel: "list every PMW3610 across the whole keyboard" -- answer the
# central's own local devices synchronously AND broadcast to every peripheral,
# each of which relays back a PeripheralResponse notification.
PMW3610_SOURCE_ALL = 0xFFFFFFFF


def _elf(env_name: str, default_rel: str) -> Path:
    val = os.environ.get(env_name)
    return Path(val) if val else REPO_ROOT / default_rel


def _load_protos():
    # Resolve the selected projects for both supported West layouts. Their
    # checkouts can live beside this module rather than under dependencies/.
    selected = subprocess.check_output(
        [
            "west",
            "list",
            "-f",
            "{name}\t{abspath}",
            "zmk-studio-messages",
            "nanopb",
        ],
        cwd=REPO_ROOT,
        text=True,
    )
    projects = dict(line.split("\t", 1) for line in selected.splitlines())
    studio_proto_dir = Path(projects["zmk-studio-messages"]) / "proto/zmk"
    studio_pb2 = rh.load_studio_pb2(studio_proto_dir)  # also puts out_dir on sys.path
    import custom_pb2  # noqa: E402  (compiled alongside studio_pb2)

    out = rh.compile_protos(
        [REPO_ROOT / "proto" / "cormoran" / "pmw3610" / "pmw3610.proto"],
        include_dirs=[
            REPO_ROOT / "proto",
            studio_proto_dir,
            Path(projects["nanopb"]) / "generator/proto",
        ],
    )
    sys.path.insert(0, str(out))
    from cormoran.pmw3610 import pmw3610_pb2  # noqa: E402

    return studio_pb2, custom_pb2, pmw3610_pb2


class PMW3610UsbWiredSplitRelayTest(unittest.TestCase):
    session = None

    @classmethod
    def setUpClass(cls):
        cls.central = _elf("ZMK_RENODE_ELF", "build/usb-wired-central/zephyr/zmk.elf")
        cls.peripheral = _elf(
            "ZMK_RENODE_PERIPHERAL_ELF", "build/usb-wired-peripheral/zephyr/zmk.elf"
        )
        for name, p in (("central", cls.central), ("peripheral", cls.peripheral)):
            if not p.is_file():
                raise unittest.SkipTest(
                    f"{name} ELF not built: {p} (see this file's header)"
                )

        cls.renode = rh.find_or_install_renode()
        if not cls.renode:
            raise unittest.SkipTest("Renode not available")

        cls.studio_pb2, cls.custom_pb2, cls.pmw3610_pb2 = _load_protos()

        cls.session, cls.c_con, cls.rpc, cls.p_con = splitlib.boot(
            cls.renode,
            cls.central,
            cls.peripheral,
            renode_log=Path(os.environ.get("TMPDIR", "/tmp"))
            / "pmw3610_usb_wired_split_renode.log",
        )

        # Peripheral console (uart0) carries the split-link status + the PMW3610
        # driver's init/motion DBG lines. Collect it in the background as we drive
        # the RPC.
        cls.p_buf = ""
        cls.c_buf = ""

    @classmethod
    def tearDownClass(cls):
        if cls.session is not None:
            # Keep both sides of a failed transport/lock run available for
            # diagnosis; the final assertion alone cannot identify a core
            # fault, a rejected relay packet, or a sensor cleanup failure.
            cls.c_buf += rh.drain_text(cls.c_con._sock, timeout=0.2)
            cls.p_buf += rh.drain_text(cls.p_con._sock, timeout=0.2)
            output = Path(os.environ.get("TMPDIR", "/tmp"))
            (output / "pmw3610-wired-central-console.log").write_text(cls.c_buf)
            (output / "pmw3610-wired-peripheral-console.log").write_text(cls.p_buf)
            for sock in getattr(cls.session, "_cdc_sockets", []):
                try:
                    sock.close()
                except OSError:
                    pass
            try:
                cls.c_con.close()
                cls.p_con.close()
            except OSError:
                pass
            cls.session.stop()
            for name, output in (("central", cls.c_buf), ("peripheral", cls.p_buf)):
                if "MPU FAULT" in output or "ZEPHYR FATAL ERROR" in output:
                    raise AssertionError(
                        f"{name} firmware fault (console tail):\n{output[-2400:]}"
                    )

    def _getinfo_request(self, source: int) -> bytes:
        """Unframed zmk.Request{custom:{call:{subsystem_index, payload=pmw3610
        Request{get_info{source}}}}} (RpcSocket.send() adds the SOF/ESC/EOF frame)."""
        pmw = self.pmw3610_pb2.Request()
        pmw.get_info.source = source
        cust = self.custom_pb2.Request()
        cust.call.subsystem_index = SUBSYSTEM_INDEX
        cust.call.payload = pmw.SerializeToString()
        req = self.studio_pb2.Request()
        req.request_id = 1
        req.custom.CopyFrom(cust)
        return req.SerializeToString()

    def _drain_peripheral(self, timeout=0.2):
        self.__class__.p_buf += rh.drain_text(self.p_con._sock, timeout=timeout)
        if "MPU FAULT" in self.p_buf or "ZEPHYR FATAL ERROR" in self.p_buf:
            self.fail(
                f"Peripheral firmware fault (console tail):\n{self.p_buf[-2400:]}"
            )

    def test_01_peripheral_pmw3610_initialized(self):
        # Wait for the peripheral driver to init against the simulated sensor.
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline and "PMW3610 initialized" not in self.p_buf:
            self._drain_peripheral()
        self.assertIn(
            "PMW3610 initialized",
            self.p_buf,
            "peripheral's PMW3610 driver never initialized against the simulated "
            f"sensor (peripheral console tail:\n{self.p_buf[-800:]})",
        )

    def test_02_host_received_peripheral_pmw3610_via_relay(self):
        self._unlock_studio()
        # Send GetInfo(source=ALL): the central relays to the peripheral and
        # forwards the answer back as a PeripheralResponse notification.
        self.rpc.send(self._getinfo_request(PMW3610_SOURCE_ALL))

        infos = []
        frames = []
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not infos:
            frame = self.rpc.read_frame(timeout=1.0)
            self._drain_peripheral()
            if frame is None:
                continue
            frames.append(frame)
            infos = self._peripheral_device_infos(frames)

        self.assertTrue(
            infos,
            "host received no relayed PMW3610 PeripheralResponse from the peripheral "
            f"({len(frames)} Studio frames seen; peripheral console tail:\n"
            f"{self.p_buf[-800:]})",
        )
        self.assertTrue(
            any(d.product_id == PMW3610_PRODUCT_ID and d.ready for d in infos),
            "relayed peripheral DeviceInfo did not show a ready PMW3610 "
            f"(product_id 0x{PMW3610_PRODUCT_ID:02x}); got: "
            + ", ".join(f"(pid=0x{d.product_id:02x},ready={d.ready})" for d in infos),
        )

    def _peripheral_device_infos(self, frames):
        """Decode every captured Studio frame and return the PMW3610 DeviceInfos
        delivered as a relayed PeripheralResponse notification. The notification
        rides a top-level zmk.Response whose `notification` oneof carries the
        custom payload:
          Response{notification:{custom:{custom_notification:{subsystem_index,
          payload = pmw3610 Notification{peripheral_response{response:{get_info:
          {devices}}}}}}}}."""
        infos = []
        for payload in frames:
            try:
                resp = self.studio_pb2.Response()
                resp.ParseFromString(payload)
            except Exception:
                continue
            if resp.WhichOneof("type") != "notification":
                continue
            note = resp.notification
            if note.WhichOneof("subsystem") != "custom":
                continue
            cn = note.custom.custom_notification
            if cn.subsystem_index != SUBSYSTEM_INDEX:
                continue
            pnote = self.pmw3610_pb2.Notification()
            try:
                pnote.ParseFromString(cn.payload)
            except Exception:
                continue
            if pnote.WhichOneof("notification_type") != "peripheral_response":
                continue
            pr = pnote.peripheral_response
            if pr.response.WhichOneof("response_type") != "get_info":
                continue
            infos.extend(pr.response.get_info.devices)
        return infos

    def _read_response(self, timeout=0.5):
        frame = self.rpc.read_frame(timeout=timeout)
        if frame is None:
            return None
        response = self.studio_pb2.Response()
        response.ParseFromString(frame)
        return response

    def _custom_notification(self, response):
        if response is None or response.WhichOneof("type") != "notification":
            return None
        note = response.notification
        if note.WhichOneof("subsystem") != "custom":
            return None
        custom = note.custom.custom_notification
        if custom.subsystem_index != SUBSYSTEM_INDEX:
            return None
        notification = self.pmw3610_pb2.Notification()
        notification.ParseFromString(custom.payload)
        return notification

    def _wait_reply(self, request_id):
        deadline = time.monotonic() + 20
        next_console_drain = 0.0
        while time.monotonic() < deadline:
            response = self._read_response()
            # Drain a burst of queued image replies without a console timeout
            # per frame; otherwise a valid reply behind the burst can time out.
            now = time.monotonic()
            if now >= next_console_drain:
                self._drain_peripheral(timeout=0.01)
                self.__class__.c_buf += rh.drain_text(self.c_con._sock, timeout=0.01)
                next_console_drain = now + 0.1
            if (
                response is not None
                and response.WhichOneof("type") == "request_response"
                and response.request_response.request_id == request_id
            ):
                return response.request_response
        self.fail(f"No Studio reply to synthetic request {request_id}")

    def _sensor_reset_count(self):
        command = "spi0.trackball PowerUpResetCount"
        output = self.session.mon.execute(f'mach set "peripheral"; {command}')
        clean = re.sub(r"\x1b\[[0-9;]*m", "", output).replace(command, "")
        tokens = re.findall(r"0x[0-9a-fA-F]+|\b\d+\b", clean)
        self.assertTrue(tokens, f"Sensor reset count missing: {output}")
        return int(tokens[-1], 0)

    def _unlock_studio(self):
        # Peripheral position 2 (xiao_d 2 / P0.28) maps to &studio_unlock.
        # P0.03 is the wired UART RX, so it must not be used for this key.
        self.session.mon.execute('mach set "peripheral"; sysbus.gpio0 OnGPIO 28 true')
        time.sleep(0.1)
        self.session.mon.execute('mach set "peripheral"; sysbus.gpio0 OnGPIO 28 false')
        # Hold the press until the emulated scanner has processed it; a fixed
        # wall-clock pulse can be shorter than the virtual debounce period.
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                state = self.studio_pb2.Request(request_id=190)
                state.core.get_lock_state = True
                self.rpc.send(state.SerializeToString())
                reply = self._wait_reply(190)
                if (
                    reply.WhichOneof("subsystem") == "core"
                    and reply.core.get_lock_state == 1
                ):
                    return
            self.fail(
                "Emulated Studio unlock key did not unlock the central; "
                f"central console tail:\n{self.c_buf[-1200:]}"
            )
        finally:
            self.session.mon.execute(
                'mach set "peripheral"; sysbus.gpio0 OnGPIO 28 true'
            )

    def test_03_core_lock_stops_peripheral_capture_and_secures_rpc(self):
        self._unlock_studio()
        resets = self._sensor_reset_count()
        stream = self.pmw3610_pb2.Request()
        stream.set_frame_stream.source = 1
        stream.set_frame_stream.enable = True
        stream.set_frame_stream.pixel_count = 1
        request = self.studio_pb2.Request(request_id=200)
        request.custom.call.subsystem_index = SUBSYSTEM_INDEX
        request.custom.call.payload = stream.SerializeToString()
        self.rpc.send(request.SerializeToString())
        deadline = time.monotonic() + 25
        started = False
        while time.monotonic() < deadline:
            note = self._custom_notification(self._read_response())
            self._drain_peripheral(timeout=0.01)
            if (
                note is not None
                and note.WhichOneof("notification_type") == "frame_stream_chunk"
            ):
                self.assertEqual(note.frame_stream_chunk.source, 1)
                self.assertGreater(len(note.frame_stream_chunk.data), 0)
                started = True
                break
        self.assertTrue(
            started, "No peripheral image chunk reached the USB Studio host"
        )
        # Notifications do not refresh the core RPC idle timer. Wait for the
        # actual idle lock and the peripheral reset caused by its stop control.
        # Verbose two-machine emulation can advance much slower than wall
        # time. Allow the configured virtual idle timeout and sensor cleanup
        # to run, while still bounding a missing stop and failing on a fatal.
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline and self._sensor_reset_count() == resets:
            self._read_response()
            self._drain_peripheral(timeout=0.01)
        self.assertGreater(
            self._sensor_reset_count(),
            resets,
            "Wired stop did not end peripheral capture",
        )
        state = self.studio_pb2.Request(request_id=202)
        state.core.get_lock_state = True
        self.rpc.send(state.SerializeToString())
        reply = self._wait_reply(202)
        self.assertEqual(reply.WhichOneof("subsystem"), "core")
        self.assertEqual(reply.core.WhichOneof("response_type"), "get_lock_state")
        self.assertEqual(reply.core.get_lock_state, 0)

        denied = self.studio_pb2.Request(request_id=203)
        denied.custom.call.subsystem_index = SUBSYSTEM_INDEX
        denied.custom.call.payload = self.pmw3610_pb2.Request(
            get_info={}
        ).SerializeToString()
        self.rpc.send(denied.SerializeToString())
        reply = self._wait_reply(203)
        self.assertEqual(reply.WhichOneof("subsystem"), "meta")
        self.assertEqual(reply.meta.WhichOneof("response_type"), "simple_error")
        self.assertEqual(reply.meta.simple_error, 1)  # UNLOCK_REQUIRED

        # Drain transport bytes already queued before lock, then require a quiet
        # interval. This does not relabel queued bytes as newly emitted frames.
        deadline = time.monotonic() + 5
        while (
            time.monotonic() < deadline and self._read_response(timeout=0.2) is not None
        ):
            self._drain_peripheral()
        self.assertLess(
            time.monotonic(), deadline, "Image stream did not quiesce after lock"
        )
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            note = self._custom_notification(self._read_response(timeout=0.2))
            self._drain_peripheral(timeout=0.01)
            self.__class__.c_buf += rh.drain_text(self.c_con._sock, timeout=0.01)
            if note is not None:
                self.assertNotEqual(
                    note.WhichOneof("notification_type"), "frame_stream_chunk"
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
