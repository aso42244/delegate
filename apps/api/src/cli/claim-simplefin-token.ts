/**
 * Exchanges a SimpleFIN setup token for the long-lived access URL.
 *
 *   npm run simplefin:claim -- <setup-token>
 *
 * A setup token can be claimed exactly once; claiming again returns 403 and a
 * fresh token is needed. The resulting access URL embeds Basic Auth credentials
 * and is a bearer credential for the household's bank data, so this prints it
 * for the owner to paste into `.env` and deliberately does not write it
 * anywhere itself.
 */

import { claimSetupToken } from '../simplefin/client.js';

const [setupToken] = process.argv.slice(2);

if (!setupToken) {
  console.error('Usage: npm run simplefin:claim -- <setup-token>');
  console.error(
    'Get a setup token from https://bridge.simplefin.org/ after connecting an institution.',
  );
  process.exit(1);
}

try {
  const accessUrl = await claimSetupToken(setupToken);

  console.log('\nClaimed. Put this line in your .env file:\n');
  console.log(`SIMPLEFIN_ACCESS_URL="${accessUrl}"`);
  console.log(
    '\nTreat it like a password: it grants read access to your accounts.' +
      '\n.env is git-ignored, so it will not be committed.\n',
  );
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
