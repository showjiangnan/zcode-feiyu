// Modified by ZCode Feiyu contributors (2026).
/** Windows 与 POSIX 使用相同的句柄能力边界，逐段 NtCreateFile 并拒绝 reparse point。 */
export const SECURE_MEMORY_WINDOWS_WORKER = String.raw`
const {parentPort, workerData} = require('node:worker_threads');
const path = require('node:path').win32;
const crypto = require('node:crypto');
const koffi = require(workerData.koffiPath);
const nt = koffi.load('ntdll.dll'), kernel = koffi.load('kernel32.dll');
const unicode = koffi.struct({Length:'uint16',MaximumLength:'uint16',Buffer:'str16'});
const attrs = koffi.struct({Length:'uint32',RootDirectory:'void *',ObjectName:koffi.pointer(unicode),Attributes:'uint32',SecurityDescriptor:'void *',SecurityQualityOfService:'void *'});
const create = nt.func('NtCreateFile','int32',[koffi.out(koffi.pointer('void *')),'uint32',koffi.pointer(attrs),koffi.out('void *'),'void *','uint32','uint32','uint32','uint32','void *','uint32']);
const queryDir = nt.func('NtQueryDirectoryFile','int32',['void *','void *','void *','void *',koffi.out('void *'),koffi.out('void *'),'uint32','int','uint8','void *','uint8']);
const setInfo = nt.func('NtSetInformationFile','int32',['void *',koffi.out('void *'),'void *','uint32','int']);
const closeHandle = kernel.func('bool CloseHandle(void *)');
const fileInfo = kernel.func('GetFileInformationByHandleEx','bool',['void *','int',koffi.out('void *'),'uint32']);
const fileType = kernel.func('uint32 GetFileType(void *)');
const readFile = kernel.func('ReadFile','bool',['void *',koffi.out('void *'),'uint32',koffi.out('uint32 *'),'void *']);
const writeFile = kernel.func('WriteFile','bool',['void *','void *','uint32',koffi.out('uint32 *'),'void *']);
const flush = kernel.func('bool FlushFileBuffers(void *)');
const getError = kernel.func('uint32 GetLastError()');
const DEFAULT_LIMIT = 2 * 1024 * 1024, HARD_LIMIT = 5 * 1024 * 1024;
const POINTER_SIZE = koffi.sizeof('void *'), IOSB_SIZE = POINTER_SIZE * 2, WINDOWS_EPOCH = 116444736000000000n;
const ACCESS_READ = 0x100081, ACCESS_INSPECT = 0x100080, ACCESS_WRITE = 0x120116, ACCESS_DELETE = 0x10000, ACCESS_TRAVERSE = 0x20;
const SHARE_READ = 1, SHARE_WRITE = 2, SHARE_DELETE = 4;
const OPEN_OPTIONS = 0x200020, DIRECTORY_OPTION = 1, FILE_OPTION = 0x40, OBJECT_OPTIONS = 0x1040;
const FILE_RENAME_INFORMATION = 10, FILE_DISPOSITION_INFORMATION = 13, FILE_NAMES_INFORMATION = 12;
const nodes = new Map(); let nextId = 1;
function failure(code, message) { return Object.assign(new Error(message), {code}); }
function stale(message = 'Memory path identity or revision changed') { return failure('ESTALE', message); }
const ADMISSION_OPEN = 0, ADMISSION_CANCELLED = 1, ADMISSION_COMMITTING = 2;
function admission(buffer) {
  if (buffer === undefined) return;
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== Int32Array.BYTES_PER_ELEMENT) throw failure('EINVAL','Invalid memory cancellation gate');
  return new Int32Array(buffer);
}
function assertAllowed(gate) {
  if (gate && Atomics.load(gate,0) === ADMISSION_CANCELLED) throw Object.assign(failure('ABORT_ERR','Memory mutation cancelled before commit'),{name:'AbortError'});
}
function admit(gate) {
  if (!gate) return;
  const previous = Atomics.compareExchange(gate,0,ADMISSION_OPEN,ADMISSION_COMMITTING);
  if (previous !== ADMISSION_OPEN) { assertAllowed(gate); throw failure('EINVAL','Memory admission gate already used'); }
}
function fail(status) {
  const value = status >>> 0;
  const code = [0xc000000f,0xc0000034,0xc000003a,2,3].includes(value) ? 'ENOENT'
    : [0xc0000035,80,183].includes(value) ? 'EEXIST'
    : [0xc000050b,0xc0000279,0xc0000280,1920].includes(value) ? 'ELOOP'
    : value === 0xc0000103 ? 'ENOTDIR' : value === 0xc00000ba ? 'EISDIR'
    : [0xc0000043,32].includes(value) ? 'EBUSY' : value === 0xc0000056 ? 'ESTALE' : 'EACCES';
  throw failure(code, 'Restricted memory operation failed: ' + code + ' (' + value.toString(16) + ')');
}
function info(handle) {
  if (fileType(handle) !== 1) throw failure('EINVAL', 'Memory target must be on a disk filesystem');
  const basic = Buffer.alloc(40), standard = Buffer.alloc(24), identity = Buffer.alloc(24);
  if (!fileInfo(handle,0,basic,basic.length) || !fileInfo(handle,1,standard,standard.length) || !fileInfo(handle,18,identity,identity.length)) fail(getError());
  if (basic.readUInt32LE(32) & 0x400) throw failure('ELOOP', 'Memory reparse points are forbidden');
  if (standard[20]) throw stale('Memory target is pending deletion');
  const size = standard.readBigInt64LE(8), writeTime = basic.readBigInt64LE(16);
  if (size < 0n) throw failure('EIO', 'Invalid memory file size');
  return {kind: standard[21] ? 'directory' : 'file', size, links: standard.readUInt32LE(16),
    writeTime, changeTime: basic.readBigInt64LE(24), creationTime: basic.readBigInt64LE(0),
    mtimeMs: Number(writeTime - WINDOWS_EPOCH) / 10000, identity: identity.toString('hex')};
}
function regular(metadata) {
  if (metadata.kind !== 'file') throw failure('EINVAL', 'Memory target must be a regular file');
  if (metadata.links !== 1) throw failure('EMLINK', 'Memory target must have exactly one link');
}
const sameObject = (a,b) => a.identity === b.identity;
const sameRevision = (a,b) => sameObject(a,b) && a.size === b.size && a.links === b.links && a.writeTime === b.writeTime && a.changeTime === b.changeTime && a.creationTime === b.creationTime;
function byteLimit(value = DEFAULT_LIMIT) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure('EINVAL', 'Invalid memory byte limit');
  return Math.min(value,HARD_LIMIT);
}
function open(parent,name,{directory=false,file=false,createNew=false,write=false,remove=false,inspect=false,share=directory ? SHARE_READ | SHARE_WRITE : SHARE_READ | SHARE_WRITE | SHARE_DELETE}={}) {
  const object = {Length:koffi.sizeof(attrs),RootDirectory:parent,ObjectName:{Length:name.length*2,MaximumLength:(name.length+1)*2,Buffer:name},
    Attributes:OBJECT_OPTIONS,SecurityDescriptor:null,SecurityQualityOfService:null};
  const out = [null], access = (inspect ? ACCESS_INSPECT : ACCESS_READ) | (directory ? ACCESS_TRAVERSE : 0) | (write ? ACCESS_WRITE : 0) | (remove ? ACCESS_DELETE : 0);
  const status = create(out,access,object,Buffer.alloc(IOSB_SIZE),null,0x80,share,createNew ? 2 : 1,OPEN_OPTIONS | (directory ? DIRECTORY_OPTION : file ? FILE_OPTION : 0),null,0);
  if (status < 0) fail(status);
  try { info(out[0]); return out[0]; } catch(error) { closeHandle(out[0]); throw error; }
}
function component(name) {
  if (!name || name === '.' || name === '..' || name.length > 255 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[ .]$/.test(name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) {
    throw failure('EINVAL', 'Invalid local memory path component');
  }
}
function verify(node) {
  // 固定目录不共享 delete，阻止句柄存续期重命名；逐边检查同时覆盖盘符映射和 reparse 变化。
  for (let index = 0; index < node.chain.length; index++) {
    const expected = node.chain[index]; let handle;
    try {
      handle = open(index ? node.chain[index - 1].handle : null,expected.name,{directory:true});
      if (!sameObject(info(handle),expected.info)) throw stale();
    } catch(error) {
      if (['ENOENT','ELOOP','ENOTDIR'].includes(error.code)) throw stale('Memory directory chain changed');
      throw error;
    } finally { if (handle) closeHandle(handle); }
  }
}
function pin(root,relative,createParents) {
  if (typeof root !== 'string' || typeof relative !== 'string') throw failure('EINVAL', 'Invalid local memory path');
  const drive = path.parse(root).root;
  if (!/^[a-zA-Z]:[\\/]$/.test(drive) || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || root.includes('\0') || relative.includes('\0')) throw failure('EINVAL', 'Invalid local memory path');
  const rootParts = root.slice(drive.length).split(/[\\/]/).filter(Boolean);
  const parts = relative === '.' ? [] : relative.split(/[\\/]/).filter(Boolean);
  for (const part of [...rootParts,...parts]) component(part);
  const name = parts.pop() || '.', chain = [];
  const retain = (handle,name) => { const entry = {handle,name}; chain.push(entry); entry.info = info(handle); return handle; };
  try {
    let handle = retain(open(null,'\\??\\'+drive.replace('/','\\'),{directory:true}),'\\??\\'+drive.replace('/','\\'));
    for (const part of [...rootParts,...parts]) {
      let next;
      try { next = open(handle,part,{directory:true}); }
      catch(error) {
        if (!createParents || error.code !== 'ENOENT') throw error;
        try { next = open(handle,part,{directory:true,createNew:true}); }
        catch(race) { if (race.code !== 'EEXIST') throw race; next = open(handle,part,{directory:true}); }
      }
      handle = retain(next,part);
    }
    const node = {chain,handle,name}; verify(node);
    const id = nextId++; nodes.set(id,node); return id;
  } catch(error) { for (const entry of chain.reverse()) closeHandle(entry.handle); throw error; }
}
function nodeFor(id) { const node = nodes.get(id); if (!node) throw failure('EBADF','Memory capability is closed'); return node; }
function verifyName(node,name,expected) {
  let handle;
  try {
    handle = name === '.' ? node.handle : open(node.handle,name,{directory:expected.kind === 'directory',inspect:true});
    const actual = info(handle); if (expected.kind === 'file') regular(actual);
    if (!sameObject(actual,expected) || (expected.kind === 'file' && !sameRevision(actual,expected))) throw stale();
  } catch(error) { if (error.code === 'ENOENT') throw stale('Memory target disappeared'); throw error; }
  finally { if (handle && name !== '.') closeHandle(handle); }
}
function snapshot(node,maxBytes = DEFAULT_LIMIT,held) {
  const limit = byteLimit(maxBytes); verify(node);
  if (node.name === '.') throw failure('EINVAL','Memory target must be a regular file');
  // Windows 写时间可延迟到写句柄关闭；快照禁止共享写，而非用毫秒时间戳冒充一致性。
  const handle = held || open(node.handle,node.name,{file:true,share:SHARE_READ | SHARE_DELETE});
  try {
    const metadata = info(handle); regular(metadata);
    if (metadata.size > BigInt(limit)) throw failure('PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED','Memory preview exceeds size limit');
    const buffer = Buffer.alloc(Number(metadata.size) + 1); let count = 0;
    while (count < buffer.length) {
      const length = [0]; if (!readFile(handle,buffer.subarray(count),buffer.length-count,length,null)) fail(getError());
      if (!length[0]) break; count += length[0];
    }
    const final = info(handle); regular(final);
    if (BigInt(count) !== metadata.size || !sameRevision(final,metadata)) throw failure('PROJECT_MEMORY_FILE_CHANGED','Memory changed during read');
    verifyName(node,node.name,final); verify(node);
    const bytes = buffer.subarray(0,count);
    return {info:final,result:{content:bytes.toString('utf8'),bytes,size:bytes.length,mtimeMs:final.mtimeMs,
      hash:'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')}};
  } finally { if (!held) closeHandle(handle); }
}
function observe(node,value) { node.observed = value ? {info:value.info,hash:value.result.hash} : null; }
function read(node,limit) {
  try { const value = snapshot(node,limit); observe(node,value); return value.result; }
  catch(error) { if (error.code === 'ENOENT') observe(node,null); throw error; }
}
function optionalSnapshot(node) { try { return snapshot(node,HARD_LIMIT); } catch(error) { if (error.code !== 'ENOENT') throw error; } }
function assertObserved(node,value) {
  if (node.observed === undefined) return;
  if (node.observed === null ? value !== undefined : !value || !sameRevision(node.observed.info,value.info) || node.observed.hash !== value.result.hash) throw stale();
}
function sameSnapshot(a,b) { return a === undefined ? b === undefined : b !== undefined && sameRevision(a.info,b.info) && a.result.hash === b.result.hash; }
function stat(node) {
  verify(node);
  const handle = node.name === '.' ? node.handle : open(node.handle,node.name);
  try {
    const metadata = info(handle); if (metadata.kind === 'file') regular(metadata);
    verifyName(node,node.name,metadata); verify(node);
    return {kind:metadata.kind,sizeBytes:Number(metadata.size),mtimeMs:metadata.mtimeMs};
  } finally { if (node.name !== '.') closeHandle(handle); }
}
function dispose(handle) { const result = setInfo(handle,Buffer.alloc(IOSB_SIZE),Buffer.from([1]),1,FILE_DISPOSITION_INFORMATION); if (result < 0) fail(result); }
function replace(node,value,expectedHash,absent,cancellation) {
  const gate = admission(cancellation); assertAllowed(gate);
  if (typeof value !== 'string') throw failure('EINVAL','Memory replacement must be text');
  if (Buffer.byteLength(value,'utf8') > HARD_LIMIT) throw failure('PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED','Memory replacement exceeds size limit');
  const before = optionalSnapshot(node); assertAllowed(gate); assertObserved(node,before);
  if ((absent && before) || (expectedHash !== undefined && before?.result.hash !== expectedHash)) throw stale('Memory revision changed');
  const name = '.memory-'+crypto.randomUUID()+'.tmp'; verify(node);
  // 临时文件仅共享读，不允许第三方写入或替换；Nt 重命名使用本次持有的文件句柄。
  const handle = open(node.handle,name,{file:true,createNew:true,write:true,remove:true,share:SHARE_READ});
  let renamed = false, closed = false;
  try {
    assertAllowed(gate); const bytes = Buffer.from(value,'utf8'); let offset = 0;
    while (offset < bytes.length) {
      assertAllowed(gate); const count = [0]; if (!writeFile(handle,bytes.subarray(offset),bytes.length-offset,count,null)) fail(getError());
      if (!count[0]) throw failure('EIO','Memory write made no progress'); offset += count[0];
    }
    if (!flush(handle)) fail(getError()); assertAllowed(gate); const prepared = info(handle); regular(prepared); verify(node);
    const latest = optionalSnapshot(node); if (!sameSnapshot(before,latest)) throw stale('Memory changed during preparation');
    verifyName(node,name,prepared); verify(node);
    const renameInfo = koffi.struct({ReplaceIfExists:'uint8',RootDirectory:'void *',FileNameLength:'uint32',FileName:koffi.array('uint16',node.name.length)});
    const buffer = Buffer.alloc(koffi.sizeof(renameInfo));
    koffi.encode(buffer,renameInfo,{ReplaceIfExists:absent?0:1,RootDirectory:node.handle,FileNameLength:node.name.length*2,FileName:Array.from({length:node.name.length},(_,index)=>node.name.charCodeAt(index))});
    // 与 POSIX 同一准入线性化点：取消先赢不提交，提交先赢等待真实结果而不提前 ACK 取消。
    admit(gate);
    const status = setInfo(handle,Buffer.alloc(IOSB_SIZE),buffer,buffer.length,FILE_RENAME_INFORMATION); if (status < 0) fail(status); renamed = true;
    verify(node); verifyName(node,node.name,info(handle));
    // Windows 可能直到最后一个写句柄关闭才提交 LastWriteTime；关闭后再建立返回修订，避免下一次写误判 stale。
    closeHandle(handle); closed = true;
    const result = snapshot(node,HARD_LIMIT);
    if (!sameObject(result.info,prepared) || result.result.hash !== 'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')) throw stale('Memory changed after replacement');
    observe(node,result); return result.result;
  } finally {
    try { if (!renamed) { try { dispose(handle); } catch {} } } // 按拥有的 handle 清理；不删除最终路径或覆盖原始失败。
    finally { if (!closed) closeHandle(handle); }
  }
}
function remove(node,expectedHash,cancellation) {
  const gate = admission(cancellation); assertAllowed(gate);
  const before = snapshot(node,HARD_LIMIT); assertAllowed(gate); assertObserved(node,before);
  if (before.result.hash !== expectedHash) throw stale('Memory revision changed');
  const handle = open(node.handle,node.name,{file:true,remove:true,share:SHARE_READ});
  try {
    const current = snapshot(node,HARD_LIMIT,handle);
    if (!sameSnapshot(before,current)) throw stale();
    verifyName(node,node.name,current.info); verify(node); admit(gate); dispose(handle);
  } finally { closeHandle(handle); }
  verify(node); if (optionalSnapshot(node)) throw stale('Memory target recreated after removal'); observe(node,null);
}
function list(node) {
  verify(node);
  const handle = node.name === '.' ? node.handle : open(node.handle,node.name,{directory:true});
  const names = []; let restart = 1;
  try {
    const metadata = info(handle);
    while (true) {
      const buffer = Buffer.alloc(65536), iosb = Buffer.alloc(IOSB_SIZE);
      const result = queryDir(handle,null,null,null,iosb,buffer,buffer.length,FILE_NAMES_INFORMATION,0,null,restart); restart = 0;
      if ((result >>> 0) === 0x80000006) break; if (result < 0) fail(result);
      const used = POINTER_SIZE === 8 ? Number(iosb.readBigUInt64LE(POINTER_SIZE)) : iosb.readUInt32LE(POINTER_SIZE);
      if (used < 12 || used > buffer.length) throw failure('EIO','Invalid memory directory buffer');
      let offset = 0;
      while (offset + 12 <= used) {
        const next = buffer.readUInt32LE(offset), length = buffer.readUInt32LE(offset+8);
        if (length % 2 || offset + 12 + length > used) throw failure('EIO','Invalid memory directory entry');
        const name = buffer.subarray(offset+12,offset+12+length).toString('utf16le');
        if (name !== '.' && name !== '..') names.push(name); if (!next) break;
        if (next < 12 + length || offset + next >= used) throw failure('EIO','Invalid memory directory offset'); offset += next;
      }
    }
    verifyName(node,node.name,metadata); verify(node); return names;
  } finally { if (node.name !== '.') closeHandle(handle); }
}
function close(id) { const node = nodes.get(id); if (node) { for (const entry of node.chain.reverse()) closeHandle(entry.handle); nodes.delete(id); } }
parentPort.on('message',({id,command,args}) => {
  try {
    if (!Array.isArray(args)) throw failure('EINVAL','Invalid memory operation arguments');
    let result;
    if (command === 'pin') result = pin(...args);
    else if (command === 'close') result = close(args[0]);
    else if (command === 'read') result = read(nodeFor(args[0]),args[1]);
    else if (command === 'stat') result = stat(nodeFor(args[0]));
    else if (command === 'list') result = list(nodeFor(args[0]));
    else if (command === 'replace') result = replace(nodeFor(args[0]),...args.slice(1));
    else if (command === 'remove') result = remove(nodeFor(args[0]),args[1],args[2]);
    else throw failure('EINVAL','Unknown memory operation');
    parentPort.postMessage({id,result});
  } catch(error) { parentPort.postMessage({id,error:{message:error.message,code:error.code,name:error.name}}); }
});
`;
