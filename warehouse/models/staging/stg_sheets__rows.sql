with events as (
    -- received_at is raw's own ingest clock: a timestamptz column the door defaults to
    -- now() at insert. Selected INTO the ordering deliberately — no cast needed, it is
    -- already typed at the source (unlike occurred_at, which rides in the payload as
    -- text and is cast below).
    select event_id, event_type, payload, received_at from raw.raw_events
    where source = 'sheets' and event_type in ('sheet.row_upserted', 'sheet.row_deleted')
),
latest as (
    -- SUCCESSOR ordering (plan §3.1) — sheets is the FIRST model born in the successor
    -- world: occurred_at desc, received_at desc, event_id desc.
    --   * occurred_at is the connector's DETECTION clock (payload occurred_at_derived):
    --     ms grain, one stamp per catchUp cycle — rapid cycles CAN tie (carried
    --     landmine 1);
    --   * received_at breaks that tie toward the LATER INGEST: the door's insert clock,
    --     so re-detections across same-millisecond cycles resolve deterministically to
    --     the cycle that landed last;
    --   * event_id desc is the last-resort deterministic tiebreak. Sheet ids are
    --     content-addressed (`sheet-<rowKey>-<hash>[-rN]`) so this order is arbitrary-
    --     looking but stable; the -rN supersession salt sorts after its base id (an ABA
    --     revert wins a full tie against its original), and two -rN siblings compare
    --     only when they carry the SAME content, where either order yields identical
    --     output.
    -- The 2a models' evt-N ordinal tiebreak is deliberately NOT copied: these ids carry
    -- no ordinal, and (substring(event_id from 5))::bigint would not even parse them.
    select distinct on (payload -> 'data' ->> 'row_key')
        payload -> 'data' as row_data,
        event_type,
        ((payload ->> 'occurred_at')::timestamptz) as detected_at,
        received_at
    from events
    order by payload -> 'data' ->> 'row_key',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             received_at desc,
             event_id desc
)
select
    row_data ->> 'row_key' as row_key,
    -- The connector's canonical field names (sheet-canonical.ts CanonicalField) become
    -- the staging vocabulary: email → client_email, company → company_name, deal →
    -- label. `label` because a sheet's "Deal" cell is a free-text human label, not a
    -- deal ENTITY — it has no id and must never join or fold into stg_crm__deals.
    row_data ->> 'email'       as client_email,
    row_data ->> 'client_name' as client_name,
    row_data ->> 'company'     as company_name,
    -- L2 safe cast: amount_cents is already typed by the connector, but raw rows that
    -- never passed the ingest door (legacy, direct inserts, historical backfill) must
    -- degrade to NULL, not kill the whole build. The ingest contract
    -- (ingest/src/numeric-contract.ts) is the enforcement; this is blast-radius
    -- containment. NULLs stay visible for downstream surfacing, never erased or guessed.
    case when pg_input_is_valid(row_data ->> 'amount_cents', 'bigint')
         then (row_data ->> 'amount_cents')::bigint end as amount_cents,
    -- L5: currency is carried, not discarded — the mart refuses to sum across
    -- currencies. Same ^[A-Z]{3}$-or-NULL guard as invoices/deals: anything else becomes
    -- NULL ("unknown" — counted by the mart and REFUSED from its labeled totals).
    case when (row_data ->> 'currency') ~ '^[A-Z]{3}$'
         then row_data ->> 'currency' end as currency,
    row_data ->> 'status'       as status,
    row_data ->> 'deal'         as label,
    row_data ->> 'content_hash' as content_hash,
    -- The manufactured sheets CLIENT id, minted once here (a sheet has no client entity
    -- id of its own): usable email → 'email:' || lower(trim(email)); no usable email →
    -- 'row:' || row_key (each keyless row stays its own manual-review entity — never
    -- guessed into a merge). The prefixes keep the two id families collision-free.
    -- identity_resolution's sheets arm and customer_360's sheets join both key on THIS
    -- column, so the derivation cannot drift between them.
    case when nullif(trim(row_data ->> 'email'), '') is not null
         then 'email:' || lower(trim(row_data ->> 'email'))
         else 'row:' || (row_data ->> 'row_key') end as client_key,
    -- Recency of the winning event, exposed for identity's latest-evidence pick (one
    -- candidate tuple per client needs a deterministic "latest row" across row_keys):
    -- detected_at = the winning event's occurred_at (the detection clock), received_at =
    -- its ingest clock. Ordering surface only — not consumer columns.
    detected_at,
    received_at
from latest
-- Tombstone as FILTER, not flag: a row whose latest event is sheet.row_deleted is
-- REMOVED from the model's output, matching how the mart consumes (row_key at
-- latest-state must stay unique + present-means-live).
where event_type = 'sheet.row_upserted'
