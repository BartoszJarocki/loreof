import { parseArgs } from 'node:util';
import { parseRepository } from '../src/server/github';
import { removeRepository } from '../src/server/storage';
import { removeWaitlistEmail } from '../src/server/waitlist';

const { values } = parseArgs({
  options: { remove: { type: 'string' }, email: { type: 'string' } },
});
if (Boolean(values.remove) === Boolean(values.email))
  throw new Error('Usage: tsx scripts/admin.ts --remove owner/name OR --email person@example.com');
if (values.remove) {
  await removeRepository(parseRepository(values.remove));
  process.stdout.write('Repository access is blocked and its stored data has been deleted.\n');
} else if (values.email) {
  await removeWaitlistEmail(values.email);
  process.stdout.write('The saved email signup has been deleted.\n');
}
