// Modified by ZCode Feiyu.
/** 保持普通 class 方法的 descriptor，避免 hydration clone 丢失内部方法。 */
export function installV4OwnerMethods(
  prototype: object,
  methods: Record<string, (...args: never[]) => unknown>,
): void {
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(prototype, name, {
      value: method,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}
