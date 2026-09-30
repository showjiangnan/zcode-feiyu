// Modified by ZCode Feiyu contributors (2026).
/** 原生元数据调用放在独立 Worker；应用事件循环只使用异步消息，不阻塞会话流。 */
export const SECURE_MEMORY_WORKER = String.raw`
const {parentPort, workerData} = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const koffi = require(workerData.koffiPath);
const libc = koffi.load(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6');
const nativeOpenat = libc.func('int openat(int, const char *, int, ...)');
const openat = (parent, name, flags, mode = 0) => nativeOpenat(parent, name, flags, 'uint32_t', mode);
const closeFd = libc.func('int close(int)');
const mkdirat = libc.func('int mkdirat(int, const char *, uint32_t)');
const renameat = libc.func('int renameat(int, const char *, int, const char *)');
const linkat = libc.func('int linkat(int, const char *, int, const char *, int)');
const unlinkat = libc.func('int unlinkat(int, const char *, int)');
const fdopendir = libc.func('void *fdopendir(int)');
const readdir = libc.func('void *readdir(void *)');
const closedir = libc.func('int closedir(void *)');
const c = fs.constants, DEFAULT_LIMIT = 2 * 1024 * 1024, HARD_LIMIT = 5 * 1024 * 1024;
const READ_FLAGS = c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK | (c.O_CLOEXEC || 0);
const nodes = new Map();
let nextId = 1;
function failure(code, message) { return Object.assign(new Error(message), {code}); }
function stale(message = 'Memory path identity or revision changed') { return failure('ESTALE', message); }
const ADMISSION_OPEN = 0, ADMISSION_CANCELLED = 1, ADMISSION_COMMITTING = 2;
function admission(buffer) {
  if (buffer === undefined) return;
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== Int32Array.BYTES_PER_ELEMENT) throw failure('EINVAL', 'Invalid memory cancellation gate');
  return new Int32Array(buffer);
}
function assertAllowed(gate) {
  if (gate && Atomics.load(gate, 0) === ADMISSION_CANCELLED) throw Object.assign(failure('ABORT_ERR', 'Memory mutation cancelled before commit'), {name:'AbortError'});
}
function admit(gate) {
  if (!gate) return;
  const previous = Atomics.compareExchange(gate, 0, ADMISSION_OPEN, ADMISSION_COMMITTING);
  if (previous !== ADMISSION_OPEN) { assertAllowed(gate); throw failure('EINVAL', 'Memory admission gate already used'); }
}
function check(result) {
  if (result >= 0) return result;
  const errno = koffi.errno();
  const code = Object.keys(koffi.os.errno).find(key => koffi.os.errno[key] === errno) || 'EIO';
  throw failure(code, 'Restricted memory operation failed: ' + code);
}
const metadata = fd => fs.fstatSync(fd, {bigint: true});
const sameObject = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameRevision = (a, b) => sameObject(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
function regular(info) {
  if (!info.isFile()) throw failure('EINVAL', 'Memory target must be a regular file');
  if (info.nlink !== 1n) throw failure('EMLINK', 'Memory target must have exactly one link');
}
function byteLimit(value = DEFAULT_LIMIT) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure('EINVAL', 'Invalid memory byte limit');
  return Math.min(value, HARD_LIMIT);
}
function openDir(parent, name, create) {
  let fd = openat(parent, name, READ_FLAGS | c.O_DIRECTORY);
  if (fd < 0 && koffi.errno() === koffi.os.errno.ENOENT && create) {
    const made = mkdirat(parent, name, 448);
    if (made < 0 && koffi.errno() !== koffi.os.errno.EEXIST) check(made);
    fd = openat(parent, name, READ_FLAGS | c.O_DIRECTORY);
  }
  return check(fd);
}
function verify(node) {
  // 只检查根 inode 会漏过内部父目录交换；保留并复核从文件系统根到父目录的每一条边。
  for (let index = 1; index < node.chain.length; index++) {
    const parent = node.chain[index - 1], expected = node.chain[index];
    let fd;
    try {
      fd = openDir(parent.fd, expected.name, false);
      if (!sameObject(metadata(fd), expected.info)) throw stale();
    } catch (error) {
      if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) throw stale('Memory directory chain changed');
      throw error;
    } finally { if (fd !== undefined) closeFd(fd); }
  }
}
function pin(root, relative, create) {
  if (typeof root !== 'string' || typeof relative !== 'string' || !path.isAbsolute(root) || path.isAbsolute(relative) ||
      root.includes('\0') || relative.includes('\0') || [...root.split(/[\\/]/), ...relative.split(/[\\/]/)].some(part => part === '..')) {
    throw failure('EINVAL', 'Invalid memory path');
  }
  const chain = [];
  const retain = (fd, name) => { const entry = {fd, name}; chain.push(entry); entry.info = metadata(fd); return fd; };
  try {
    let fd = retain(openDir(process.platform === 'darwin' ? -2 : -100, '/', false), '/');
    for (const part of root.split(path.sep).filter(part => part && part !== '.')) fd = retain(openDir(fd, part, create), part);
    const parts = relative.split(path.sep).filter(part => part && part !== '.');
    const name = parts.pop() || '.';
    for (const part of parts) fd = retain(openDir(fd, part, create), part);
    const node = {chain, fd, name};
    verify(node);
    const id = nextId++; nodes.set(id, node); return id;
  } catch (error) { for (const entry of chain.reverse()) closeFd(entry.fd); throw error; }
}
function nodeFor(id) { const node = nodes.get(id); if (!node) throw failure('EBADF', 'Memory capability is closed'); return node; }
function verifyName(node, name, expected) {
  let fd;
  try {
    fd = check(openat(node.fd, name, READ_FLAGS));
    const actual = metadata(fd);
    if (expected.isFile()) regular(actual);
    if (!sameObject(actual, expected) || (expected.isFile() && !sameRevision(actual, expected))) throw stale();
  } catch (error) { if (error.code === 'ENOENT') throw stale('Memory target disappeared'); throw error; }
  finally { if (fd !== undefined) closeFd(fd); }
}
function snapshot(node, maxBytes = DEFAULT_LIMIT) {
  const limit = byteLimit(maxBytes); verify(node);
  const fd = check(openat(node.fd, node.name, READ_FLAGS));
  try {
    const info = metadata(fd); regular(info);
    if (info.size > BigInt(limit)) throw failure('PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED', 'Memory preview exceeds size limit');
    // 多读一个字节检测增长，但按原始大小和硬上限分配；解码不参与 hash 和字节预算。
    const buffer = Buffer.alloc(Number(info.size) + 1); let count = 0;
    while (count < buffer.length) { const next = fs.readSync(fd, buffer, count, buffer.length - count, count); if (!next) break; count += next; }
    const final = metadata(fd); regular(final);
    if (BigInt(count) !== info.size || !sameRevision(final, info)) throw failure('PROJECT_MEMORY_FILE_CHANGED', 'Memory changed during read');
    verifyName(node, node.name, final); verify(node);
    const bytes = buffer.subarray(0, count);
    return {info: final, result: {content: bytes.toString('utf8'), bytes, size: bytes.length, mtimeMs: Number(final.mtimeNs) / 1e6,
      hash: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')}};
  } finally { closeFd(fd); }
}
function observe(node, value) { node.observed = value ? {info: value.info, hash: value.result.hash} : null; }
function read(node, limit) {
  try { const value = snapshot(node, limit); observe(node, value); return value.result; }
  catch (error) { if (error.code === 'ENOENT') observe(node, null); throw error; }
}
function optionalSnapshot(node) {
  try { return snapshot(node, HARD_LIMIT); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function assertObserved(node, value) {
  if (node.observed === undefined) return;
  if (node.observed === null ? value !== undefined : !value || !sameRevision(node.observed.info, value.info) || node.observed.hash !== value.result.hash) throw stale();
}
function sameSnapshot(a, b) { return a === undefined ? b === undefined : b !== undefined && sameRevision(a.info, b.info) && a.result.hash === b.result.hash; }
function stat(node) {
  verify(node);
  const fd = check(openat(node.fd, node.name, READ_FLAGS));
  try {
    const info = metadata(fd); if (info.isFile()) regular(info);
    verifyName(node, node.name, info); verify(node);
    return {kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', sizeBytes: Number(info.size), mtimeMs: Number(info.mtimeNs) / 1e6};
  } finally { closeFd(fd); }
}
function cleanupTemp(node, name, owned) {
  let fd;
  try {
    fd = check(openat(node.fd, name, READ_FLAGS));
    if (sameObject(metadata(fd), metadata(owned))) check(unlinkat(node.fd, name, 0));
  } catch (error) { if (!['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) throw error; }
  finally { if (fd !== undefined) closeFd(fd); }
}
function replace(node, value, expectedHash, absent, cancellation) {
  const gate = admission(cancellation); assertAllowed(gate);
  if (typeof value !== 'string') throw failure('EINVAL', 'Memory replacement must be text');
  if (Buffer.byteLength(value, 'utf8') > HARD_LIMIT) throw failure('PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED', 'Memory replacement exceeds size limit');
  const before = optionalSnapshot(node); assertAllowed(gate); assertObserved(node, before);
  if ((absent && before) || (expectedHash !== undefined && expectedHash !== before?.result.hash)) throw stale('Memory revision changed');
  const temp = '.memory-' + crypto.randomUUID() + '.tmp';
  verify(node);
  const fd = check(openat(node.fd, temp, c.O_RDWR | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW | (c.O_CLOEXEC || 0), 384));
  let succeeded = false;
  try {
    assertAllowed(gate); regular(metadata(fd)); fs.writeFileSync(fd, value, 'utf8'); fs.fsyncSync(fd);
    assertAllowed(gate); const prepared = metadata(fd); regular(prepared); verify(node);
    const latest = optionalSnapshot(node);
    if (!sameSnapshot(before, latest)) throw stale('Memory changed during preparation');
    verifyName(node, temp, prepared); verify(node);
    // 原子准入之后不再因取消提前返回；必须等待本次 native 提交、校验与 ACK 的真实结果。
    admit(gate);
    // rename/unlink 只操作固定父目录内的目录项，不跟随最终链接；非协作编辑器的最后 CAS 窗口仍存在。
    if (absent) { check(linkat(node.fd, temp, node.fd, node.name, 0)); check(unlinkat(node.fd, temp, 0)); }
    else check(renameat(node.fd, temp, node.fd, node.name));
    fs.fsyncSync(node.fd); verify(node);
    const result = snapshot(node, HARD_LIMIT);
    const writtenHash = 'sha256:' + crypto.createHash('sha256').update(value, 'utf8').digest('hex');
    if (!sameObject(result.info, prepared) || result.result.hash !== writtenHash) throw stale('Memory changed after replacement');
    observe(node, result); succeeded = true; return result.result;
  } finally {
    // 写入或 flush 失败也清理临时文件；按 inode 清理，不能误删被换入的其他文件。
    try { cleanupTemp(node, temp, fd); } catch (error) { if (succeeded) throw error; }
    finally { closeFd(fd); }
  }
}
function list(node) {
  verify(node);
  const fd = openDir(node.fd, node.name, false), names = [];
  let directory;
  try {
    const info = metadata(fd); directory = fdopendir(fd);
    if (!directory) check(-1);
    let entry;
    while ((entry = readdir(directory))) {
      const offset = process.platform === 'darwin' ? 21 : 19;
      const length = koffi.decode(entry, 16, 'uint16_t') - offset;
      if (length <= 0 || length > 2048) throw failure('EIO', 'Invalid memory directory entry');
      const buffer = Buffer.from(koffi.decode(entry, offset, 'uint8_t', length));
      const end = buffer.indexOf(0), name = buffer.subarray(0, end < 0 ? buffer.length : end).toString('utf8');
      if (name !== '.' && name !== '..') names.push(name);
    }
    verifyName(node, node.name, info); verify(node); return names;
  } finally { if (directory) closedir(directory); else closeFd(fd); }
}
function remove(node, expectedHash, cancellation) {
  const gate = admission(cancellation); assertAllowed(gate);
  const before = snapshot(node, HARD_LIMIT); assertAllowed(gate); assertObserved(node, before);
  if (before.result.hash !== expectedHash) throw stale('Memory revision changed');
  verifyName(node, node.name, before.info); verify(node); admit(gate);
  check(unlinkat(node.fd, node.name, 0)); fs.fsyncSync(node.fd); verify(node);
  if (optionalSnapshot(node)) throw stale('Memory target recreated after removal');
  observe(node, null);
}
function close(id) { const node = nodes.get(id); if (node) { for (const entry of node.chain.reverse()) closeFd(entry.fd); nodes.delete(id); } }
parentPort.on('message', ({id, command, args}) => {
  try {
    if (!Array.isArray(args)) throw failure('EINVAL', 'Invalid memory operation arguments');
    let result;
    if (command === 'pin') result = pin(...args);
    else if (command === 'close') result = close(args[0]);
    else if (command === 'read') result = read(nodeFor(args[0]), args[1]);
    else if (command === 'stat') result = stat(nodeFor(args[0]));
    else if (command === 'list') result = list(nodeFor(args[0]));
    else if (command === 'replace') result = replace(nodeFor(args[0]), ...args.slice(1));
    else if (command === 'remove') result = remove(nodeFor(args[0]), args[1], args[2]);
    else throw failure('EINVAL', 'Unknown memory operation');
    parentPort.postMessage({id, result});
  } catch (error) { parentPort.postMessage({id, error: {message: error.message, code: error.code, name: error.name}}); }
});
`;
