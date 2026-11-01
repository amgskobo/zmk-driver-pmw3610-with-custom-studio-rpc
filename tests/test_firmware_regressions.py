"""Exercise owner C implementations with real Zephyr queues and nanopb.

Sensor, Studio and split transport boundaries are synthetic. This complements
the original ZMK native fixtures, board matrix and Renode transport scenarios.
"""

import os
from pathlib import Path
import subprocess
import unittest


class FirmwareRegressions(unittest.TestCase):
    def test_both_split_roles(self):
        owner = Path(__file__).resolve().parents[1]
        nanopb = subprocess.check_output(
            ["west", "list", "nanopb", "-f", "{abspath}"], cwd=owner, text=True
        ).strip()
        topdir = subprocess.check_output(
            ["west", "topdir"], cwd=owner, text=True
        ).strip()
        output = Path(os.environ.get("OWNER_TEST_OUTPUT", str(Path(topdir) / "build")))
        output.mkdir(parents=True, exist_ok=True)
        for role in ("central", "peripheral"):
            with self.subTest(role=role):
                build = output / ("firmware-regressions-" + role)
                command = [
                    "west",
                    "build",
                    "-p",
                    "always",
                    "-b",
                    "native_sim/native/64",
                    "-d",
                    str(build),
                    str(owner / "tests/firmware"),
                    "--",
                    "-DPMW3610_NANOPB_DIR=" + nanopb,
                    "-DPMW3610_CENTRAL=" + ("ON" if role == "central" else "OFF"),
                ]
                result = subprocess.run(
                    command, cwd=owner, capture_output=True, text=True
                )
                (output / ("firmware-regressions-" + role + "-build.log")).write_text(
                    result.stdout + result.stderr
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                execution = subprocess.run(
                    [str(build / "zephyr/zephyr.exe")],
                    cwd=owner,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                (build / "execution.log").write_text(
                    execution.stdout + execution.stderr
                )
                self.assertEqual(
                    execution.returncode, 0, execution.stdout + execution.stderr
                )
                self.assertIn("PROJECT EXECUTION SUCCESSFUL", execution.stdout)
                self.assertIn("TESTSUITE sessions succeeded", execution.stdout)
                self.assertIn("TESTSUITE relay succeeded", execution.stdout)
                self.assertNotIn("SKIP -", execution.stdout)
