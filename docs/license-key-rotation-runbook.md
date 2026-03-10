# Desktop Entitlement Key Rotation Runbook

This runbook describes safe RS256 verification key rotation for desktop entitlement tokens.

## Verification Config Artifact

Desktop verification keys are loaded from a managed config artifact:

- Dev-only path override (non-packaged builds): `LEADAE_LICENSE_PUBLIC_KEYS_CONFIG_PATH`
- Packaged/default path: `config/license-verification-keys.json`

Note: Packaged builds intentionally ignore `LEADAE_LICENSE_PUBLIC_KEYS_CONFIG_PATH` to prevent end-user keyset injection.

Schema:

- `defaultKid`: fallback key when token has no `kid`
- `keys.<kid>.publicKeyPem`: PEM encoded public key
- `keys.<kid>.status`: `active` or `deprecated`
- `keys.<kid>.acceptUntil`: ISO date/time cutoff for deprecated keys

Behavior:

- Active keys are always accepted.
- Deprecated keys are accepted until `acceptUntil`.
- Unknown `kid` values fail closed.

## Rollout Order (Server First)

1. **Generate new signing keypair** on entitlement server infrastructure.
2. **Publish desktop config artifact** containing:
   - old key = `deprecated` with `acceptUntil`
   - new key = `active`
3. **Deploy desktop update/config distribution** so clients know both keys.
4. **Switch server signer** to emit tokens with new `kid`.
5. **Observe overlap window** until most active clients refresh.
6. **Remove old key** from config after overlap expires.

## Desktop Config Update Order

- Always ship a config that contains **both old and new keys before** switching server signing key.
- If using staged release channels, wait for minimum adoption threshold before signer cutover.
- Keep overlap long enough to cover offline grace + update propagation.

## Rollback Behavior

### If new signer causes issues

- Server rollback: switch signing back to old `kid` immediately.
- Desktop behavior: still accepts old key during overlap (`deprecated` + `acceptUntil`).

### If desktop config rollout is bad

- Re-issue config artifact with:
  - prior stable `defaultKid`
  - prior stable active key set
- Keep server signer on currently trusted key until corrected config propagates.

### If overlap window expired too early

- Emergency fix: re-publish config with old key restored and new `acceptUntil`.
- Avoid permanently extending old key; use shortest safe emergency window and complete migration.
