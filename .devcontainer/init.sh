#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Setting up the development environment..."
echo "* Current directory: $(pwd)"

if ! west topdir &> /dev/null; then
    echo "* Initializing West..."
    python3 tools/verify_review_dependencies.py
    west init -l west --mf west-test-isolated.yml
    west update --narrow
    west zephyr-export
else
    echo "* West is already initialized with topdir: $(west topdir)"
fi

git config --global --add safe.directory "$(pwd)"
pre-commit install || cat /root/.cache/pre-commit/pre-commit.log
