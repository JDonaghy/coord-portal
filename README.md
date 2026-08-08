# coord-portal

Customer intake and design sign-off portal for a [`claude-coordinator`](https://github.com/JDonaghy/claude-coordinator) fleet.

A customer describes an outcome they want in plain language. Later — asynchronously, by email — they
are told a design is ready: an outcome definition, a proposed decomposition, and mocks showing the
change. They approve it or ask for changes, which opens another round. Once signed off, the work
enters the coordinator's normal pipeline and the customer follows it as a handful of human-readable
states. They never see a git branch, an issue number, or a live agent session.

**Status: skeleton.** Nothing is built yet. The design is
[`docs/CUSTOMER_PORTAL.md`](https://github.com/JDonaghy/claude-coordinator/blob/main/docs/CUSTOMER_PORTAL.md)
in the coordinator repo (milestone #23, epic #836).

## How it relates to claude-coordinator

The portal is a thin client over a fleet it cannot reach. It runs on Cloudflare — Pages for the site,
Workers for the API, D1 for records, R2 for mock bundles, Access for auth — entirely on the public
internet. The coordinator runs behind a Tailscale tailnet and is not reachable from here.

They are joined by an **outbound-only sync bridge**: the coordinator's daemon polls the portal on its
existing tick, pulls new submissions and sign-offs, and pushes status back. Nothing on the internet
side ever initiates a connection inward. That is the security boundary, and it is why the portal can
be public source with no risk: it holds no credential that grants execution and has no path in.

Without a coordinator fleet on the other side, this is a form that talks to nothing. That asymmetry
is why the portal is MIT while the coordinator is FSL-1.1-MIT — the defensible part is the pipeline
this feeds, not the intake surface.

## Development

See [`CLAUDE.md`](CLAUDE.md) for the rules that apply to any change here — in particular that **no
customer material may be committed to this repo**.

## License

MIT. See [`LICENSE`](LICENSE).
