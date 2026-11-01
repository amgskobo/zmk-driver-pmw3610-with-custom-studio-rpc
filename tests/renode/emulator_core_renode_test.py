#!/usr/bin/env python3
"""A stale NVIC line must not turn its no-pending sentinel into a vector.

Run through tools/renode_core.py. Both cases boot the same synthetic program;
the negative control uses the untouched installation, and the positive control
also delivers a real IRQ after the stale line. No PMW or ZMK code is in it.
"""

import json
import os
import re
import shutil
import struct
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ASSEMBLY = """.syntax unified
.cpu cortex-m4
.thumb
.section .text
.global start
.thumb_func
start:
 ldr r0, =0x20000000
1:
 ldr r1, [r0]
 adds r1, #1
 str r1, [r0]
 b 1b
.org 0x40
.thumb_func
irq0:
 ldr r0, =0x20000004
 ldr r1, [r0]
 adds r1, #1
 str r1, [r0]
 bx lr
.org 0x80
.thumb_func
trap:
 ldr r0, =0x20000008
 movs r1, #1
 str r1, [r0]
1:
 b 1b
.ltorg
"""

PROBE = """using Antmicro.Renode.Core;
using Antmicro.Renode.Peripherals;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.IRQControllers;
namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class CoreIrqProbe : IDoubleWordPeripheral, IKnownSize
    {
        public CoreIrqProbe(NVIC nvic) { this.nvic = nvic; }
        public uint ReadDoubleWord(long offset) { return 0; }
        public void WriteDoubleWord(long offset, uint value)
        {
            if(value == 1) { nvic.IRQ.Set(true); }
        }
        public void Reset() { }
        public long Size { get { return 4; } }
        private readonly NVIC nvic;
    }
}
"""


class EmulatorCoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = os.environ["ZMK_RENODE_BINARY"]
        cls.loader = os.environ["ZMK_RENODE_LOADER_DIR"]
        cls.directory = Path(
            tempfile.mkdtemp(prefix="renode-core-", dir=os.environ.get("TMPDIR"))
        )
        assembler = shutil.which("arm-zephyr-eabi-as")
        if not assembler:
            sdk = os.environ.get("ZEPHYR_SDK_INSTALL_DIR")
            roots = [Path(sdk)] if sdk else list(Path("/opt").glob("zephyr-sdk-*"))
            candidates = [p / "arm-zephyr-eabi/bin/arm-zephyr-eabi-as" for p in roots]
            candidates = [p for p in candidates if p.is_file()]
            if len(candidates) != 1:
                raise RuntimeError("Select the Zephyr SDK with ZEPHYR_SDK_INSTALL_DIR")
            assembler = str(candidates[0])
        prefix = assembler.removesuffix("as")
        source = cls.directory / "probe.S"
        source.write_text(ASSEMBLY)
        for command in (
            [
                assembler,
                "-mcpu=cortex-m4",
                "-mthumb",
                str(source),
                "-o",
                str(cls.directory / "probe.o"),
            ],
            [
                prefix + "ld",
                "-Ttext=0x100",
                "--entry=start",
                str(cls.directory / "probe.o"),
                "-o",
                str(cls.directory / "probe.elf"),
            ],
            [
                prefix + "objcopy",
                "-O",
                "binary",
                str(cls.directory / "probe.elf"),
                str(cls.directory / "text.bin"),
            ],
        ):
            subprocess.run(command, check=True, capture_output=True)
        image = bytearray(0x1000)
        for index in range(64):
            struct.pack_into("<I", image, index * 4, 0x181)
        struct.pack_into("<I", image, 0, 0x20001000)
        struct.pack_into("<I", image, 4, 0x101)
        struct.pack_into("<I", image, 16 * 4, 0x141)
        text = (cls.directory / "text.bin").read_bytes()
        image[0x100 : 0x100 + len(text)] = text
        # Deliberately invalid synthetic vector, independent of firmware layout.
        struct.pack_into("<I", image, 528 * 4, 0xDEADBEEF)
        (cls.directory / "probe.bin").write_bytes(image)
        (cls.directory / "CoreIrqProbe.cs").write_text(PROBE)
        platform = cls.directory / "probe.repl"
        platform.write_text(
            "nvic: IRQControllers.NVIC @ sysbus 0xE000E000\n    -> cpu@0\n"
            '\ncpu: CPU.CortexM @ sysbus\n    nvic: nvic\n    cpuType: "cortex-m4"\n'
            "\nflash: Memory.MappedMemory @ sysbus 0x0\n    size: 0x1000\n"
            "\nram: Memory.MappedMemory @ sysbus 0x20000000\n    size: 0x1000\n"
            "\nprobe: Miscellaneous.CoreIrqProbe @ sysbus 0x60000000\n    nvic: nvic\n"
        )
        cls.script = cls.directory / "probe.resc"
        cls.script.write_text(
            "\n".join(
                [
                    "include @" + str(cls.directory / "CoreIrqProbe.cs"),
                    'mach create "probe"',
                    "machine LoadPlatformDescription @" + str(platform),
                    "sysbus LoadBinary @" + str(cls.directory / "probe.bin") + " 0x0",
                    "sysbus.cpu VectorTableOffset 0x0",
                    "sysbus.cpu SP 0x20001000",
                    "sysbus.cpu PC 0x100",
                    "sysbus.cpu PRIMASK 0",
                    "sysbus WriteDoubleWord 0xe000ed24 0x00070000",
                    'emulation RunFor "0.001"',
                    "sysbus ReadDoubleWord 0x20000000",
                    "sysbus WriteDoubleWord 0x60000000 1",
                    'emulation RunFor "0.001"',
                    "sysbus ReadDoubleWord 0x20000000",
                    "sysbus ReadDoubleWord 0x20000008",
                    "sysbus.cpu GetRegister 25",
                    "sysbus WriteDoubleWord 0xe000e100 1",
                    "sysbus.nvic SetPendingIRQ 16",
                    'emulation RunFor "0.001"',
                    "sysbus ReadDoubleWord 0x20000004",
                    "quit",
                    "",
                ]
            )
        )

    def _run(self, patched):
        name = "patched" if patched else "stock"
        directory = self.directory / name
        directory.mkdir()
        (directory / "tmp").mkdir()
        env = dict(
            os.environ,
            TMPDIR=str(directory / "tmp"),
            ZMK_RENODE_CORE_LOG=str(directory / "loader.log"),
        )
        if not patched:
            env["LD_LIBRARY_PATH"] = ":".join(
                p for p in env.get("LD_LIBRARY_PATH", "").split(":") if p != self.loader
            )
            env.pop("ZMK_RENODE_TLIB", None)
        output = directory / "output.log"
        command = [
            self.binary,
            "--disable-xwt",
            "--console",
            "--plain",
            "-e",
            "i @" + str(self.script),
        ]
        with output.open("w") as log:
            process = subprocess.Popen(
                command, env=env, stdout=log, stderr=subprocess.STDOUT
            )
            try:
                deadline = time.monotonic() + 30
                while process.poll() is None and time.monotonic() < deadline:
                    if (
                        not patched
                        and "CPU abort [PC=0xDEADBEEE]" in output.read_text()
                    ):
                        break
                    time.sleep(0.05)
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
        text = output.read_text()
        values = [int(v, 16) for v in re.findall(r"^0x[0-9a-fA-F]+\s*$", text, re.M)]
        record = {
            "command": command,
            "exit_code": process.returncode,
            "patched": patched,
            "values": values,
        }
        (directory / "run.json").write_text(json.dumps(record, indent=2) + "\n")
        return process.returncode, values, text, directory / "loader.log"

    def test_01_stock_core_reproduces_invalid_vector(self):
        _, _, text, loader_log = self._run(False)
        self.assertIn("CPU abort [PC=0xDEADBEEE]", text, text[-2400:])
        self.assertFalse(loader_log.exists(), "Negative control used the backport")

    def test_02_backport_preserves_thread_and_real_irq(self):
        code, values, text, loader_log = self._run(True)
        self.assertEqual(code, 0, text[-2400:])
        self.assertNotIn("CPU abort", text, text[-2400:])
        self.assertIn("NVIC spurious acknowledgement ignored", text)
        self.assertEqual(len(values), 5, text[-2400:])
        self.assertGreater(values[1], values[0], "Thread stopped after the stale IRQ")
        self.assertEqual(values[2], 0, "Fault trap was entered")
        self.assertEqual(values[3] & 0x1FF, 0, "Thread retained a bogus exception")
        self.assertGreater(values[4], 0, "Real IRQ was lost after the stale IRQ")
        self.assertEqual(loader_log.read_text().splitlines(), ["cpu-library-replaced"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
