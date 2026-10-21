import { z } from 'zod';

// Configure before constructing browser schemas: even Zod's eval capability
// probe triggers a CSP violation when production forbids unsafe-eval.
z.config({ jitless: true });

export { z };
