-- Harden the rls_auto_enable() event-trigger function.
--
-- public.rls_auto_enable() is the function behind the `ensure_rls` event
-- trigger that auto-enables RLS on every new public table (a good safety net).
-- It is SECURITY DEFINER, and the security advisor flagged that anon /
-- authenticated still hold EXECUTE on it (callable via /rest/v1/rpc). It isn't
-- exploitable for data access (it errors outside an event-trigger context), but
-- there's no reason to expose it — event triggers fire on their own, not via a
-- role's EXECUTE grant. Revoke it.
revoke execute on function public.rls_auto_enable() from public;
revoke execute on function public.rls_auto_enable() from anon;
revoke execute on function public.rls_auto_enable() from authenticated;
