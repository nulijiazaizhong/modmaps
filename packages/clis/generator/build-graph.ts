import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { maybeEnsureOutputDir, untildify } from './commands/path-helpers';
import { checkGraph } from './graph/check-graph';
import { toDemoGraph } from './graph/demo-graph';
import { generateGraph } from './graph/graph';
import { logger } from './logger';
import { readMapData } from './mapped-data';

async function main() {
  const args = yargs(hideBin(process.argv))
    .option('map', {
      alias: 'm',
      describe: 'Source map. Can only specify one.',
      choices: ['usa', 'europe'] as const,
      default: 'usa' as 'usa' | 'europe',
      defaultDescription: 'usa',
    })
    .option('inputDir', {
      alias: 'i',
      describe: 'Path to dir containing parser-generated JSON files',
      type: 'string',
      coerce: untildify,
      demandOption: true,
    })
    .option('outputDir', {
      alias: 'o',
      describe: 'Path to dir graph.json file should be written to',
      type: 'string',
      coerce: untildify,
      demandOption: true,
    })
    .option('check', {
      alias: 'c',
      describe: 'Run a simple validity check on the generated graph',
      type: 'boolean',
      default: false,
    })
    .option('demo', {
      alias: 'd',
      describe: 'Output a graph.json tailored for the demo-app',
      type: 'boolean',
      default: false,
    })
    .option('dryRun', {
      describe: "Don't write out any files.",
      type: 'boolean',
      default: false,
    })
    .check(maybeEnsureOutputDir)
    .check(argv => {
      if (Array.isArray(argv.map)) {
        throw new Error('Only one "map" option can be specified.');
      }
      return true;
    })
    .parseSync();

  const tsMapData = readMapData(args.inputDir, args.map, {
    mapDataKeys: [
      'nodes',
      'roads',
      'roadLooks',
      'prefabs',
      'prefabDescriptions',
      'companies',
      'ferries',
      'cities',
      'countries',
      'companyDefs',
      'achievements',
      'trajectories',
      'triggers',
      'cutscenes',
      'routes',
      'mileageTargets',
      'pois',
      'elevation',
      'mapAreas',
      'dividers',
      'models',
      'modelDescriptions',
    ],
    includeHiddenRoadsAndPrefabs: false,
  });

  const graph = generateGraph(tsMapData);
  if (args.check) {
    await checkGraph(graph, tsMapData);
  }

  if (!args.dryRun) {
    if (args.demo) {
      fs.writeFileSync(
        path.join(args.outputDir, `${args.map}-graph-demo.json`),
        JSON.stringify(toDemoGraph(graph, tsMapData)),
      );
    } else {
      fs.writeFileSync(
        path.join(args.outputDir, `${args.map}-graph.json`),
        JSON.stringify([...graph.entries()], null, 2),
      );
    }
  }
  logger.success('done.');
}

await main();
