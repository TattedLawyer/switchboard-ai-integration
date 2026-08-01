-- Re-sourced (F-1c): the billing arm stages from the stripefeed envelope feed. The
-- connector's door mapping puts the envelope's data.object VERBATIM under payload.data,
-- and customer objects ride the shared universe's records as-is (id/name/domain/email —
-- the F-1 recon's id-mapping good news, verified by the staging-flip pins), so the
-- column surface is unchanged. Successor ordering as everywhere (see
-- stg_crm__companies.sql for the cast rationale).
with events as (
    select event_id, payload, received_at from raw.raw_events
    where source = 'stripefeed' and event_type = 'customer.created'
),
latest as (
    select distinct on (payload -> 'data' ->> 'id') payload -> 'data' as customer
    from events
    order by payload -> 'data' ->> 'id',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             received_at desc,
             event_id desc
)
select
    customer ->> 'id'     as customer_id,
    customer ->> 'name'   as name,
    customer ->> 'domain' as domain,
    customer ->> 'email'  as email
from latest
