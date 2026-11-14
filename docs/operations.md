# Dash — General Setup Notes

## Auto-login (headless reboot)

To allow the Mac Mini to boot fully headless without requiring a physical login:

**System Settings > General > Login Items & Extensions > Automatically log in as...**

Or via terminal:
```bash
sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser $(whoami)
```

**Note:** FileVault must be disabled for auto-login to work. Check status with:
```bash
fdesetup status
```

---

## Launch Agent: pm2:boot on login

macOS TCC grants mic access based on app bundle context. pm2 restarted via SSH does **not** have this context, so wake word detection fails silently after a reboot.

**Fix:** A Launch Agent runs `npm run pm2:boot` automatically in the login session on every boot, giving it the correct TCC context for mic permissions.

**Plist location:**
```
~/Library/LaunchAgents/com.stevemini.dash-boot.plist
```

**What it runs:**
```bash
cd ~/dev/dash && npm run pm2:boot
# which expands to: pm2 kill && pm2 start ecosystem.config.cjs && pm2 save
```

**Logs:**
```
~/dev/dash/logs/dash-boot.log
~/dev/dash/logs/dash-boot-err.log
```

**Useful commands:**
```bash
# Manually trigger (without rebooting)
launchctl start com.stevemini.dash-boot

# Register after creating/editing the plist
launchctl load ~/Library/LaunchAgents/com.stevemini.dash-boot.plist

# Unregister
launchctl unload ~/Library/LaunchAgents/com.stevemini.dash-boot.plist
```

**Note:** `pm2 kill` briefly takes Dash offline for a few seconds on boot while it restarts — this is expected.

**Note:** The plist uses a `sleep 15` delay before running pm2:boot. This is necessary because macOS needs time to fully initialize the audio subsystem after login — without it, PyAudio throws a `PaMacCore AUHAL err=-50` error and wake word detection fails silently.
