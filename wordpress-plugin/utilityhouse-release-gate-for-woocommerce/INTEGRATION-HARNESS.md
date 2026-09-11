# Real WordPress + WooCommerce integration harness

This disposable Docker harness installs current WordPress and WooCommerce,
mounts the production plugin, and runs the same assertions with HPOS enabled
and disabled. Each pass uses a fresh database volume.

Run it from the service directory:

```bash
npm run test:wordpress
```

It verifies:

1. activation stores no credential and the daily collector is inert;
2. a real published Woo product becomes only `PASS/count=1`;
3. saved ownership and evidence keys never render back into the admin page;
4. the real `parse_request` contract serves both well-known routes and the
   ownership proof uses the configured per-store key;
5. the HTTP evidence envelope contains only the aggregate check and its
   signature, never product, shopper, order, payment, address, or credentials;
6. invalid identifiers and keys fail closed; and
7. uninstall removes all UtilityHouse Release Gate options and the scheduled event.

The test endpoint is intercepted inside WordPress; this harness performs no
production write and no payment or settlement action. A separate owned-store
production E2E is still required to prove the public Worker path.
