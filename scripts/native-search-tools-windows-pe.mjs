import { readFileSync } from "node:fs";
import { basename } from "node:path";

function fail(message) {
  throw new Error(message);
}

function readUInt16(buffer, offset, label) {
  if (offset < 0 || offset + 2 > buffer.length) fail(`invalid PE ${label}`);
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset, label) {
  if (offset < 0 || offset + 4 > buffer.length) fail(`invalid PE ${label}`);
  return buffer.readUInt32LE(offset);
}

function readPeCString(buffer, offset) {
  if (offset < 0 || offset >= buffer.length) fail("invalid PE import name offset");
  const end = buffer.indexOf(0, offset);
  if (end < 0) fail("unterminated PE import name");
  return buffer.toString("ascii", offset, end);
}

function peRvaToFileOffset(buffer, rva, sectionTableOffset, sectionCount) {
  const sectionHeaderSize = 40;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTableOffset + index * sectionHeaderSize;
    const virtualSize = readUInt32(buffer, offset + 8, "section virtual size");
    const virtualAddress = readUInt32(buffer, offset + 12, "section virtual address");
    const rawSize = readUInt32(buffer, offset + 16, "section raw size");
    const rawOffset = readUInt32(buffer, offset + 20, "section raw offset");
    if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
      return rawOffset + (rva - virtualAddress);
    }
  }
  fail(`PE RVA 0x${rva.toString(16)} is outside mapped sections`);
}

export function readWindowsPeMetadata(binaryPath) {
  const buffer = readFileSync(binaryPath);
  if (buffer.length < 64 || buffer.toString("ascii", 0, 2) !== "MZ") {
    fail(`${basename(binaryPath)} is not a PE executable`);
  }

  const peOffset = readUInt32(buffer, 0x3c, "header offset");
  if (buffer.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    fail(`${basename(binaryPath)} has an invalid PE signature`);
  }

  const machine = readUInt16(buffer, peOffset + 4, "machine");
  const sectionCount = readUInt16(buffer, peOffset + 6, "section count");
  const optionalHeaderSize = readUInt16(buffer, peOffset + 20, "optional header size");
  const optionalHeaderOffset = peOffset + 24;
  const optionalHeaderMagic = readUInt16(buffer, optionalHeaderOffset, "optional header magic");
  const dataDirectoryRelativeOffset = optionalHeaderMagic === 0x20b ? 112 : 96;
  if (optionalHeaderMagic !== 0x20b && optionalHeaderMagic !== 0x10b) {
    fail(`${basename(binaryPath)} has an unsupported PE optional header`);
  }

  const dataDirectoryOffset = optionalHeaderOffset + dataDirectoryRelativeOffset;
  const importRva = readUInt32(buffer, dataDirectoryOffset + 8, "import directory RVA");
  const importSize = readUInt32(buffer, dataDirectoryOffset + 12, "import directory size");
  const imports = [];
  if (importRva !== 0 && importSize !== 0) {
    const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
    const importOffset = peRvaToFileOffset(buffer, importRva, sectionTableOffset, sectionCount);
    const descriptorSize = 20;
    const descriptorLimit = Math.min(buffer.length, importOffset + importSize);
    for (
      let offset = importOffset;
      offset + descriptorSize <= descriptorLimit;
      offset += descriptorSize
    ) {
      const nameRva = readUInt32(buffer, offset + 12, "import name RVA");
      const firstThunk = readUInt32(buffer, offset + 16, "import first thunk");
      if (nameRva === 0 && firstThunk === 0) break;
      const nameOffset = peRvaToFileOffset(buffer, nameRva, sectionTableOffset, sectionCount);
      imports.push(readPeCString(buffer, nameOffset));
    }
  }

  return { imports, machine };
}

function isForbiddenRuntimeDependency(dependency) {
  return /^(?:api-ms-win-crt-|vcruntime|msvcp|ucrtbase|(?:lib)?pcre2|zlib|libz|(?:lib)?bz2|libbzip2|(?:lib)?zstd|(?:lib)?brotli).*\.dll$/iu.test(
    dependency,
  );
}

export function verifyWindowsPeBinary(binaryPath, arch) {
  const metadata = readWindowsPeMetadata(binaryPath);
  const expectedMachine = arch === "arm64" ? 0xaa64 : 0x8664;
  if (metadata.machine !== expectedMachine) {
    fail(
      `${basename(binaryPath)} has PE machine 0x${metadata.machine.toString(16)}; expected 0x${expectedMachine.toString(16)} for ${arch}`,
    );
  }

  const forbiddenDependencies = metadata.imports.filter(isForbiddenRuntimeDependency);
  if (forbiddenDependencies.length > 0) {
    fail(
      `${basename(binaryPath)} has non-static runtime dependencies: ${forbiddenDependencies.join(", ")}`,
    );
  }
}
