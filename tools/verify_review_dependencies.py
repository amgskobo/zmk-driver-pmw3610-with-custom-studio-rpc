"""Verify pinned review inputs during explicit environment preparation."""

from pathlib import Path
import re
import subprocess

import yaml

REVIEW_BRANCHES = {
    "zmk-feature-custom-settings": "codex/custom-settings-review",
}
SUPPORT_URLS = {
    "zmk": "https://github.com/cormoran/zmk",
    "zephyr": "https://github.com/zmkfirmware/zephyr",
    "zmk-west-commands": "https://github.com/cormoran/zmk-west-commands",
}


def selected_test_projects(document):
    manifest = document["manifest"]
    projects = manifest["projects"]
    if len(projects) != len(SUPPORT_URLS) or {p["name"] for p in projects} != set(
        SUPPORT_URLS
    ):
        raise ValueError("Test dependency selection is incomplete or duplicated")
    remotes = {row["name"]: row["url-base"] for row in manifest["remotes"]}
    for project in projects:
        name = project["name"]
        url = project.get("url") or remotes[project["remote"]] + "/" + name
        if url != SUPPORT_URLS[name] or not re.fullmatch(
            r"[0-9a-f]{40}", project.get("revision", "")
        ):
            raise ValueError(
                f"{name}: expected the supported repository and full commit"
            )
    return projects


def selected_projects(document):
    projects = document["manifest"]["projects"]
    if len(projects) != len(REVIEW_BRANCHES) or {p["name"] for p in projects} != set(
        REVIEW_BRANCHES
    ):
        raise ValueError("Review dependency selection is incomplete or duplicated")
    for project in projects:
        name = project["name"]
        if (
            project.get("url") != f"https://github.com/amgskobo/{name}"
            or not re.fullmatch(r"[0-9a-f]{40}", project.get("revision", ""))
            or project.get("userdata", {}).get("review-branch") != REVIEW_BRANCHES[name]
        ):
            raise ValueError(f"{name}: expected the pinned review fork and branch")
    return projects


def verify_remote(project):
    ref = "refs/heads/" + project["userdata"]["review-branch"]
    actual = subprocess.check_output(
        ["git", "ls-remote", "--exit-code", project["url"], ref],
        text=True,
        timeout=30,
    ).split()
    if actual != [project["revision"], ref]:
        raise ValueError(
            f"{project['name']}: review branch differs from the pinned commit"
        )


def main():
    manifest = (
        Path(__file__).resolve().parents[1] / "west/west-dependency/west-dependency.yml"
    )
    projects = selected_projects(yaml.safe_load(manifest.read_text()))
    support = selected_test_projects(
        yaml.safe_load((manifest.parent / "west-test-dependency.yml").read_text())
    )
    for project in support:
        print(f"Pinned {project['name']} {project['revision']}", flush=True)
    for project in projects:
        verify_remote(project)
        print(f"Verified {project['name']} {project['revision']}", flush=True)


if __name__ == "__main__":
    main()
