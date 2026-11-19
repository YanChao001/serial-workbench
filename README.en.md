# Serial Workbench

A cross-platform serial workbench. The Tauri desktop app, CLI and MCP share a Rust Host that owns serial ports, sessions and recordings. The workbench supports text/hex I/O, file sending, recording, read-only replay, workspaces and shared settings. See the [roadmap and status](./docs/plan.md) for Node extensions, browser access and LAN sharing.

[中文](./README.md) · [Engineering docs](./docs/README.md) · [Contributing](./CONTRIBUTING.md)

## Run from source

Use the Node version in [.nvmrc](./.nvmrc), the pnpm version in [package.json](./package.json), and rustup. Install the [platform prerequisites](./docs/development.md#环境与启动), then run from the repository root:

```sh
pnpm install --frozen-lockfile
rustup toolchain install
pnpm run doctor
pnpm app:dev
```

`pnpm dev` previews the interface without connecting to local serial ports. If startup reports an older Host after a source change, run `pnpm host:stop` with the same profile, then `pnpm app:dev`. Stopping the Host disconnects its sessions but preserves settings and drafts.

`pnpm app:build` builds installers; Windows also supports `pnpm app:portable`. See [build and release](./docs/development.md#构建与发布) for output paths, signing and update prerequisites.

## License and security

Licensed under [Apache-2.0](./LICENSE), with attribution in [NOTICE](./NOTICE). Follow [SECURITY.md](./SECURITY.md) for private vulnerability reports and [AGENTS.md](./AGENTS.md) for coding-agent instructions.
