First release of Agent Monitor: a local dashboard for Codex, Claude Code, Pi, and Hermes agent traces. Explore agent trees, read traces, and track token usage and estimated API cost. Traces stay on your machine.

## Downloads

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `agent-monitor-*-mac-arm64.dmg` |
| macOS (Intel) | `agent-monitor-*-mac-x64.dmg` |
| Windows (x64) | `agent-monitor-*-win-x64.exe` |
| Linux (x64) | `agent-monitor-*-linux-x86_64.AppImage` |

The `.zip` files are the same macOS app without an installer image.

## First launch

These builds are not signed with an Apple or Windows developer certificate yet.

- **macOS:** open the `.dmg` and drag Agent Monitor to Applications. On first launch, macOS blocks the app; open **System Settings → Privacy & Security** and choose **Open Anyway**. Alternatively run `xattr -dr com.apple.quarantine "/Applications/Agent Monitor.app"`.
- **Windows:** SmartScreen may warn about an unrecognized app. Choose **More info → Run anyway**.
- **Linux:** make the AppImage executable (`chmod +x agent-monitor-*.AppImage`) and run it.

See the [README](https://github.com/donvito/agent-monitor#readme) for where each provider's traces are read from.
