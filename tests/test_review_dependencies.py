"""Reject dependency drift before preparing the owner test environment."""

from copy import deepcopy
from pathlib import Path
import unittest
from unittest.mock import patch

import yaml

from tools.verify_review_dependencies import (
    selected_projects,
    selected_test_projects,
    verify_remote,
)


class ReviewDependencyTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1] / "west/west-dependency"
        self.document = yaml.safe_load((root / "west-dependency.yml").read_text())
        self.support = yaml.safe_load((root / "west-test-dependency.yml").read_text())

    def test_current_selection(self):
        self.assertEqual(len(selected_projects(self.document)), 1)
        self.assertEqual(len(selected_test_projects(self.support)), 3)

    def test_upstream_is_rejected(self):
        document = deepcopy(self.document)
        document["manifest"]["projects"][0]["url"] = (
            "https://github.com/cormoran/zmk-feature-custom-settings"
        )
        with self.assertRaises(ValueError):
            selected_projects(document)

    def test_moving_revision_is_rejected(self):
        document = deepcopy(self.document)
        document["manifest"]["projects"][0]["revision"] = "main"
        with self.assertRaises(ValueError):
            selected_projects(document)

    def test_duplicate_dependency_is_rejected(self):
        document = deepcopy(self.document)
        document["manifest"]["projects"] *= 2
        with self.assertRaises(ValueError):
            selected_projects(document)

    def test_moving_support_revision_is_rejected(self):
        document = deepcopy(self.support)
        document["manifest"]["projects"][0]["revision"] = "main+custom-studio-protocol"
        with self.assertRaises(ValueError):
            selected_test_projects(document)

    def test_remote_branch_must_match_pin(self):
        project = selected_projects(self.document)[0]
        ref = "refs/heads/" + project["userdata"]["review-branch"]
        with patch("subprocess.check_output", return_value="0" * 40 + "\t" + ref):
            with self.assertRaises(ValueError):
                verify_remote(project)
        with patch(
            "subprocess.check_output", return_value=project["revision"] + "\t" + ref
        ):
            verify_remote(project)
