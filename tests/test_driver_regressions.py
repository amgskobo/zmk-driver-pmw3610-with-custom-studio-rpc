"""Run the production sensor driver with real kernel synchronization and synthetic SPI."""

import os
from pathlib import Path
import subprocess
import unittest


class DriverRegressions(unittest.TestCase):
    def test_driver_boundary(self):
        owner = Path(__file__).resolve().parents[1]
        topdir = subprocess.check_output(
            ["west", "topdir"], cwd=owner, text=True
        ).strip()
        output = Path(os.environ.get("OWNER_TEST_OUTPUT", str(Path(topdir) / "build")))
        output.mkdir(parents=True, exist_ok=True)
        build = output / "driver-boundary"
        self.assertFalse(build.exists(), "Select a fresh owner output directory")
        command = [
            "west",
            "build",
            "-b",
            "native_sim/native/64",
            "-d",
            str(build),
            str(owner / "tests/driver-boundary"),
        ]
        result = subprocess.run(
            command,
            cwd=owner,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        (output / "driver-boundary-build.log").write_text(result.stdout)
        self.assertEqual(result.returncode, 0, result.stdout)
        for repeat in range(3):
            state = build / ("run-" + str(repeat))
            state.mkdir()
            execution = subprocess.run(
                [str(build / "zephyr/zephyr.exe")],
                cwd=state,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=30,
            )
            (state / "execution.log").write_text(execution.stdout)
            self.assertEqual(execution.returncode, 0, execution.stdout)
            self.assertIn("PROJECT EXECUTION SUCCESSFUL", execution.stdout)
            self.assertIn("TESTSUITE driver succeeded", execution.stdout)
            self.assertNotIn("SKIP -", execution.stdout)
