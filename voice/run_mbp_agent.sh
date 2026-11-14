#!/bin/bash
# Runs mbp_agent.py using the dash venv
cd "$(dirname "$0")/.."
exec .venv/bin/python voice/mbp_agent.py "$@"
