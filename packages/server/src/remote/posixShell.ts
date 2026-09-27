export function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildPosixShellExecCommand(command: string): string {
  return `/bin/sh -c ${quotePosixShellArg(command)}`;
}

export function quotePosixPathArg(path: string): string {
  if (path === "~") {
    return '"$HOME"';
  }

  if (path.startsWith("~/")) {
    return `"$HOME"${quotePosixShellArg(path.slice(1))}`;
  }

  return quotePosixShellArg(path);
}

export function resolvePosixHomePath(remotePath: string, homeDir: string): string {
  if (remotePath === "~") {
    return homeDir;
  }

  if (remotePath.startsWith("~/")) {
    return `${homeDir.replace(/\/$/, "")}/${remotePath.slice(2)}`;
  }

  return remotePath;
}

export function buildWriteLiteralFileCommand(targetPath: string, content: string): string {
  return `printf %s ${quotePosixShellArg(content)} > ${quotePosixPathArg(targetPath)}`;
}
