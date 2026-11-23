# curfewd

Local parental control daemon, CLI, and web dashboard for any home router.

```bash
npm install -g curfewd
```

## Quick start

```bash
curfewd setup
curfewd serve
```

`curfewd setup` detects your gateway and router adapter, discovers LAN devices, sets up your first daily quota, and optionally installs a background daemon (`launchd` on macOS, `systemd` on Linux). `curfewd serve` launches the local web studio on `http://localhost:4320` and the UDP DNS sinkhole on `:5354`.

## Daily quotas & instant pause

```bash
curfewd quota set "Kids Desktop" aa:bb:cc:dd:ee:ff 1h30m
curfewd quota add "Kids Desktop" 30m
curfewd pause "Kids Desktop" 60m
curfewd resume "Kids Desktop"
```

Quotas track cumulative online time per day (across one or more MACs), enforce the block automatically when the budget hits zero, and reset + unblock at midnight.

## Any-router adapters

- `universal` — Works on **any** router (eero, Nest WiFi, Xfinity, Spectrum, Orbi, Verizon) with zero router password using OS ARP/NDP discovery and the built-in RFC-1035 UDP DNS sinkhole.
- `att-bgw` — AT&T Fiber BGW320-500 / BGW210 hardware L2/L3 Packet Filter drop rules.
- `openwrt` — OpenWrt / GL.iNet `ubus` JSON-RPC + UCI firewall rules.
- `unifi` — Ubiquiti UniFi OS (`block-sta` / `unblock-sta`).
- `asuswrt` — ASUSWRT / Merlin `MULTIFILTER_MAC`.
- `netgear` — Netgear Nighthawk / Orbi SOAP `SetBlockDeviceByMAC`.
- `custom` — Shell/SSH command hooks (`{{mac}}`, `{{ip}}`) for pfSense, OPNsense, MikroTik, FRITZ!Box, or TP-Link Omada.

## Programmatic API

```js
import curfewd from 'curfewd';

const guard = curfewd();
guard.quota.set({ name: 'Kids Desktop', macs: ['aa:bb:cc:dd:ee:ff'], limit: '1h30m' });
await guard.tick();
```

State is stored locally in `~/.curfewd/state.json` (override with `CURFEWD_HOME`). Zero external dependencies.

## Background service

```bash
curfewd service install
curfewd service uninstall
```

Installs or removes a persistent user daemon (`launchd` on macOS, `systemd --user` on Linux) that enforces daily quotas and bedtime schedules automatically.

## License

MIT © [Hemanth.HM](https://h3manth.com)
