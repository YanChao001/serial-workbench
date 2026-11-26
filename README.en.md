# Serial Workbench

A cross-platform serial workbench. The Tauri desktop app, CLI and MCP share a Rust Host that owns serial ports, sessions and recordings. It supports text/hex I/O, file sending, recording, read-only replay, workspaces and shared settings. Trusted Node plugins extend the workbench, and pairing enables browser access or serial port sharing over LAN. [Roadmap and status](./docs/plan.md)

[中文](./README.md) · [Engineering docs](./docs/README.md) · [Contributing](./CONTRIBUTING.md)

## Run from source

Use the Node version in [.nvmrc](./.nvmrc), the pnpm version in [package.json](./package.json), and rustup. Install the [platform prerequisites](./docs/development.md#环境与启动), then run from the repository root:

```sh
pnpm install --frozen-lockfile
rustup toolchain install
pnpm run doctor
pnpm app:dev
```

`pnpm app:dev` starts the desktop development app with access to local devices. For a UI preview without attaching to the local Host, run `pnpm dev`. To open a [paired browser](./docs/development.md#浏览器访问), use the desktop settings. The Host serves the production assets. For missing `dist` assets, missing prerequisites, or a Host version mismatch, see [startup and troubleshooting](./docs/development.md#环境与启动).

`pnpm app:build` builds installers. On Windows, `pnpm app:portable` builds a portable package. See [build and release](./docs/development.md#构建与发布) for output paths, runtime dependencies, signing and update prerequisites.

## License and security

Licensed under [Apache-2.0](./LICENSE), with attribution in [NOTICE](./NOTICE). Follow [SECURITY.md](./SECURITY.md) for private vulnerability reports and [AGENTS.md](./AGENTS.md) for coding-agent instructions.
