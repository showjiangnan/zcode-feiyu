import { sourceFingerprint } from "./rcs-asset-delivery.mjs";

export function rcsBuildProvenancePlugin({ root, version, environment }) {
  let fingerprint;
  return {
    name: "rcs-build-provenance",
    async buildStart() {
      fingerprint = await sourceFingerprint(root);
    },
    async generateBundle() {
      if ((await sourceFingerprint(root)) !== fingerprint)
        throw new Error("RCS_SOURCE_CHANGED_DURING_WEB_BUILD");
      this.emitFile({
        type: "asset",
        fileName: "rcs-source.json",
        source:
          JSON.stringify({ version, environment, sourceFingerprint: fingerprint }, null, 2) + "\n",
      });
    },
  };
}
