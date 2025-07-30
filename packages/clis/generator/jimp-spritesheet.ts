import { Jimp } from 'jimp';
import path from 'path';
import { logger } from './logger';

interface SpriteLocation {
  x: number;
  y: number;
  width: number;
  height: number;
  pixelRatio: number;
}

interface SpritesheetResult {
  image: Buffer;
  coordinates: Record<string, SpriteLocation>;
}

export async function createSpritesheetWithJimp(
  pngPaths: string[],
  spacing = 2,
): Promise<SpritesheetResult> {
  logger.log('Reading', pngPaths.length, 'images...');

  // 读取所有图片
  const images = await Promise.all(
    pngPaths.map(async pngPath => {
      const image = await Jimp.read(pngPath);
      return {
        image,
        name: path.basename(pngPath, '.png'),
        path: pngPath,
      };
    }),
  );

  // 计算布局 - 使用网格布局优化空间
  const maxWidth = Math.max(...images.map(({ image }) => image.width));
  const maxHeight = Math.max(...images.map(({ image }) => image.height));

  // 计算网格尺寸
  const cols = Math.ceil(Math.sqrt(images.length));
  const rows = Math.ceil(images.length / cols);

  const sheetWidth = cols * (maxWidth + spacing) + spacing;
  const sheetHeight = rows * (maxHeight + spacing) + spacing;

  logger.log('Creating spritesheet:', sheetWidth, 'x', sheetHeight, 'pixels');

  // 创建透明画布
  const canvas = new Jimp({
    width: sheetWidth,
    height: sheetHeight,
    color: 0x00000000, // 透明背景
  });

  const coordinates: Record<string, SpriteLocation> = {};

  // 排列图片
  images.forEach(({ image, name }, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);

    const x = col * (maxWidth + spacing) + spacing;
    const y = row * (maxHeight + spacing) + spacing;

    // 居中放置图片
    const offsetX = Math.floor((maxWidth - image.width) / 2);
    const offsetY = Math.floor((maxHeight - image.height) / 2);

    canvas.composite(image, x + offsetX, y + offsetY);

    coordinates[name] = {
      x,
      y,
      width: maxWidth,
      height: maxHeight,
      pixelRatio: 2,
    };
  });

  // 转换为Buffer
  const buffer = await canvas.getBuffer('image/png');

  logger.log('Spritesheet generated successfully');
  return {
    image: buffer,
    coordinates,
  };
}
