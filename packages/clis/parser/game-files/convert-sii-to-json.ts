import type { JSONSchemaType } from 'ajv';
import { logger } from '../logger';
import type { Entries, FileEntry } from './scs-archive';
import { parseSii } from './sii-parser';
import { ajv } from './sii-schemas';
import { jsonConverter } from './sii-visitors';

export function convertSiiToJson<T>(
  siiPath: string,
  entries: Entries,
  schema: JSONSchemaType<T>,
  siiFile: FileEntry | undefined = undefined,
): T {
  siiFile = siiFile ? siiFile : entries.files.get(siiPath);
  if (!siiFile) return false as T;

  const buffer = siiFile.read();
  let sii = decryptedSii(buffer);

  if (sii.length < 10) {
    return false as T;
  }

  // HACK localization.sui files just contain unwrapped properties, e.g.:
  //   key[]: foo
  //   val[]: bar
  // Hardcode a wrapper so parsing still works.
  if (
    siiPath.includes('localization.sui') ||
    siiPath.includes('photoalbum.sui')
  ) {
    sii = `localizationDb : .localization {${sii}}`;
  }

  try {
    const res = parseSii(sii);
    if (!res.ok) {
      logger.error('error parsing', siiPath);
      if (res.parseErrors.length) {
        const line = res.parseErrors[0].token.startLine!;
        const lines = sii.split('\n');
        logger.debug(lines.slice(line - 1, line + 1).join('\n'));
        logger.debug(res.parseErrors);
      } else {
        logger.debug(res.lexErrors);
      }
      return false as T;
    }

    const json = jsonConverter.convert(res.cst);
    if (Object.keys(json).length === 0) return false as T;

    const validate = ajv.compile(schema);
    if (validate(json)) {
      return json;
    }
    logger.debug('error validating', siiPath);
    logger.debug(JSON.stringify(json, null, 2));
    logger.debug(ajv.errorsText(validate.errors));
    return false as T;
  } catch (e) {
    logger.error('error parsing', sii, e);
    return false as T;
  }
}

export function decryptedSii(buffer: Buffer) {
  // Some .sii files (like locale files) may be 3nk-encrypted.
  let sii;
  const magic = buffer.toString('utf8', 0, 3);
  if (magic === '3nK') {
    // https://github.com/dariowouters/ts-map/blob/e73adad923f60bbbb637dd4642910d1a0b1154e3/TsMap/Helpers/MemoryHelper.cs#L109
    if (buffer.length < 5) {
      return '';
    }
    let key = buffer.readUint8(5);
    for (let i = 6; i < buffer.length; i++) {
      buffer[i] = (((key << 2) ^ (key ^ 0xff)) << 3) ^ key ^ buffer[i];
      key++;
    }
    sii = buffer.toString('utf8', 6);
  } else {
    sii = buffer.toString();
  }
  return sii;
}
