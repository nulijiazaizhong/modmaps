import { assert } from '@truckermudgeon/base/assert';
import { Preconditions } from '@truckermudgeon/base/precon';
import fs from 'fs';
import path from 'path';
import * as r from 'restructure';
import { Byte } from './restructure-helpers';
import type { DirectoryEntry, Entries, FileEntry } from './scs-archive';
import { city64, createStore, gdeflate, TileStreamHeader } from './scs-archive';

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
  public offset: number;
  private readonly fd: number;
  public readonly fileSize: number;

  constructor(readonly path: string) {
    this.fd = fs.openSync(path, 'r');
    this.fileSize = fs.statSync(this.path).size;
    this.offset = 0;
  }

  Seek(position: number) {
    this.offset = position;
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

  constructor(readonly path: string) {
    this.reader = new ZipReader(path);

    this.endOfCentralDirOffset = this.FindEndHeaderOffset();
    assert(this.endOfCentralDirOffset >= 0);

    this.reader.Seek(this.endOfCentralDirOffset + 4);
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

    this.reader.Seek(this.eocdRecord.centralDirectoryOffset);
    const entries: r.BaseOf<typeof CentralDirectoryFileHeader>[] = [];

    while (
      this.reader.offset <
      this.eocdRecord.centralDirectoryOffset +
        this.eocdRecord.centralDirectorySize
    ) {
      const signature = this.reader.ReadUInt32LE();
      assert(signature === Signature.CentralDirectoryFileHeader);

      const buffer = this.reader.ReadBytes(CentralDirectoryFileHeader.size());
      const file = CentralDirectoryFileHeader.fromBuffer(buffer);

      file.fileName = this.reader.ReadBytes(file.fileNameLength).toString();
      file.extraField = this.reader.ReadBytes(file.extraFieldLength);
      file.fileComment = this.reader
        .ReadBytes(file.fileCommentLength)
        .toString();

      entries.push(file);
    }

    const directoryTree = createDirectoryTree(entries);
    const directories: DirectoryEntry[] = [];
    const files: FileEntry[] = [];

    const topEntry = {
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
      fileName: '',
      fileComment: '',
    } as r.BaseOf<typeof CentralDirectoryFileHeader>;
    const topDirEntry = createEntry(this.reader, topEntry, directoryTree);
    if (topDirEntry.type === 'directory') {
      directories.push(topDirEntry);
    }

    for (const entry of entries) {
      if (entry.fileName.endsWith('/')) {
        entry.fileName = entry.fileName.substring(
          0,
          entry.fileName.lastIndexOf('/'),
        );
      }
      const zipEntry = createEntry(this.reader, entry, directoryTree);
      if (zipEntry.type === 'directory') {
        directories.push(zipEntry);
      } else {
        files.push(zipEntry);
      }
    }

    this.entries = {
      directories: createStore(directories),
      files: createStore(files),
    };
    return this.entries;
  }

  private FindEndHeaderOffset() {
    const fileSize = this.reader.fileSize;
    assert(fileSize > 0);
    const maxEndSize = Math.min(22 + 0xffff, fileSize); // END header size + max zip file comment length < fileSize
    this.reader.Seek(fileSize - maxEndSize);
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
    this.reader.Seek(this.entry.localFileHeaderOffset + 26);
    const fileNameLength = this.reader.ReadUInt16LE();
    const extraFieldLength = this.reader.ReadUInt16LE();
    this.reader.SeekOffset(fileNameLength + extraFieldLength);
    const rawData = this.reader.ReadBytes(this.entry.compressedSize);

    switch (this.entry.compressedMethod) {
      case CompressionMethod.Deflate: {
        const outBuffer = Buffer.alloc(this.entry.uncompressedSize);
        const result = gdeflate(
          rawData.buffer.slice(TileStreamHeader.size()),
          outBuffer.buffer,
        );
        if (result !== 0) {
          throw new Error(`gdeflate error: ${result}`);
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

    if (directoryTree.has(entry.fileName)) {
      // eslint-disable-next-line
      // @ts-ignore
      this.subdirectories = directoryTree.get(entry.fileName).subdirectories;
      // eslint-disable-next-line
      // @ts-ignore
      this.files = directoryTree.get(entry.fileName).files;
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
    if (!directoryTree.has(parent)) {
      const newChild = new DirectoryTree();
      directoryTree.set(parent, newChild);
    }
    if (entry.uncompressedSize > 0) {
      directoryTree.get(parent)?.files.push(child);
    } else {
      directoryTree.get(parent)?.subdirectories.push(child);
    }
  }

  return directoryTree;
}

class DirectoryTree {
  readonly subdirectories: string[] = [];
  readonly files: string[] = [];
}
