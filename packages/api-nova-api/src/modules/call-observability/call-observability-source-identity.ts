import { constants, promises as fs, Stats } from 'fs';
import type { FileHandle } from 'fs/promises';

const regular = (stat: Stats): boolean => stat.isFile() && !stat.isSymbolicLink() &&
  stat.nlink === 1 && Number.isInteger(stat.ino) && stat.ino > 0 &&
  Number.isFinite(stat.birthtimeMs);
const sameObject = (left: Stats, right: Stats): boolean =>
  left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;

/** Preserve handle-based checkpoint identity when Windows path stat omits the volume id. */
export async function matchesOpenedSource(file: string, expected: Stats, opened: Stats,
  platform: NodeJS.Platform = process.platform, openedHandle?: FileHandle): Promise<boolean> {
  if (!regular(expected) || !regular(opened) || !sameObject(expected, opened)) return false;
  const exactNumbers = Number.isSafeInteger(opened.ino) && Number.isSafeInteger(expected.ino);
  if (expected.dev === opened.dev && exactNumbers) return true;
  if (expected.dev !== opened.dev &&
    (platform !== 'win32' || expected.dev !== 0 || opened.dev === 0)) return false;
  if (!exactNumbers && !openedHandle) return false;

  // A missing path device id is not sufficient evidence. Compare two real handles,
  // then recheck the path to reject replacement, links and changed inode identity.
  const confirmation = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!exactNumbers) {
      const original = await openedHandle!.stat({ bigint: true });
      const confirmed = await confirmation.stat({ bigint: true });
      const current = await fs.lstat(file, { bigint: true });
      const safe = (s: typeof original) => s.isFile() && !s.isSymbolicLink() && s.nlink === BigInt(1);
      return safe(original) && safe(confirmed) && safe(current) && original.ino > BigInt(0) &&
        original.ino === confirmed.ino && original.ino === current.ino &&
        original.birthtimeNs === confirmed.birthtimeNs && original.birthtimeNs === current.birthtimeNs &&
        original.dev === confirmed.dev && (original.dev === current.dev ||
          (platform === 'win32' && current.dev === BigInt(0)));
    }
    const confirmed = await confirmation.stat();
    const current = await fs.lstat(file);
    return regular(confirmed) && regular(current) && sameObject(confirmed, opened) &&
      confirmed.dev === opened.dev && sameObject(current, opened) &&
      (current.dev === 0 || current.dev === opened.dev);
  } finally {
    await confirmation.close();
  }
}
