# github-live

A scratch directory for capturing **real** GitHub webhook deliveries. Nothing is
committed here but the config: GitHub payloads carry account and repository
data, and contracts record object keys verbatim (see
[SECURITY.md](../../SECURITY.md)).

GitHub sends the event name in the `X-GitHub-Event` header rather than the body,
so fixtures go in one folder per event and the config uses `"eventPath": "@dirname"`:

```
fixtures/
  push/            <- event name comes from the folder
    delivery-1.json
  pull_request/
    delivery-1.json
```

Redeliver past payloads from **Settings → Webhooks → Recent Deliveries** on the
repository or app, or point a [`gh webhook forward`](https://cli.github.com/manual/gh_webhook_forward)
listener at a local endpoint and save what arrives. Then:

```bash
npx hookdrift infer
npx hookdrift check
```

Until you capture something, `check` correctly reports that nothing matched.
