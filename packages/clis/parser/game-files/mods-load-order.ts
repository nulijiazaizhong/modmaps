import fs from 'fs';

export function getLoadOrder() {
  const LogFile = 'D:\\我的文档\\Euro Truck Simulator 2\\game.log.txt';
  const strs = fs.readFileSync(LogFile, { encoding: 'utf8' });
  const mods: string[] = [];
  const reg = new RegExp('.*\\[mods\\] Active local mod (.*) \\(name:.*', 'i');

  for (const str of strs.split('\n')) {
    if (reg.test(str)) {
      const mod = reg.exec(str)?.[1];
      if (mod) {
        mods.push(mod);
      }
    }
  }
  return mods;
}
