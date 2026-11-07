# Serial Workbench

Serial Workbench (`serial-workbench`) is a cross-platform serial port workbench for embedded development and device debugging, built with Tauri 2, Rust, React 19 and TypeScript. The current version provides an empty workspace, settings, diagnostics, recovery and desktop window controls, plus the independent Host foundation for contracts, durable operations and local IPC. Device communication, CLI/MCP, recording and replay, desktop Host integration and Node extensions remain in development.

Developers exploring serial tools such as Serial Studio (`serial-studio`) can review the [product scope](./docs/product-scope.md) for the current capabilities and development stage.

[中文](./README.md) · [Documentation](./docs/README.md) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

## Run from source

Use the versions in [`.nvmrc`](./.nvmrc), [`package.json`](./package.json) and [`rust-toolchain.toml`](./rust-toolchain.toml). Install platform prerequisites from the [development guide](./docs/development.md#环境要求).

```sh
pnpm install --frozen-lockfile
rustup toolchain install
pnpm doctor
pnpm app:dev
```

For a browser preview, run `pnpm dev` and open `http://localhost:1420`. Browser and desktop builds share the React source and HashRouter. System services require the desktop app. `node scripts/doctor.mjs` also works before dependencies are installed.

## Verify and build

```sh
pnpm verify
pnpm test:ui
pnpm app:build
pnpm app:portable
```

Choose checks for the changed behavior using the [testing guide](./docs/testing.md#日常验证范围).

Installers and Windows portable distributions are archived under `artifacts/<version>/<target-triple>/` with SHA-256 manifests. Portable builds use the current user's data directories and require WebView2. See [build and release](./docs/build-release.md) for signing and distribution requirements.

Application identity is maintained in [app.config.json](./app.config.json). Daily contribution follows short-lived branches from `main`, pull requests and squash merge. The Chinese [documentation index](./docs/README.md) provides the detailed engineering reference.

## License

This project is licensed under the [Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for copyright information. Third-party components retain their own licenses.

[Code signing policy](./docs/code-signing-policy.md)
