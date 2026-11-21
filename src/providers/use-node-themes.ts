import { useEffect, useState } from "react";
import type { QueryResult, SharedSettings } from "@serial-workbench/contracts";
import type { HostConnection } from "@/lib/host-client";

export type AvailableNodeTheme = Extract<
  QueryResult,
  { kind: "node_themes" }
>["value"]["themes"][number];

type ThemeReference = NonNullable<SharedSettings["nodeTheme"]>;
const noThemes: readonly AvailableNodeTheme[] = [];
const accentColor = /^#[\da-f]{6}$/i;

export function nodeThemeKey(theme: ThemeReference): string {
  return JSON.stringify([theme.packageId, theme.themeId, theme.archiveSha256]);
}

export function useNodeThemes(connection?: HostConnection) {
  const [catalog, setCatalog] = useState<{
    connection: HostConnection;
    themes: readonly AvailableNodeTheme[];
  }>();
  useEffect(() => {
    if (!connection) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let pending: AbortController | undefined;
    const refresh = () => {
      if (!active) return;
      pending?.abort();
      const request = new AbortController();
      pending = request;
      // An invalidated catalog can no longer attest to the previous theme.
      setCatalog(undefined);
      void connection.client
        .query(
          connection.buildQuery("node.themes.list", connection.hostTarget),
          request.signal,
        )
        .then(
          (result) => {
            if (
              active &&
              !request.signal.aborted &&
              result.kind === "node_themes"
            )
              setCatalog({
                connection,
                themes: result.value.themes.filter((theme) =>
                  accentColor.test(theme.accent),
                ),
              });
          },
          () => undefined,
        );
    };
    // Subscribe first so activation or revocation cannot be missed during the read.
    void connection.onCatalogChanged(refresh).then(
      (stop) => {
        if (!active) {
          stop();
          return;
        }
        unsubscribe = stop;
        refresh();
      },
      () => undefined,
    );
    return () => {
      active = false;
      pending?.abort();
      unsubscribe?.();
    };
  }, [connection]);
  return catalog?.connection === connection
    ? (catalog?.themes ?? noThemes)
    : noThemes;
}
