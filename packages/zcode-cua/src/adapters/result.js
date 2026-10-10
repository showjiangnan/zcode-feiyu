// Modified by ZCode Feiyu contributors (2026).
import { createHash, createHmac } from "node:crypto";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "../../host-display-contract.js";
import { OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY } from "../../frame-contract.js";

export function modelResult(body, app, token) {
  const state = body.state || body;
  const image = state.image;
  const content = [];
  const projection = { ...state };
  if (image?.data) {
    const pixels = Buffer.from(image.data, "base64");
    const sha256 = createHash("sha256").update(pixels).digest("hex");
    const claims = {
      algorithm: "sha256",
      sha256,
      imageId: image.imageId,
      targetId: state.targetId,
      observationId: state.observationId,
      width: image.width,
      height: image.height,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const authority = `${payload}.${createHmac("sha256", token).update(payload).digest("base64url")}`;
    content.push(
      { type: "image", mimeType: image.mimeType, data: image.data },
      { type: "text", text: `zcode-cua-image-ref:${JSON.stringify({ authority })}` },
    );
    const { data: _data, ...metadata } = image;
    projection.image = { ...metadata, authority };
  }
  const structuredContent = body.state ? { ...body, state: projection } : projection;
  content.push({ type: "text", text: JSON.stringify(structuredContent) });
  return {
    content,
    structuredContent,
    _meta: {
      [CUA_APP_ASSOCIATIONS_META_KEY]: app
        ? { primary: { appKey: app.appKey || app.appId, displayName: app.displayName } }
        : { none: true },
      ...(image?.data
        ? {
            [OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]: {
              version: 1,
              imageId: image.imageId,
              targetId: state.targetId,
            },
          }
        : {}),
    },
  };
}
