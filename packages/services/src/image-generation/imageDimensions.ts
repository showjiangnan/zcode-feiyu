/** Read dimensions without decoding pixels or trusting provider metadata. */
export function readImageDimensions(
  bytes: Uint8Array,
  mime: "image/png" | "image/jpeg" | "image/webp",
) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0,
    height = 0;
  if (mime === "image/png" && data.length >= 24 && data.toString("ascii", 12, 16) === "IHDR") {
    width = data.readUInt32BE(16);
    height = data.readUInt32BE(20);
  } else if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset] !== 0xff) break;
      while (offset < data.length && data[offset] === 0xff) offset++;
      const marker = data[offset++]!;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        length >= 7
      ) {
        height = data.readUInt16BE(offset + 3);
        width = data.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (mime === "image/webp" && data.length >= 25) {
    const chunk = data.toString("ascii", 12, 16);
    if (chunk === "VP8X" && data.length >= 30) {
      width = data.readUIntLE(24, 3) + 1;
      height = data.readUIntLE(27, 3) + 1;
    } else if (chunk === "VP8L" && data[20] === 0x2f) {
      width = 1 + ((data[21]! | (data[22]! << 8)) & 0x3fff);
      height = 1 + (((data[22]! >> 6) | (data[23]! << 2) | (data[24]! << 10)) & 0x3fff);
    } else if (
      chunk === "VP8 " &&
      data.length >= 30 &&
      data[23] === 0x9d &&
      data[24] === 0x01 &&
      data[25] === 0x2a
    ) {
      width = data.readUInt16LE(26) & 0x3fff;
      height = data.readUInt16LE(28) & 0x3fff;
    }
  }
  if (!width || !height || width > 8192 || height > 8192)
    throw new Error("Image provider returned invalid or oversized image dimensions.");
  return { width, height };
}
