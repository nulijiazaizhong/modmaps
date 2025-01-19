import { assert } from '@truckermudgeon/base/assert';
import { decompressDXT1, decompressDXT3, decompressDXT5 } from 'dxtn';
import { PNG } from 'pngjs';
import * as r from 'restructure';
import { decodeBC7 } from 'tex-decoder';
import { logger } from '../logger';
import { DXGI_FORMAT } from './enum-dds-format';

// https://learn.microsoft.com/en-us/windows/win32/direct3ddds/dx-graphics-dds-pguide
export const DdsHeader = new r.Struct({
  size: r.uint32le,
  flags: r.uint32le,
  height: r.uint32le,
  width: r.uint32le,
  pitchOrLinearSize: r.uint32le,
  depth: r.uint32le,
  mipMapCount: r.uint32le,
  reserved1: new r.Reserved(r.uint32le, 11),
  ddsPixelFormat: new r.Struct({
    size: r.uint32le,
    flags: r.uint32le,
    fourCc: new r.String(4),
    rgbBitCount: r.uint32le,
    rBitMask: r.uint32le,
    gBitMask: r.uint32le,
    bBitMask: r.uint32le,
    aBitMask: r.uint32le,
  }),
  caps: r.uint32le,
  caps2: r.uint32le,
  caps3: r.uint32le,
  caps4: r.uint32le,
  reserved2: new r.Reserved(r.uint32le, 1),
});

export const DdsHeaderDX10 = new r.Struct({
  dxgiFormat: r.uint32le,
  resourceDimension: r.uint32le,
  miscFlag: r.uint32le,
  arraySize: r.uint32le,
  miscFlags2: r.uint32le,
});

function toFormatFourCc(format: DXGI_FORMAT) {
  switch (format) {
    case DXGI_FORMAT.DXGI_FORMAT_BC1_TYPELESS:
    case DXGI_FORMAT.DXGI_FORMAT_BC1_UNORM:
    case DXGI_FORMAT.DXGI_FORMAT_BC1_UNORM_SRGB:
      return 'BC1';

    case DXGI_FORMAT.DXGI_FORMAT_BC2_TYPELESS:
    case DXGI_FORMAT.DXGI_FORMAT_BC2_UNORM:
    case DXGI_FORMAT.DXGI_FORMAT_BC2_UNORM_SRGB:
      return 'BC2';

    case DXGI_FORMAT.DXGI_FORMAT_BC3_TYPELESS:
    case DXGI_FORMAT.DXGI_FORMAT_BC3_UNORM:
    case DXGI_FORMAT.DXGI_FORMAT_BC3_UNORM_SRGB:
      return 'BC3';

    case DXGI_FORMAT.DXGI_FORMAT_BC7_TYPELESS:
    case DXGI_FORMAT.DXGI_FORMAT_BC7_UNORM:
    case DXGI_FORMAT.DXGI_FORMAT_BC7_UNORM_SRGB:
      return 'BC7';

    case DXGI_FORMAT.DXGI_FORMAT_B8G8R8A8_TYPELESS:
    case DXGI_FORMAT.DXGI_FORMAT_B8G8R8A8_UNORM:
    case DXGI_FORMAT.DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
    case DXGI_FORMAT.DXGI_FORMAT_B8G8R8X8_TYPELESS:
    case DXGI_FORMAT.DXGI_FORMAT_B8G8R8X8_UNORM:
    case DXGI_FORMAT.DXGI_FORMAT_B8G8R8X8_UNORM_SRGB:
      return 'BGRA8';

    default:
      return 'unknown';
  }
}

assert(DdsHeader.size() === 124);

export function parseDds(
  buffer: Buffer,
  sdfData: number[][] | undefined,
): Buffer | false {
  const magic = buffer.toString('utf8', 0, 4);
  if (magic !== 'DDS ') {
    logger.error("doesn't look like a .dds file");
    return false;
  }
  const header = DdsHeader.fromBuffer(buffer.subarray(4, 128));
  if (header.size !== 124) {
    logger.error('invalid .dds file length', header.size);
    return false;
  }
  let headerDX10: r.BaseOf<typeof DdsHeaderDX10>;
  let data: Buffer;
  if (header.ddsPixelFormat.fourCc === 'DX10') {
    headerDX10 = DdsHeaderDX10.fromBuffer(buffer.subarray(128, 148));
    header.ddsPixelFormat.fourCc = toFormatFourCc(headerDX10.dxgiFormat);
    data = buffer.subarray(148);
  } else {
    data = buffer.subarray(128);
  }

  const png = new PNG({
    width: header.width,
    height: header.height,
  });

  if (header.ddsPixelFormat.flags === 0x4) {
    // DDPF_FOURCC: Texture contains compressed RGB data; FourCC contains valid data.
    switch (header.ddsPixelFormat.fourCc) {
      case 'DXT1':
      case 'BC1':
        data = data.subarray(0, (header.width * header.height) / 2);
        png.data = decompressDXT1(header.width, header.height, data) as Buffer;
        break;

      case 'DXT3':
      case 'BC2':
        data = data.subarray(0, header.width * header.height);
        png.data = decompressDXT3(header.width, header.height, data) as Buffer;
        break;

      case 'DXT5':
      case 'BC3':
        data = data.subarray(0, header.width * header.height);
        png.data = decompressDXT5(header.width, header.height, data) as Buffer;
        break;

      case 'BC7':
        png.data = decodeBC7(data, header.width, header.height) as Buffer;
        break;

      case 'BGRA8':
        png.data = processUncompressedBGRA(
          data,
          header.width,
          header.height,
          sdfData,
        );
        break;

      case 'unknown':
        // eslint-disable-next-line
        // @ts-ignore
        logger.error('unsupported pixel format', headerDX10.dxgiFormat);
        return false;

      default:
        logger.error('unsupported pixel format', header.ddsPixelFormat.fourCc);
        return false;
    }
  } else if (header.ddsPixelFormat.flags === 0x40 + 0x1) {
    // DDPF_RGB+DDPF_ALPHAPIXELS: Texture contains uncompressed RGB data; dwRGBBitCount and the RGBA masks (dwRBitMask, dwGBitMask, dwBBitMask, dwABitMask) contain valid data.
    png.data = processUncompressedBGRA(
      data,
      header.width,
      header.height,
      sdfData,
    );
  } else {
    logger.error('unsupported format flag', header.ddsPixelFormat.flags);
    return false;
  }

  return PNG.sync.write(png);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(v, max));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  x = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return x * x * (3 - 2 * x);
}

function processUncompressedBGRA(
  rgba: Buffer,
  width: number,
  height: number,
  sdfData: number[][] | undefined,
) {
  // fudge widths/heights. seems to fix problem with ETS2's sr_e763 icon.
  width = closestPowerOf2(width);
  height = closestPowerOf2(height);

  const Bytes = Buffer.alloc(4 * width * height);
  // Is there a nicer way to figure out pitch?
  const factor = Math.ceil(rgba.length / Bytes.length);
  for (let i = 0; i < height; i++) {
    if (i * 4 * width * factor > rgba.length) {
      // some image data seems to be incomplete, or pitch is
      // incorrect. abort copying of image data instead of erroring out.
      break;
    }
    rgba.copy(
      Bytes,
      i * 4 * width,
      i * 4 * width * factor,
      (i + 1) * 4 * width * factor,
    );
  }

  // swap B and R because `png.data` expects RGBA data.
  for (let i = 0; i < Bytes.length; i += 4) {
    const b = Bytes[i];
    Bytes[i] = Bytes[i + 2]; // b = r
    Bytes[i + 2] = b; // r = b
  }

  // TODO consider taking advantage of SDF and generate 2x larger PNGs.
  if (sdfData) {
    // not sure what the 0-th index is... dimensions + padding?
    const [, rColor, gColor, bColor, aColor] = sdfData;
    const smoothness = 0.1;
    const calcColor = (dist: number, rgba: number[]) => {
      return rgba.map(c => {
        const smoothed =
          smoothstep(0.5 - smoothness, 0.5 + smoothness, dist / 255) * 255;
        const gammaCorrected = clamp(Math.pow(c, 1 / 2.2), 0, 1);
        return smoothed * gammaCorrected;
      });
    };
    for (let i = 0; i < Bytes.length; i += 4) {
      const r = Bytes[i];
      const g = Bytes[i + 1];
      const b = Bytes[i + 2];
      const a = Bytes[i + 3];

      const [r1, g1, b1, a1] = calcColor(r, rColor);
      const [r2, g2, b2, a2] = calcColor(g, gColor);
      const [r3, g3, b3, a3] = calcColor(b, bColor);
      const [r4, g4, b4, a4] = calcColor(a, aColor);

      Bytes[i] = clamp(r1 + r2 + r3 + r4, 0, 255);
      Bytes[i + 1] = clamp(g1 + g2 + g3 + g4, 0, 255);
      Bytes[i + 2] = clamp(b1 + b2 + b3 + b4, 0, 255);
      Bytes[i + 3] = clamp(a1 + a2 + a3 + a4, 0, 255);
    }
  }
  return Bytes;
}

function closestPowerOf2(n: number): number {
  const lg = Math.floor(Math.log2(n));
  return Math.pow(2, lg);
}
