import fs from 'fs';

export function getLoadOrder(path: string) {
  const strs = fs.readFileSync(path, { encoding: 'utf8' });
  const mods: string[] = [];
  const reg = new RegExp('.*\\[mods] Active local mod (.*) \\(name:.*', 'i');

  for (const str of strs.split('\n')) {
    if (reg.test(str)) {
      const mod = reg.exec(str)?.[1];
      if (mod && !mods.includes(mod)) {
        mods.push(mod);
      }
    }
  }
  return mods;
}
