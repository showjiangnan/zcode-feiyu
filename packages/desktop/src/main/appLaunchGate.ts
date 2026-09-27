export function createAppLaunchGate() {
  let consumed = false;

  return {
    consume(): boolean {
      if (consumed) {
        return false;
      }

      consumed = true;
      return true;
    },
  };
}
