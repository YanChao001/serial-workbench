export const mdf4Package = "swb.pro.mdf4";
export const mdf4Action = `${mdf4Package}.exportMdf4`;
export const mdf4MediaType = "application/x-asam-mdf";
export const maxMdf4Samples = 256;

export type Mdf4Snapshot = {
  startTimeNs: string;
  channels: {
    name: string;
    type: "float64" | "uint64" | "int64";
    unit?: string;
  }[];
  samples: { elapsedNs: string; values: (string | null)[] }[];
};
