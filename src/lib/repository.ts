import { PublicError } from './public-error';
import { repositorySlugSchema } from './schema';

const HINT = 'Enter a public GitHub repository URL or owner/name.';

// Only a URL form may carry a trailing path such as /tree/main. A bare owner/name stays strict,
// because Git redirects are checked by passing their bare path through here.
export function parseRepository(input: string): string {
  let value = input.trim();
  if (/^[a-z][a-z\d+.-]*:\/\/|^(www\.)?github\.com\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value.includes('://') ? value : `https://${value}`);
    } catch {
      throw new PublicError(HINT);
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !['github.com', 'www.github.com'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      throw new PublicError('Use a github.com repository URL.');
    value = url.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
  }
  value = value.replace(/\.git$/, '');
  const result = repositorySlugSchema.safeParse(value);
  if (!result.success || value.split('/').some((part) => part === '.' || part === '..'))
    throw new PublicError(HINT);
  return result.data.toLowerCase();
}
