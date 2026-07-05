# node

Node-runtime-specific suites: the node adapter, the node transport, anything whose claim names
node behavior (streams, sockets, process env at import). Tiers inside: `unit/`,
`integration/in-process/`, `integration/transport/`. Node helpers live in `helpers/`.

Rules: [standards/testing/structure.md](../../../standards/testing/structure.md)
