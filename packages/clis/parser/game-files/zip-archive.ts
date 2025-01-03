import type { IZipEntry } from 'adm-zip';
import AdmZip from 'adm-zip';
import path from 'path';
import type { DirectoryEntry, Entries, FileEntry } from './scs-archive';
import { city64, createStore } from './scs-archive';

let directoryTree = new Map<string, DirectoryTree>();

export class ZipArchive {
  private readonly zip;
  public readonly path: string;
  private entries: Entries | undefined;

  constructor(path: string) {
    this.zip = new AdmZip(path);
    this.path = path;
  }

  isValid(): boolean {
    return true;
  }

  parseEntries(): Entries {
    if (this.entries) {
      return this.entries;
    }

    const entries = this.zip.getEntries();
    directoryTree = createDirectoryTree(entries);

    const directories: DirectoryEntry[] = [];
    const files: FileEntry[] = [];

    for (const entry of entries) {
      const zipEntry = createEntry(entry);
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

  dispose() {
    return;
  }
}

function createEntry(entry: IZipEntry): DirectoryEntry | FileEntry {
  return entry.isDirectory
    ? new ZipArchiveDirectory(entry)
    : new ZipArchiveFile(entry);
}

abstract class ZipArchiveEntry {
  abstract type: string;

  protected constructor(protected readonly entry: IZipEntry) {}

  get hash(): bigint {
    return city64(path.dirname(this.entry.entryName));
  }

  read() {
    return this.entry.getData();
  }
}

class ZipArchiveFile extends ZipArchiveEntry implements FileEntry {
  readonly type = 'file';

  constructor(entry: IZipEntry) {
    super(entry);
  }
}

class ZipArchiveDirectory extends ZipArchiveEntry implements DirectoryEntry {
  readonly type = 'directory';
  readonly subdirectories: readonly string[];
  readonly files: readonly string[];

  constructor(entry: IZipEntry) {
    super(entry);

    const parent = path.dirname(entry.entryName);
    if (directoryTree.has(parent)) {
      // eslint-disable-next-line
      // @ts-ignore
      this.subdirectories = directoryTree.get(parent).subdirectories;
    } else {
      this.subdirectories = [];
    }
    if (directoryTree.has(parent)) {
      // eslint-disable-next-line
      // @ts-ignore
      this.files = directoryTree.get(parent).files;
    } else {
      this.files = [];
    }
  }
}

function createDirectoryTree(entries: IZipEntry[]) {
  const directoryTree = new Map<string, DirectoryTree>();

  for (const entry of entries) {
    let parent = path.dirname(entry.entryName);
    const child = path.basename(entry.entryName);
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
    if (entry.isDirectory) {
      directoryTree.get(parent)?.subdirectories.push(child);
    } else {
      directoryTree.get(parent)?.files.push(child);
    }
  }

  return directoryTree;
}

class DirectoryTree {
  readonly subdirectories: string[] = [];
  readonly files: string[] = [];
}
