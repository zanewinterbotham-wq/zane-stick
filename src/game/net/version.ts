// The build every player in a room must share: the host's simulation and the guests' replicas are the same code, and
// the game messages change between releases. The git commit the site was built from (vite.config.ts), so the GitHub
// Pages and Cloudflare copies of one release match; 'dev' in tests and builds outside git.
declare const __BUILD__: string | undefined;
export const BUILD: string = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
