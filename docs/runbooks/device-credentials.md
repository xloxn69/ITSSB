# Runbook: provision, rotate and revoke a device credential

Owner and staff steps for [docs/14 §4](../14_DEPLOYMENT_AND_OPERATIONS.md) and
[docs/11 §3, §10](../11_SECURITY_PRIVACY_AND_ACCESS.md). Each Pi has its own
credential. The server stores only its SHA-256 hash; the secret is shown once,
to the staff member who asked, and is never stored in the browser.

| Situation | Action on **Staff → Buses & devices** |
|---|---|
| New Pi | **Add a device**, then install the credential |
| Credential may have leaked, or a planned rotation | **Replace credential**, then install it |
| Pi lost, stolen, or retired | **Revoke device** (permanent) |
| Replacement Pi for a revoked one | **Add a device** for the new Pi |

Every action, allowed or denied, is written to the audit log with the staff
account that did it. The secret never appears in the audit log.

## Install a credential on the Pi (owner, needs sudo)

Do this outside an active run.

```sh
sudoedit /etc/itssb/device.env     # set ITSSB_DEVICE_TOKEN=<the secret>
sudo systemctl restart itssb-device
curl -s http://127.0.0.1:8765/health | python3 -m json.tool   # backend.status goes from credential_rejected to ok
```

Then press **I've installed it, hide it**. Don't paste the secret into chat,
email, tickets, screenshots, or shell history; `sudoedit` keeps it out of
history.

## What rotation does to a running bus

The old secret stops working the moment the new one is issued. The device
keeps its identity, its bus name, and any active run. Until the new secret is
installed the Pi keeps recording, its uploads are refused (health shows
`backend.status: credential_rejected`), and every event
waits in its outbox with its original `eventId`. After the restart they upload
without duplicates. Families see the position age grow (stale), never a
position presented as live.

So rotate in a maintenance window when you can. For a suspected leak, rotate
immediately: a short stale period is the safer failure.

## Revocation

Revoking rejects the device's reports immediately and cannot be undone, and a
revoked device cannot be given a new credential: an attacker holding an old
image gains nothing from a later rotation. Provision the replacement Pi as a
new device. Before reusing or discarding the old Pi's SD card, check its
outbox (`python3 -m itssb_device outbox`) and wipe the card.

The admin-only command `bunx convex run devices:rotateCredential` (from the
deployment's admin access) does the same rotation without a staff account; it
records the system as the actor.
