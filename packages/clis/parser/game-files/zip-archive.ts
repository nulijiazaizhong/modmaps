import { assert } from '@truckermudgeon/base/assert';
import { Preconditions } from '@truckermudgeon/base/precon';
import fs from 'fs';
import path from 'path';
import * as r from 'restructure';
import { Byte } from './restructure-helpers';
import type { DirectoryEntry, Entries, FileEntry } from './scs-archive';
import { city64, createStore, deflate } from './scs-archive';

const CompressionMethod = {
  None: 0,
  Deflate: 8,
};

const Signature = {
  EndOfCentralDirectory: 0x06054b50,
  CentralDirectoryFileHeader: 0x02014b50,
};

const EndOfCentralDirectory = new r.Struct({
  diskNr: r.uint16le,
  centralDirectoryDiskNr: r.uint16le,
  diskEntries: r.uint16le,
  totalEntries: r.uint16le,
  centralDirectorySize: r.uint32le,
  centralDirectoryOffset: r.uint32le,
  commentLength: r.uint16le,
  comment: new r.String(0),
});

const CentralDirectoryFileHeader = new r.Struct({
  versionMadeBy: r.uint16le,
  versionNeeded: r.uint16le,
  flags: r.uint16le,
  compressedMethod: r.uint16le,
  fileModificationTime: r.uint16le,
  fileModificationDate: r.uint16le,
  crc32: r.uint32le,
  compressedSize: r.uint32le,
  uncompressedSize: r.uint32le,
  fileNameLength: r.uint16le,
  extraFieldLength: r.uint16le,
  fileCommentLength: r.uint16le,
  diskNr: r.uint16le,
  internalAttribs: r.uint16le,
  externalAttribs: r.uint32le,
  localFileHeaderOffset: r.uint32le,
  fileName: new r.String(0),
  extraField: new Byte(0),
  fileComment: new r.String(0),
});

class ZipReader {
  public readonly fileSize: number;
  private __offset: number;

  constructor(
    readonly fd: number,
    readonly path: string,
  ) {
    this.fileSize = fs.statSync(this.path).size;
    this.__offset = 0;
  }

  get offset(): number {
    return this.__offset;
  }

  set offset(position: number) {
    this.__offset = position;
  }

  SeekOffset(length: number) {
    this.offset += length;
  }

  ReadBytes(length: number) {
    const buffer = Buffer.alloc(length);
    fs.readSync(this.fd, buffer, {
      length: buffer.length,
      position: this.offset,
    });
    this.offset += length;
    return buffer;
  }

  ReadUInt16LE() {
    const buffer = Buffer.alloc(2);
    fs.readSync(this.fd, buffer, {
      length: buffer.length,
      position: this.offset,
    });
    this.offset += buffer.length;
    return buffer.readUInt16LE();
  }

  ReadUInt32LE() {
    const buffer = Buffer.alloc(4);
    fs.readSync(this.fd, buffer, {
      length: buffer.length,
      position: this.offset,
    });
    this.offset += buffer.length;
    return buffer.readUInt32LE();
  }

  dispose() {
    fs.closeSync(this.fd);
  }
}

export class ZipArchive {
  private readonly reader: ZipReader;
  private readonly eocdRecord;
  private readonly endOfCentralDirOffset: number = -1;
  private entries: Entries | undefined;
  private readonly isPLrebuild: boolean = false;
  private readonly isDlcSupport: boolean = false;

  constructor(
    readonly fd: number,
    readonly path: string,
  ) {
    // Poland rebuild def file has difference directory tree
    if (/.*PL_Rebuilding.*def.*/.test(path)) this.isPLrebuild = true;
    // promods dlc support file has difference directory tree
    if (path.includes('dlcsupport')) this.isDlcSupport = true;
    this.reader = new ZipReader(fd, path);

    this.endOfCentralDirOffset = this.FindEndHeaderOffset();
    assert(this.endOfCentralDirOffset >= 0);

    this.reader.offset = this.endOfCentralDirOffset + 4;
    const buffer = this.reader.ReadBytes(EndOfCentralDirectory.size());
    this.eocdRecord = EndOfCentralDirectory.fromBuffer(buffer);
    this.eocdRecord.comment = this.reader
      .ReadBytes(this.eocdRecord.commentLength)
      .toString();
  }

  isValid(): boolean {
    return true;
  }

  parseEntries(): Entries {
    Preconditions.checkState(this.isValid());
    if (this.entries) {
      return this.entries;
    }

    this.reader.offset = this.eocdRecord.centralDirectoryOffset;
    const entries: r.BaseOf<typeof CentralDirectoryFileHeader>[] = [];

    while (
      this.reader.offset <
      this.eocdRecord.centralDirectoryOffset +
        this.eocdRecord.centralDirectorySize
    ) {
      const signature = this.reader.ReadUInt32LE();
      if (signature !== Signature.CentralDirectoryFileHeader) {
        break;
      }
      const buffer = this.reader.ReadBytes(CentralDirectoryFileHeader.size());
      const file = CentralDirectoryFileHeader.fromBuffer(buffer);

      file.fileName = this.reader.ReadBytes(file.fileNameLength).toString();
      file.extraField = this.reader.ReadBytes(file.extraFieldLength);
      file.fileComment = this.reader
        .ReadBytes(file.fileCommentLength)
        .toString();

      entries.push(file);
    }

    if (this.isPLrebuild || this.isDlcSupport) {
      for (const entry of entries) {
        if (entry.fileName.includes('/')) {
          entry.fileName = entry.fileName.split('/').slice(1).join('/');
        }
      }
    }
    const directoryTree = createDirectoryTree(entries);
    const directories: DirectoryEntry[] = [];
    const files: FileEntry[] = [];

    // create dir entry manually to fix incomplete entries
    for (const key of directoryTree.keys()) {
      const entry = {
        versionMadeBy: 0,
        versionNeeded: 0,
        flags: 0,
        compressedMethod: 0,
        fileModificationTime: 0,
        fileModificationDate: 0,
        crc32: 0,
        compressedSize: 0,
        uncompressedSize: 0,
        fileNameLength: 0,
        extraFieldLength: 0,
        fileCommentLength: 0,
        diskNr: 0,
        internalAttribs: 0,
        externalAttribs: 0,
        localFileHeaderOffset: 0,
        fileName: key,
        fileComment: '',
      } as r.BaseOf<typeof CentralDirectoryFileHeader>;

      const dirEntry = createEntry(this.reader, entry, directoryTree);
      if (dirEntry.type === 'directory') {
        directories.push(dirEntry);
      }
    }

    for (const entry of entries) {
      if (entry.uncompressedSize === 0) continue;

      const zipEntry = createEntry(this.reader, entry, directoryTree);
      if (zipEntry.type === 'directory') {
        directories.push(zipEntry);
      } else {
        files.push(zipEntry);
      }
    }

    this.entries = {
      directories: createStore(directories, 0),
      files: createStore(files, 0),
    };
    return this.entries;
  }

  private FindEndHeaderOffset() {
    const fileSize = this.reader.fileSize;
    assert(fileSize > 0);
    const maxEndSize = Math.min(22 + 0xffff, fileSize); // END header size + max zip file comment length < fileSize
    this.reader.offset = fileSize - maxEndSize;
    const buffer = this.reader.ReadBytes(maxEndSize);

    let index = buffer.length - 22;
    for (index; index >= 0; index--) {
      if (buffer[index] !== 0x50) continue;
      if (buffer.readUint32LE(index) === Signature.EndOfCentralDirectory) {
        return fileSize - maxEndSize + index;
      }
    }
    return -1;
  }

  dispose() {
    this.reader.dispose();
  }
}

function createEntry(
  reader: ZipReader,
  entry: r.BaseOf<typeof CentralDirectoryFileHeader>,
  directoryTree: Map<string, DirectoryTree>,
): DirectoryEntry | FileEntry {
  return entry.uncompressedSize > 0
    ? new ZipArchiveFile(reader, entry)
    : new ZipArchiveDirectory(reader, entry, directoryTree);
}

abstract class ZipArchiveEntry {
  abstract type: string;

  protected constructor(
    protected readonly reader: ZipReader,
    protected readonly entry: r.BaseOf<typeof CentralDirectoryFileHeader>,
  ) {}

  get hash(): bigint {
    return city64(this.entry.fileName);
  }

  read() {
    this.reader.offset = this.entry.localFileHeaderOffset + 26;
    const fileNameLength = this.reader.ReadUInt16LE();
    const extraFieldLength = this.reader.ReadUInt16LE();
    this.reader.SeekOffset(fileNameLength + extraFieldLength);
    const rawData = this.reader.ReadBytes(this.entry.compressedSize);

    switch (this.entry.compressedMethod) {
      case CompressionMethod.Deflate: {
        const outBuffer = Buffer.alloc(this.entry.uncompressedSize);

        const result = deflate(rawData.buffer, outBuffer.buffer);
        if (result !== 0) {
          throw new Error(`deflate error: ${result}`);
        }
        return outBuffer;
      }

      case CompressionMethod.None: {
        return rawData;
      }

      default:
        throw new Error(
          `unsupported compression type ${this.entry.compressedMethod}`,
        );
    }
  }
}

class ZipArchiveFile extends ZipArchiveEntry implements FileEntry {
  readonly type = 'file';

  constructor(
    reader: ZipReader,
    entry: r.BaseOf<typeof CentralDirectoryFileHeader>,
  ) {
    super(reader, entry);
  }
}

class ZipArchiveDirectory extends ZipArchiveEntry implements DirectoryEntry {
  readonly type = 'directory';
  readonly subdirectories: readonly string[];
  readonly files: readonly string[];

  constructor(
    reader: ZipReader,
    entry: r.BaseOf<typeof CentralDirectoryFileHeader>,
    directoryTree: Map<string, DirectoryTree>,
  ) {
    super(reader, entry);

    const child = directoryTree.get(entry.fileName);
    if (child) {
      this.subdirectories = child.subdirectories;
      this.files = child.files;
    } else {
      this.subdirectories = [];
      this.files = [];
    }
  }
}

function createDirectoryTree(
  entries: r.BaseOf<typeof CentralDirectoryFileHeader>[],
) {
  const directoryTree = new Map<string, DirectoryTree>();

  for (const entry of entries) {
    let parent = path.dirname(entry.fileName);
    const child = path.basename(entry.fileName);
    if (child === '') {
      continue;
    }

    if (parent === '.') {
      parent = '';
    }
    const parentDir = getParentDir(parent, new DirectoryTree(), directoryTree);
    if (entry.uncompressedSize > 0) {
      parentDir.files.push(child);
    } else if (!parentDir.subdirectories.includes(child)) {
      parentDir.subdirectories.push(child);
    }
  }

  return directoryTree;
}

function getParentDir(
  key: string,
  defValue: DirectoryTree,
  map: Map<string, DirectoryTree>,
) {
  let parent = path.dirname(key);
  const child = path.basename(key);
  if (parent === '.') parent = '';
  if (child !== '') {
    const parentDir = getParentDir(parent, new DirectoryTree(), map);
    if (!parentDir.subdirectories.includes(child))
      parentDir.subdirectories.push(child);
  }

  let V = map.get(key);
  if (V == null) {
    V = defValue;
    map.set(key, V);
  }
  return V;
}

class DirectoryTree {
  readonly subdirectories: string[] = [];
  readonly files: string[] = [];
}
