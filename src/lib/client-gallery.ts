import type { ObjectRef } from "@serial-workbench/contracts";
import type { GalleryEntry } from "./generated/bindings";
import {
  parseClientWindowState,
  readClientWindowState,
  saveClientWindowState,
  type ClientSettingsPort,
} from "./client-settings";
import { settingsErrorCode } from "./settings-sync";

export type { GalleryEntry } from "./generated/bindings";
export function sameGalleryReference(left: ObjectRef, right: ObjectRef) {
  return (
    left.hostId === right.hostId &&
    left.kind === right.kind &&
    left.id === right.id
  );
}

/** A gallery operation merges only its metadata into the existing window state. */
export function createClientGallery(
  port: ClientSettingsPort = {
    read: readClientWindowState,
    save: saveClientWindowState,
  },
) {
  async function readState(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const snapshot = await port.read();
    signal?.throwIfAborted();
    if (snapshot.formatVersion !== "0.1") throw { code: "STORAGE_CORRUPT" };
    return { ...snapshot, state: parseClientWindowState(snapshot.state) };
  }
  async function change(
    edit: (gallery: GalleryEntry[]) => GalleryEntry[],
    signal?: AbortSignal,
  ): Promise<GalleryEntry[]> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await readState(signal);
      const gallery = edit(snapshot.state.gallery);
      if (gallery.length > 24) throw { code: "INPUT_TOO_LONG" };
      const state = parseClientWindowState({ ...snapshot.state, gallery });
      signal?.throwIfAborted();
      try {
        const saved = await port.save(state, snapshot.revision);
        signal?.throwIfAborted();
        return parseClientWindowState(saved.state).gallery;
      } catch (error) {
        if (
          signal?.aborted ||
          settingsErrorCode(error) !== "CONFLICT" ||
          attempt === 2
        )
          throw error;
      }
    }
    throw { code: "CONFLICT" };
  }
  return {
    async read(signal?: AbortSignal) {
      return (await readState(signal)).state.gallery;
    },
    upsert(entry: GalleryEntry, signal?: AbortSignal) {
      return change(
        (gallery) =>
          gallery.some((item) =>
            sameGalleryReference(item.reference, entry.reference),
          )
            ? gallery.map((item) =>
                sameGalleryReference(item.reference, entry.reference)
                  ? entry
                  : item,
              )
            : [...gallery, entry],
        signal,
      );
    },
    rename(reference: ObjectRef, name: string, signal?: AbortSignal) {
      return change((gallery) => {
        if (
          !gallery.some((item) =>
            sameGalleryReference(item.reference, reference),
          )
        )
          throw { code: "NOT_FOUND" };
        return gallery.map((item) =>
          sameGalleryReference(item.reference, reference)
            ? { ...item, name }
            : item,
        );
      }, signal);
    },
    remove(reference: ObjectRef, signal?: AbortSignal) {
      return change(
        (gallery) =>
          gallery.filter(
            (item) => !sameGalleryReference(item.reference, reference),
          ),
        signal,
      );
    },
  };
}
