import { generateEntitlementKeyPair } from '../src/subscriptions/entitlement';

const { privateKeyHex, publicKeyHex } = generateEntitlementKeyPair();
console.log('# BACKEND environment (SECRET – never commit, never ship in the app):');
console.log(`ENTITLEMENT_PRIVATE_KEY=${privateKeyHex}`);
console.log('\n# DESKTOP  desktop/.env  (public, safe to ship):');
console.log(`VITE_ENTITLEMENT_PUBLIC_KEY=${publicKeyHex}`);
