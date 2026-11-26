# Serial Workbench

A cross-platform serial workbench. The Tauri desktop app, CLI and MCP share a Rust Host for text/hex I/O, file sending, recording, read-only replay and shared workspaces. Trusted Node plugins extend the workbench. The desktop app pairs with browsers, and the Host shares serial ports over LAN. [Roadmap and status](./docs/plan.md)

[中文](./README.md) · [Engineering docs](./docs/README.md) · [Contributing](./CONTRIBUTING.md)

## Run from source

Use the Node version in [.nvmrc](./.nvmrc), the pnpm version in [package.json](./package.json), and rustup. Install the [platform prerequisites](./docs/development.md#环境与启动), then run from the repository root:

```sh
pnpm install --frozen-lockfile
rustup toolchain install
pnpm run doctor
pnpm app:dev
```

Use `pnpm dev` for a UI preview and `pnpm app:dev` for local devices. Set up [browser pairing](./docs/development.md#浏览器访问) in the desktop settings. See [startup and troubleshooting](./docs/development.md#环境与启动) for missing `dist` assets, prerequisites or a Host mismatch.

Use `pnpm app:build` for installers and `pnpm app:portable` for the Windows portable package. See [build and release](./docs/development.md#构建与发布) for artifacts and signing.

## License and security

Licensed under [Apache-2.0](./LICENSE), with attribution in [NOTICE](./NOTICE). Follow [SECURITY.md](./SECURITY.md) for private vulnerability reports and [AGENTS.md](./AGENTS.md) for coding-agent instructions.
