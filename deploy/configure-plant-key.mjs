import { readFile, writeFile, rename, stat, chown } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const path = '/task-secrets/credentials.json';
const previous = await stat(path), data = JSON.parse(await readFile(path, 'utf8'));
if (data.DTIS_PLANT_ENCRYPTION_KEY) {
  const decoded = Buffer.from(data.DTIS_PLANT_ENCRYPTION_KEY, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== data.DTIS_PLANT_ENCRYPTION_KEY) throw new Error('Existing plant key is invalid; do not replace it automatically');
  console.log('Existing plant encryption key preserved');
} else {
  data.DTIS_PLANT_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  const temporary = `${path}.plant-key.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: previous.mode & 0o777, flag: 'wx' });
  await chown(temporary, previous.uid, previous.gid);
  await rename(temporary, path);
  console.log('Plant encryption key added; existing credentials unchanged');
}
