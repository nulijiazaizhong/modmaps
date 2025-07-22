import { Preconditions } from '@truckermudgeon/base/precon';
import fs from 'fs';
import * as r from 'restructure';
import zlib from 'zlib';
import { logger } from '../logger';
import { uint64le } from './restructure-helpers';
import type { DirectoryEntry, Entries, FileEntry } from './scs-archive';
import { createStore } from './scs-archive';

const FileHeaderV1 = new r.Struct({
  magic: new r.String(4),
  version: r.int16le,
  salt: r.int16le,
  hashMethod: new r.String(4),
  numEntries: r.int32le,
  entriesOffset: r.int32le,
});

const EntryHeaderV1 = new r.Struct({
  hash: uint64le,
  // offset within the archive file at which the file for this entry's data starts.
  offset: uint64le,
  // bitfields can be referenced as entry.flags.isDirectory and entry.flags.isCompressed
  flags: new r.Bitfield(r.uint32le, ['isDirectory', 'isCompressed']),
  crc: r.uint32le,
  size: r.uint32le,
  compressedSize: r.uint32le,
});

export class ScsArchiveV1 {
  private readonly header;
  private entries: Entries | undefined;

  constructor(
    readonly fd: number,
    readonly path: string,
  ) {
    const buffer = Buffer.alloc(FileHeaderV1.size());
    fs.readSync(this.fd, buffer, { length: buffer.length, position: 0 });
    this.header = FileHeaderV1.fromBuffer(buffer);
  }

  dispose() {
    fs.closeSync(this.fd);
  }

  isValid(): boolean {
    return (
      this.header.magic === 'SCS#' &&
      this.header.hashMethod === 'CITY' &&
      this.header.version === 1
    );
  }

  parseEntries(): Entries {
    Preconditions.checkState(this.isValid());
    if (this.entries) {
      return this.entries;
    }

    const entryHeaders = new r.Array(
      EntryHeaderV1,
      this.header.numEntries,
    ).fromBuffer(
      this.readData({
        offset: this.header.entriesOffset,
        size: EntryHeaderV1.size() * this.header.numEntries,
      }),
    );

    const directories: DirectoryEntry[] = [];
    const files: FileEntry[] = [];
    for (const header of entryHeaders) {
      const entry = createEntryV1(this.fd, {
        hash: header.hash,
        offset: header.offset,
        size: header.compressedSize,
        isDirectory: header.flags.isDirectory,
        isDataCompressed: header.flags.isCompressed,
      });
      if (entry.type === 'directory') {
        directories.push(entry);
      } else {
        files.push(entry);
      }
    }
    this.entries = {
      directories: createStore(directories, this.header.salt),
      files: createStore(files, this.header.salt),
    };
    return this.entries;
  }

  private readData({
    offset, //
    size, //
  }: {
    offset: number;
    size: number;
  }): Buffer {
    const buffer = Buffer.alloc(size);
    fs.readSync(this.fd, buffer, {
      length: buffer.length,
      position: offset,
    });
    return buffer;
  }
}

interface EntryV1Metadata {
  hash: bigint;
  offset: bigint;
  size: number;
  isDirectory: boolean;
  isDataCompressed: boolean;
}

function createEntryV1(
  fd: number,
  metadata: EntryV1Metadata,
): DirectoryEntry | FileEntry {
  return metadata.isDirectory
    ? new ScsArchiveDirectoryV1(fd, metadata)
    : new ScsArchiveFileV1(fd, metadata);
}

abstract class ScsArchiveEntryV1 {
  abstract type: string;

  protected constructor(
    protected readonly fd: number,
    protected readonly metadata: EntryV1Metadata,
  ) {}

  get hash(): bigint {
    return this.metadata.hash;
  }

  read() {
    const rawData = Buffer.alloc(this.metadata.size);
    if (rawData.length === 0) return rawData;

    fs.readSync(this.fd, rawData, {
      length: rawData.length,
      position: this.metadata.offset,
    });
    if (!this.metadata.isDataCompressed) {
      return rawData;
    }
    try {
      return zlib.inflateSync(rawData);
    } catch (error) {
      logger.error(
        `Error inflating data for entry with hash ${this.hash}:`,
        error,
      );
      return rawData;
    }
  }
}

class ScsArchiveFileV1 extends ScsArchiveEntryV1 implements FileEntry {
  readonly type = 'file';

  constructor(fd: number, metadata: EntryV1Metadata) {
    super(fd, metadata);
  }
}

class ScsArchiveDirectoryV1
  extends ScsArchiveEntryV1
  implements DirectoryEntry
{
  readonly type = 'directory';
  readonly subdirectories: readonly string[];
  readonly files: readonly string[];

  constructor(fd: number, metadata: EntryV1Metadata) {
    super(fd, metadata);

    const subdirectories: string[] = [];
    const files: string[] = [];
    for (const str of this.read()
      .toString()
      .split(/[\r\n]/)) {
      if (['', '\n', '\r'].includes(str)) {
        continue;
      }
      if (str.startsWith('*')) {
        subdirectories.push(str.substring(1));
      } else {
        files.push(str);
      }
    }
    this.subdirectories = subdirectories;
    this.files = files;
  }
}
