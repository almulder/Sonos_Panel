# Unraid Setup Guide — Sonos Panel

This container needs to sit on your real LAN with its own IP address for Sonos speaker discovery (SSDP multicast) to work. Regular Docker bridge networking silently blocks discovery, and host networking makes the WebUI port unreliable — a fixed IP on an ipvlan `br0` network solves both problems at once.

## 1. Set up br0 (one-time, only if you don't already have it)

This container needs a `br0` network using **ipvlan** mode. If you already run other containers with their own fixed LAN IPs (Pi-hole, AdGuard, etc.), check what mode that network is using — if it's macvlan, switch it to ipvlan.

1. In the Unraid web UI, go to **Settings → Docker**
2. Under **Network Types**, find/add the `br0` network
3. **Change Docker custom network type to ipvlan (highly recommended for Sonos)**
4. Apply

## 2. Install the template

1. Copy `unraid-template.xml` into `/boot/config/plugins/dockerMan/templates-user/` on your Unraid flash share
2. In the Unraid web UI, go to **Docker → Add Container**
3. Select the **Sonos_Panel** template from the dropdown

## 3. Configure the container

- **Network Type**: select `br0`
- **Fixed IP Address**: enter a free IP address on your LAN — pick something outside your router's DHCP range so it doesn't get double-assigned
- **AppData Config Path**: defaults to `/mnt/user/appdata/Sonos_Panel` — change if you want config stored elsewhere
- Leave the advanced port/data-dir settings at their defaults unless you know you need to change them

## 4. Apply and access

Click **Apply**. Once the container is running, access the panel at:

```
http://<the-fixed-ip-you-chose>/
```

No port number needed. The WebUI button in Unraid's Docker tab will also open this correctly.

## Troubleshooting

- **Speakers don't show up**: double check the container is actually on the custom network (not host or bridge) and that the fixed IP doesn't conflict with another device
- **Can't reach the IP at all**: confirm the IP is actually free — try pinging it before assigning
- **Template shows blank fields when selected**: re-copy the XML file, avoiding Windows-based copy tools that may alter line endings/encoding — copying via the Unraid terminal directly is most reliable
