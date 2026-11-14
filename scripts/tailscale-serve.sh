#!/bin/bash
tailscale funnel reset 2>/dev/null
tailscale serve reset 2>/dev/null

# Dashboard at root → tailnet only
tailscale serve --bg http://localhost:3001

# Keep alive so pm2 doesn't restart
while true; do sleep 86400; done
