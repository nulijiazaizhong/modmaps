#!/usr/bin/env -S NODE_OPTIONS=--max-old-space-size=8192 npx tsx

import type { DefData, MapData } from '@truckermudgeon/map/types';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as process from 'process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { parseMapFiles } from './game-files/map-files-parser';
import { getLoadOrder } from './game-files/mods-load-order';
import { logger } from './logger';

const homeDirectory = os.homedir();
const untildify = (path: string) =>
  homeDirectory ? path.replace(/^~(?=$|\/|\\)/, homeDirectory) : path;

function main() {
  const args = yargs(hideBin(process.argv))
    .usage(
      'Parses ATS/ETS2 game data and mods data and outputs map JSON and PNG files.\n',
    )
    .usage('Usage: $0 -g <dir> -m <dir> -o <dir>')
    .option('gameDir', {
      alias: 'g',
      describe: 'Path to ATS/ETS2 game dir (the one with all the .scs files)',
      type: 'string',
      coerce: untildify,
      demandOption: true,
    })
    .option('modsDir', {
      alias: 'm',
      describe: 'Path to ATS/ETS2 mods dir (the one with all the mods files)',
      type: 'string',
      coerce: untildify,
    })
    .option('outputDir', {
      alias: 'o',
      describe: 'Path to dir JSON and PNG files should be written to',
      type: 'string',
      coerce: untildify,
      demandOption: true,
    })
    .option('includeDlc', {
      describe: 'Include DLC files',
      type: 'boolean',
      default: true,
    })
    .option('onlyDefs', {
      describe: 'Parse data from /def files, only',
      type: 'boolean',
      default: false,
    })
    .option('dryRun', {
      describe: "Don't write out any files",
      type: 'boolean',
      default: false,
    })
    .parseSync();

  const requiredFiles = new Set([
    'base.scs',
    'base_map.scs',
    'base_share.scs',
    'core.scs',
    'def.scs',
    'locale.scs',
    'version.scs',
  ]);
  const scsFilePaths = fs
    .readdirSync(args.gameDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.scs'))
    .map(e => {
      return path.join(args.gameDir, e.name);
    })
    .filter(p => {
      const fn = path.basename(p);
      return requiredFiles.has(fn) || (args.includeDlc && fn.startsWith('dlc'));
    });

  if (args.modsDir) {
    const loadOrder = getLoadOrder();

    const modsFilePaths = fs
      .readdirSync(args.modsDir, { withFileTypes: true })
      .filter(
        e =>
          e.isFile() &&
          (e.name.endsWith('.scs') || e.name.endsWith('.zip')) &&
          loadOrder.includes(
            path.basename(e.name).split(path.extname(e.name))[0],
          ),
      )
      .map(e => path.join(args.modsDir!, e.name))
      .sort(
        (a, b) =>
          loadOrder.indexOf(path.basename(a).split(path.extname(a))[0]) -
          loadOrder.indexOf(path.basename(b).split(path.extname(b))[0]),
      );

    scsFilePaths.push(...modsFilePaths);
  }

  const { map, ...result } = parseMapFiles(scsFilePaths, args);
  if (args.dryRun) {
    logger.success('dry run complete.');
    return;
  }

  if (!fs.existsSync(args.outputDir)) {
    fs.mkdirSync(args.outputDir, { recursive: true });
  }

  const data = result.onlyDefs ? result.defData : result.mapData;
  for (const key of Object.keys(data)) {
    const collection = data[key as keyof (MapData | DefData)];
    const filename = `${map}-${key}.json`;
    logger.log('writing', collection.length, `entries to ${filename}...`);
    fs.writeFileSync(
      path.join(args.outputDir, filename),
      JSON.stringify(collection, null, 2),
    );
  }

  // const pngOutputDir = path.join(args.outputDir, 'icons');
  // if (!result.onlyDefs) {
  //   const { icons } = result;
  //   logger.log('writing', icons.size, `.png files to ${pngOutputDir}...`);
  //   if (!fs.existsSync(pngOutputDir)) {
  //     fs.mkdirSync(pngOutputDir);
  //   }
  //   for (const [name, buffer] of icons) {
  //     fs.writeFileSync(path.join(pngOutputDir, name + '.png'), buffer);
  //   }
  // }

  logger.success('done.');
}

// Ensure `BigInt`s are `JSON.serialize`d as hex strings, so they can be
// `JSON.parse`d without any data loss.
//
// Do this before calling `main()` (or executing any other code that might
// involve serializing bigints to JSON).

// eslint-disable-next-line
interface BigIntWithToJSON extends BigInt {
  toJSON(): string;
}

(BigInt.prototype as BigIntWithToJSON).toJSON = function () {
  return this.toString(16);
};

main();
