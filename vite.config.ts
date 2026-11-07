import path from "node:path";
import process from "node:process";
import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "project-license-files",
      apply: "build",
      generateBundle() {
        for (const [fileName, source] of [
          ["LICENSE", "LICENSE"],
          ["NOTICE", "NOTICE"],
          [
            "third-party/tauri-desktop-starter.LICENSE",
            "resources/third-party/tauri-desktop-starter.LICENSE",
          ],
        ] as const) {
          this.emitFile({
            type: "asset",
            fileName,
            source: readFileSync(path.resolve(import.meta.dirname, source)),
          });
        }
      },
    },
    ...(mode === "web-preview"
      ? [
          {
            name: "browser-preview-csp",
            transformIndexHtml() {
              return [
                {
                  tag: "meta",
                  attrs: {
                    "http-equiv": "Content-Security-Policy",
                    content:
                      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'",
                  },
                  injectTo: "head-prepend" as const,
                },
              ];
            },
          },
        ]
      : []),
  ],

  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },

  // 浏览器预览与桌面共用入口；相对地址支持项目子路径和独立域名。
  base: mode === "web-preview" ? "./" : "/",
  build: { outDir: mode === "web-preview" ? "dist-web" : "dist" },

  // 保留终端输出，便于查看 Tauri 开发与构建过程中的 Rust 错误。
  clearScreen: false,
  // Tauri 使用固定开发端口，端口被占用时直接报错。
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 生成目录不参与 HMR；Windows 上目录监听可能阻止归档时的原子重命名。
      ignored: [
        "**/src-tauri/**",
        "**/artifacts/**",
        "**/dist/**",
        "**/dist-web/**",
        "**/coverage/**",
        "**/.cache/**",
      ],
    },
  },
}));
