export { RcsHttpClient, type RcsHttpOptions } from "./rcsHttpClient.js";
export {
  RcsRpcConnection,
  type RcsSocket,
  type RcsSocketFactory,
  type RcsPublicRequest,
  type RcsPublicSubscription,
} from "./rcsTransport.js";
export {
  RCS_SERVICE_MANIFEST,
  RCS_BRIDGE_VERSION,
  RCS_RPC_CODEC_VERSION,
  RCS_AGENT_WIRE_VERSION,
  encodeRcsFrame,
  decodeRcsFrame,
} from "@zcode/shared";
export type {
  RcsAttachment,
  RcsCapabilities,
  RcsGrant,
  RcsHost,
  RcsWorkspace,
  RcsDevice,
  RcsClient,
} from "@zcode/shared";
