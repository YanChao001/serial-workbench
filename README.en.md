# Serial Workbench

A cross-platform serial workbench built with Tauri, Rust, React and TypeScript. An independent Rust Host owns devices, sessions, captures and shared state; the desktop UI, CLI and MCP adapter use the same backend.

The current workbench includes Text/HEX I/O, file sending, capture, read-only replay and workspaces. M1b remains incomplete; see [development status](./docs/progress.md) for known issues and validation scope. Node extensions, browser connections and LAN sharing belong to later milestones.

[中文](./README.md) · [Engineering docs](./docs/README.md) · [Requirements](./docs/requirements.md) · [Contributing](./CONTRIBUTING.md)

## Run from source

Use the versions in [package.json](./package.json), [.nvmrc](./.nvmrc) and [rust-toolchain.toml](./rust-toolchain.toml). Install the [platform prerequisites](./docs/development.md#环境与启动), then run from the repository root:

```sh
pnpm install --frozen-lockfile
rustup toolchain install
pnpm run doctor
pnpm app:dev
```

`pnpm dev` starts the browser preview; system capabilities require the desktop environment. Without npm dependencies, run `node scripts/doctor.mjs` for diagnostics.

## Development

Read [architecture](./docs/architecture.md), [conventions](./docs/conventions.md), [development](./docs/development.md) and [testing](./docs/testing.md). Use [the plan](./docs/plan.md) and [status](./docs/progress.md) to identify current work.

`pnpm app:build` creates installers; on Windows, `pnpm app:portable` creates portable files. Outputs are archived under `artifacts/<version>/<target-triple>/`. Signing, updates and public release remain unconfigured; see [build and release](./docs/development.md#构建与发布).

## License and security

Licensed under [Apache-2.0](./LICENSE), with attribution in [NOTICE](./NOTICE). Follow [SECURITY.md](./SECURITY.md) for private vulnerability reports and [AGENTS.md](./AGENTS.md) for coding-agent instructions.
