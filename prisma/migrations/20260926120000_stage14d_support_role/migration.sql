-- Stage 14D — admin/support authorization foundation.
-- Adds the SUPPORT role to UserRole. Additive only:
--   * no column is dropped or retyped;
--   * NO user is backfilled into SUPPORT (granting the role is an explicit
--     operational act, like the support roster itself);
--   * existing supportRosterMember data is untouched and stays intact.
-- Fail-closed by construction: with no SUPPORT users, nobody gains access.
ALTER TYPE "UserRole" ADD VALUE 'SUPPORT';
