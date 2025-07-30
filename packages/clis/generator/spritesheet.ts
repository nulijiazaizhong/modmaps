import type { Poi } from '@truckermudgeon/map/types';
import fs from 'fs';
import type { JimpInstance } from 'jimp';
import { Jimp } from 'jimp';
import * as os from 'node:os';
import path from 'path';
import { createSpritesheetWithJimp } from './jimp-spritesheet';
import { logger } from './logger';

interface SpriteLocation {
  x: number;
  y: number;
  width: number;
  height: number;
  pixelRatio: number;
}

export async function createSpritesheet(
  pois: readonly Poi[],
  inputDir: string,
  resourcesDir: string,
) {
  // Notes:
  //   'dot.png' is a manually-created 20x20 off-white dot outlined in off-black
  //   'dotdot.png' is the above, but with a dot in the middle.
  const resourcesPaths = [
    path.join(resourcesDir, 'dot.png'),
    path.join(resourcesDir, 'dotdot.png'),
  ];
  const poiPngPaths = [...new Set(pois.map(o => o.icon))].map(name =>
    path.join(inputDir, 'icons', name + '.png'),
  );
  const origPngs = [...resourcesPaths, ...poiPngPaths];
  const missingPngs = origPngs.filter(p => !fs.existsSync(p));
  if (missingPngs.length) {
    logger.error('missing png files', missingPngs);
    throw new Error();
  }

  logger.log('preprocessing', origPngs.length, 'pngs...');
  const { allPngs, preprocessedPngs } = await preprocessPngs(origPngs);
  logger.log('arranging sprites...');
  const result = await createSpritesheetWithJimp(allPngs);
  preprocessedPngs.forEach(png => fs.rmSync(png));
  return result;
}

async function preprocessPngs(pngPaths: string[]): Promise<{
  allPngs: string[];
  preprocessedPngs: string[];
}> {
  const allPngs: string[] = [];
  const preprocessedPngs: string[] = [];

  const shrank = new Set<string>();
  const bordered = new Set<string>();
  await Promise.all(
    pngPaths.map(async pngPath => {
      const image: JimpInstance = (await Jimp.read(pngPath)) as JimpInstance;
      const basename = path.basename(pngPath);
      let modified = false;
      const probablyRoadShield =
        image.width === image.height && image.width >= 64;
      // probably an over-sized road shield, like the colorado ones.
      if (probablyRoadShield && image.width > 64) {
        image.resize({ w: 64, h: 64 });
        shrank.add(basename.replace('.png', ''));
        modified = true;
      }
      if (probablyRoadShield && isProbablyWhiteFill(image.bitmap)) {
        addBorder(image);
        bordered.add(basename.replace('.png', ''));
        modified = true;
      }

      if (modified) {
        const tmpFilePath = path.join(os.tmpdir(), basename);
        await image.write(tmpFilePath as `${string}.png`);
        allPngs.push(tmpFilePath);
        preprocessedPngs.push(tmpFilePath);
      } else {
        allPngs.push(pngPath);
      }
    }),
  );
  if (shrank.size) {
    logger.info(shrank.size, 'pngs shrank:', [...shrank].sort().join(' '));
  }
  if (bordered.size) {
    logger.info(
      bordered.size,
      'pngs bordered:',
      [...bordered].sort().join(' '),
    );
  }

  return {
    allPngs,
    preprocessedPngs,
  };
}

function isProbablyWhiteFill({
  data,
  width,
  height,
}: {
  data: Buffer;
  width: number;
  height: number;
}) {
  const bytesPerRow = width * 4;
  const midX = Math.round(width / 2) * 4;

  // extract the center vertical line of `bitmap`'s _non-transparent_ pixels.
  const verticalCenterLinePixels = [];
  for (let i = 0; i < height; i++) {
    const pixel = data.readUint32BE(i * bytesPerRow + midX);
    if ((pixel & 0xff) === 0xff) {
      verticalCenterLinePixels.push(pixel);
    }
  }
  // an image probably has a white fill if the 4 pixels at either end of the
  // vertical line are all white.
  return (
    verticalCenterLinePixels.slice(0, 4).every(pixel => pixel === 0xffffffff) ||
    verticalCenterLinePixels.slice(0, -4).every(pixel => pixel === 0xffffffff)
  );
}

function addBorder(image: JimpInstance) {
  const original = image.clone();
  const mask = image.clone();

  // create a black mask by blacking out all of `image`'s pixels...
  mask.scan(
    0,
    0,
    mask.bitmap.width,
    mask.bitmap.height,
    (_x: number, _y: number, i: number) => {
      mask.bitmap.data[i] = 0x00;
      mask.bitmap.data[i + 1] = 0x00;
      mask.bitmap.data[i + 2] = 0x00;
    },
  );
  // ...and "expand" it by blitting it in a one-pixel ring around its origin
  // (this yields better results than simply enlarging it by 1-2 pixels).
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      image.composite(mask, x, y);
    }
  }

  // slightly shrink the original image...
  original.resize({ w: image.width - 2, h: image.height - 2 });
  // ...and blit it on top of the mask.
  image.composite(original, 1, 1);
}
