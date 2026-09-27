/** 本地 Session Mailbox 默认可用；显式关闭仅影响自动装配的 adapter。 */
export function isMessageEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.ZCODE_MESSAGE_ENABLED?.trim().toLowerCase();
  return !value || !["0", "false", "off", "disabled"].includes(value);
}
